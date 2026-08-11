/**
 * A stand-in for the speech sidecar's live endpoint, for ADR-035 D10 tests.
 *
 * The adapter's whole job is translating one wire protocol into another, so the
 * tests exercise a real loopback HTTP server rather than a mocked fetch: the
 * bytes the endpoint receives and the lines it sends back ARE the contract, and
 * a stub that never carries them proves nothing about either.
 *
 * It answers `GET /stream/capabilities` with whatever this instance was told to
 * advertise, and holds `POST /stream` open so a test can emit NDJSON events at
 * chosen moments while audio is still arriving.
 */
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { GATEWAY_AUDIO_STREAM_PROTOCOL } from "./audio-streaming-endpoint.js";

export interface FakeSidecarOptions {
  readonly protocol?: string;
  readonly modes?: readonly string[];
  readonly capabilitiesStatus?: number;
  readonly capabilitiesBody?: string;
  readonly streamStatus?: number;
  readonly streamContentType?: string;
  /** When false the response stays open after the request body ends, as a wedged endpoint would. */
  readonly endOnBodyEnd?: boolean;
}

export interface FakeSidecar {
  readonly url: string;
  /** Every audio byte the endpoint has received on the live request, in order. */
  received(): Buffer;
  streamHeaders(): IncomingHttpHeaders | null;
  streamAttempts(): number;
  bodyEnded(): boolean;
  emit(event: Record<string, unknown>): void;
  /** Write a raw line, for the malformed cases a well-behaved endpoint would never send. */
  emitRaw(line: string): void;
  endStream(): void;
  close(): Promise<void>;
}

export async function startFakeSidecar(options: FakeSidecarOptions = {}): Promise<FakeSidecar> {
  const modes = options.modes ?? ["low-latency", "balanced", "high-accuracy"];
  const capabilities = JSON.stringify({
    protocol: options.protocol ?? GATEWAY_AUDIO_STREAM_PROTOCOL,
    latencyModes: modes,
  });
  let audio: Buffer[] = [];
  let headers: IncomingHttpHeaders | null = null;
  let attempts = 0;
  let ended = false;
  let live: ServerResponse | null = null;
  const buffered: string[] = [];

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url === "/stream/capabilities") {
      res.writeHead(options.capabilitiesStatus ?? 200, { "content-type": "application/json" });
      res.end(options.capabilitiesBody ?? capabilities);
      return;
    }
    if (req.method !== "POST" || req.url !== "/stream") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    attempts += 1;
    headers = req.headers;
    const status = options.streamStatus ?? 200;
    if (status !== 200) {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "refused" }));
      req.resume();
      return;
    }
    audio = [];
    ended = false;
    live = res;
    res.writeHead(200, { "content-type": options.streamContentType ?? "application/x-ndjson" });
    res.flushHeaders();
    for (const line of buffered.splice(0)) res.write(line);
    req.on("data", (chunk: Buffer) => audio.push(chunk));
    req.on("end", () => {
      ended = true;
      if (options.endOnBodyEnd !== false) res.end();
    });
    req.on("error", () => undefined);
  });

  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));

  const write = (line: string): void => {
    if (live && !live.writableEnded) live.write(line);
    else buffered.push(line);
  };

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    received: () => Buffer.concat(audio),
    streamHeaders: () => headers,
    streamAttempts: () => attempts,
    bodyEnded: () => ended,
    emit: (event) => write(`${JSON.stringify(event)}\n`),
    emitRaw: (line) => write(line),
    endStream: () => {
      if (live && !live.writableEnded) live.end();
    },
    close: async () => {
      if (live && !live.writableEnded) live.end();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
