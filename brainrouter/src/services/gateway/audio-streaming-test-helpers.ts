/**
 * Shared transport harness for ADR-035 gateway audio contract tests.
 *
 * The concern suites deliberately exercise real HTTP and WebSocket boundaries.
 * This module keeps their server, socket, fake-adapter, and binary-frame setup
 * identical while leaving each contract assertion in its owning test file.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, vi } from "vitest";
import { WebSocket } from "ws";

import { GatewayAuthError, MODEL_INVOKE_SCOPE } from "./auth.js";
import type { GatewayAudioStreamingController, GatewayAudioStreamingOptions } from "./audio-streaming-server.js";
import {
  GATEWAY_AUDIO_STREAM_PATH,
  type GatewayAudioStreamHandlers,
  type GatewayAudioStreamOpenInput,
  type GatewayAudioStreamOwner,
  type GatewayAudioStreamSession,
  type GatewayAudioStreamingPort,
} from "./audio-streaming-protocol.js";
import { bindGatewayDataPlane, createGatewayServer, type GatewayHttpService } from "./server.js";

export const FULL_CAPABILITIES = {
  schemaVersion: 1,
  segmentedUpload: true,
  streaming: {
    persistent: true,
    partialResults: true,
    serverBoundaries: true,
    coverageCheckpoints: true,
    resumable: true,
    latencyModes: ["low-latency", "balanced", "high-accuracy"],
  },
} as const;

export function service(): GatewayHttpService {
  return {
    ping: vi.fn(async () => true),
    authenticate: vi.fn(async (bearer: string) => {
      if (!bearer) {
        throw new GatewayAuthError(401, "invalid_credential", "An access credential is required.");
      }
      return {
        credentialType: "api_key" as const,
        principalType: "user" as const,
        userId: "user-1",
        orgId: "org-authorized",
        role: "owner" as const,
        scopes: [MODEL_INVOKE_SCOPE],
      };
    }),
    listModels: vi.fn(async () => []),
    resolveModel: vi.fn(async () => {
      throw new Error("not used");
    }),
    acquireRequest: vi.fn(async () => undefined),
    releaseRequest: vi.fn(async () => undefined),
    recordUsage: vi.fn(async () => undefined),
  };
}

interface AcceptedOverrides {
  readonly owner?: (input: GatewayAudioStreamOpenInput) => GatewayAudioStreamOwner;
  readonly generation?: string;
  readonly acceptedResumeFromSequence?: number | null;
}

export function streamPort(capabilities: unknown = FULL_CAPABILITIES, accepted: AcceptedOverrides = {}) {
  let capturedInput: GatewayAudioStreamOpenInput | null = null;
  let capturedHandlers: GatewayAudioStreamHandlers | null = null;
  const initialize = vi.fn(async (): Promise<void> => undefined);
  const send = vi.fn(async (): Promise<void> => undefined);
  const finish = vi.fn(async (): Promise<void> => undefined);
  const closeSession = vi.fn(async (): Promise<void> => undefined);
  const session: GatewayAudioStreamSession = { initialize, send, finish, close: closeSession };
  const port = {
    capabilities: vi.fn(async () => capabilities),
    open: vi.fn(async (input: GatewayAudioStreamOpenInput, handlers: GatewayAudioStreamHandlers) => {
      capturedInput = input;
      capturedHandlers = handlers;
      return {
        session,
        accepted: {
          owner: accepted.owner?.(input) ?? input.owner,
          generation: accepted.generation ?? "generation-1",
          acceptedResumeFromSequence: accepted.acceptedResumeFromSequence ?? null,
        },
      };
    }),
    openInput: () => capturedInput,
    handlers: () => capturedHandlers,
    initialize,
    send,
    finish,
    closeSession,
  };
  return port satisfies GatewayAudioStreamingPort & typeof port;
}

export interface RunningGateway {
  readonly service: GatewayHttpService;
  readonly port: number;
  readonly controller: GatewayAudioStreamingController;
  readonly server: import("node:http").Server;
}

const running: RunningGateway[] = [];
const clients = new Set<WebSocket>();

export function installGatewayTestCleanup(): void {
  afterEach(async () => {
    for (const client of clients) client.terminate();
    clients.clear();
    for (const gateway of running.splice(0)) {
      await gateway.controller.close();
      gateway.server.closeAllConnections?.();
      await new Promise<void>((resolve) => gateway.server.close(() => resolve()));
    }
  });
}

export async function start(
  streaming: GatewayAudioStreamingOptions = {},
  svc: GatewayHttpService = service(),
): Promise<RunningGateway> {
  const { server, audioStreaming: controller } = createGatewayServer(svc, { audioStreaming: streaming });
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const gateway = { service: svc, port: (server.address() as AddressInfo).port, controller, server };
  running.push(gateway);
  return gateway;
}

export async function startMounted(
  streaming: GatewayAudioStreamingOptions,
  svc: GatewayHttpService = service(),
): Promise<RunningGateway> {
  const app = express();
  app.use(express.json());
  const server = createServer(app);
  const controller = bindGatewayDataPlane(app, server, svc, { audioStreaming: streaming });
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const gateway = { service: svc, port: (server.address() as AddressInfo).port, controller, server };
  running.push(gateway);
  return gateway;
}

export async function capabilities(gateway: RunningGateway, bearer = "br_test"): Promise<Response> {
  return await fetch(`http://127.0.0.1:${gateway.port}/v1/audio/transcriptions/capabilities`, {
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });
}

export function connect(
  gateway: RunningGateway,
  path = GATEWAY_AUDIO_STREAM_PATH,
  origin?: string,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${gateway.port}${path}`, origin ? { origin } : undefined);
    clients.add(socket);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

export function rejectedUpgrade(
  gateway: RunningGateway,
  expectedStatus: number,
  path = GATEWAY_AUDIO_STREAM_PATH,
  origin?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${gateway.port}${path}`, origin ? { origin } : undefined);
    clients.add(socket);
    socket.once("unexpected-response", (_request, response) => {
      if (response.statusCode === expectedStatus) resolve();
      else reject(new Error(`expected ${expectedStatus}, received ${response.statusCode}`));
      response.resume();
    });
    socket.once("open", () => reject(new Error("upgrade unexpectedly succeeded")));
    socket.once("error", () => undefined);
  });
}

export function nextJson(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    socket.once("message", (raw) => resolve(JSON.parse(raw.toString("utf8"))));
  });
}

export function closed(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once("close", (code) => resolve(code)));
}

export function nextJsonOrClose(
  socket: WebSocket,
): Promise<
  | { readonly kind: "message"; readonly value: Record<string, unknown> }
  | { readonly kind: "close"; readonly code: number }
> {
  return new Promise((resolve) => {
    const onMessage = (raw: import("ws").RawData): void => {
      cleanup();
      resolve({ kind: "message", value: JSON.parse(raw.toString("utf8")) });
    };
    const onClose = (code: number): void => {
      cleanup();
      resolve({ kind: "close", code });
    };
    const cleanup = (): void => {
      socket.off("message", onMessage);
      socket.off("close", onClose);
    };
    socket.once("message", onMessage);
    socket.once("close", onClose);
  });
}

export function attachFrame(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "attach",
    bearer: "br_stream_secret",
    requestedOrgId: "org-requested",
    sessionId: "meeting_1",
    mimeType: "audio/webm;codecs=opus",
    language: "en-AU",
    latencyMode: "balanced",
    resumeFromSequence: null,
    ...overrides,
  });
}

export function initializationFrame(initialization: Uint8Array = new Uint8Array()): Buffer {
  return Buffer.concat([Buffer.from([0x01]), Buffer.from(initialization)]);
}

export function audioFrame(
  sequence: number,
  audio: Uint8Array,
  startMs = sequence * 3_000,
  endMs = startMs + 3_000,
): Buffer {
  const frame = Buffer.alloc(21 + audio.byteLength);
  frame[0] = 0x02;
  frame.writeUInt32BE(sequence, 1);
  frame.writeBigUInt64BE(BigInt(startMs), 5);
  frame.writeBigUInt64BE(BigInt(endMs), 13);
  Buffer.from(audio).copy(frame, 21);
  return frame;
}

export async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not reached");
}
