/**
 * ADR-035 D10 capability and binding guards: HTTP-only constructors stay
 * segmented, bound transports share policy, and origin/security rules fail closed.
 */
import type { AddressInfo } from "node:net";

import { SEGMENTED_TRANSCRIPTION_CAPABILITIES } from "@kinqs/brainrouter-core/meetings";
import express from "express";
import { describe, expect, it } from "vitest";

import { GATEWAY_AUDIO_STREAM_CLOSE, GATEWAY_AUDIO_STREAM_PATH } from "./audio-streaming-protocol.js";
import {
  attachFrame,
  capabilities,
  closed,
  connect,
  FULL_CAPABILITIES,
  installGatewayTestCleanup,
  nextJson,
  rejectedUpgrade,
  service,
  start,
  startMounted,
  streamPort,
} from "./audio-streaming-test-helpers.js";
import { createGatewayApp, mountGatewayDataPlane } from "./server.js";

installGatewayTestCleanup();

describe("gateway persistent audio capability and binding contracts", () => {
  it("authenticates the capability document and defaults honestly to segmented upload", async () => {
    const gateway = await start();
    const unauthenticated = await capabilities(gateway, "");
    expect(unauthenticated.status).toBe(401);

    const response = await capabilities(gateway);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(SEGMENTED_TRANSCRIPTION_CAPABILITIES);
  });

  it("never advertises streaming from exported HTTP-only constructors", async () => {
    for (const kind of ["standalone-app", "in-process-mount"] as const) {
      const port = streamPort();
      const svc = service();
      const app = kind === "standalone-app" ? createGatewayApp(svc, { audioStreaming: { port } }) : express();
      if (kind === "in-process-mount") {
        app.use(express.json());
        mountGatewayDataPlane(app, svc, { audioStreaming: { port } });
      }
      const server = app.listen(0);
      await new Promise<void>((resolve) => server.once("listening", resolve));
      try {
        const response = await fetch(
          `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/audio/transcriptions/capabilities`,
          { headers: { authorization: "Bearer br_test" } },
        );
        expect(await response.json()).toEqual(SEGMENTED_TRANSCRIPTION_CAPABILITIES);
        expect(port.capabilities).not.toHaveBeenCalled();
      } finally {
        server.closeAllConnections?.();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  });

  it("rejects the WebSocket before upgrade without a port while batch POST remains registered", async () => {
    const gateway = await start();
    await rejectedUpgrade(gateway, 503);

    const batch = await fetch(`http://127.0.0.1:${gateway.port}/v1/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: "Bearer br_test", "content-type": "audio/webm" },
    });
    expect(batch.status).toBe(400);
    expect((await batch.json()).error.code).toBe("missing_audio");
  });

  it("fails closed on a partial capability advertisement and never opens its port", async () => {
    const port = streamPort({
      ...FULL_CAPABILITIES,
      streaming: { ...FULL_CAPABILITIES.streaming, coverageCheckpoints: false },
    });
    const gateway = await start({ port });
    expect(await (await capabilities(gateway)).json()).toEqual(SEGMENTED_TRANSCRIPTION_CAPABILITIES);

    const socket = await connect(gateway);
    const wasClosed = closed(socket);
    socket.send(attachFrame());
    expect(await wasClosed).toBe(GATEWAY_AUDIO_STREAM_CLOSE.unavailable);
    expect(port.open).not.toHaveBeenCalled();
  });

  it("uses the same authenticated capability and upgrade plane on the in-process mount", async () => {
    const port = streamPort();
    const gateway = await startMounted({ port });
    expect(await (await capabilities(gateway)).json()).toEqual(FULL_CAPABILITIES);

    const socket = await connect(gateway);
    const attached = nextJson(socket);
    socket.send(attachFrame());
    expect(await attached).toMatchObject({ type: "attached", sessionId: "meeting_1" });
    expect(port.open).toHaveBeenCalledTimes(1);
  });

  it("rejects foreign origins, wrong paths, and every query string before reading a credential", async () => {
    const port = streamPort();
    const gateway = await start({ port, allowedOrigins: ["https://app.test"], production: true });
    await rejectedUpgrade(gateway, 403, GATEWAY_AUDIO_STREAM_PATH, "https://foreign.test");
    await rejectedUpgrade(gateway, 404, "/v1/unknown-websocket");
    await rejectedUpgrade(gateway, 400, `${GATEWAY_AUDIO_STREAM_PATH}?bearer=must-not-appear`);
    expect(gateway.service.authenticate).not.toHaveBeenCalled();
    expect(port.open).not.toHaveBeenCalled();
  });

  it("accepts exact production same-origin but rejects cross-scheme same-host", async () => {
    const port = streamPort();
    const gateway = await start({ port, allowedOrigins: [], production: true });
    const sameOrigin = `http://127.0.0.1:${gateway.port}`;
    const socket = await connect(gateway, GATEWAY_AUDIO_STREAM_PATH, sameOrigin);
    socket.send(attachFrame());
    expect(await nextJson(socket)).toMatchObject({ type: "attached" });

    await rejectedUpgrade(gateway, 403, GATEWAY_AUDIO_STREAM_PATH, `https://127.0.0.1:${gateway.port}`);
  });

  it("normalizes default standalone production once for HTTP and WebSocket security", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const port = streamPort();
      const gateway = await start({ port, allowedOrigins: [] });
      const response = await capabilities(gateway);
      expect(response.headers.get("strict-transport-security")).toContain("max-age=");

      const socket = await connect(gateway, GATEWAY_AUDIO_STREAM_PATH, `http://127.0.0.1:${gateway.port}`);
      socket.send(attachFrame({ sessionId: "meeting_default_production" }));
      expect(await nextJson(socket)).toMatchObject({ type: "attached" });
      await rejectedUpgrade(gateway, 403, GATEWAY_AUDIO_STREAM_PATH, `https://127.0.0.1:${gateway.port}`);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it("applies capability CORS and security headers from the same binding options", async () => {
    const port = streamPort();
    const gateway = await start({ port, allowedOrigins: ["https://app.test"], production: true });
    const response = await fetch(`http://127.0.0.1:${gateway.port}/v1/audio/transcriptions/capabilities`, {
      headers: {
        authorization: "Bearer br_test",
        origin: "https://app.test",
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://app.test");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("strict-transport-security")).toContain("max-age=");
  });
});
