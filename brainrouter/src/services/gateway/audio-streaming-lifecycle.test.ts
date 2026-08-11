/**
 * ADR-035 D10 lifecycle and resource guards: opens and closes are bounded,
 * admission is released, and slow adapters cannot defeat backpressure or shutdown.
 */
import { describe, expect, it } from "vitest";

import {
  GATEWAY_AUDIO_STREAM_CLOSE,
  type GatewayAudioStreamHandlers,
  type GatewayAudioStreamOpenInput,
  type GatewayAudioStreamOpenResult,
} from "./audio-streaming-protocol.js";
import {
  attachFrame,
  audioFrame,
  closed,
  connect,
  initializationFrame,
  installGatewayTestCleanup,
  nextJson,
  rejectedUpgrade,
  start,
  streamPort,
  waitFor,
} from "./audio-streaming-test-helpers.js";

installGatewayTestCleanup();

describe("gateway persistent audio lifecycle contracts", () => {
  it("closes a session that resolves after attach aborts during port open", async () => {
    const port = streamPort();
    let handlers: GatewayAudioStreamHandlers | null = null;
    let input: GatewayAudioStreamOpenInput | null = null;
    let resolveOpen: ((result: GatewayAudioStreamOpenResult) => void) | undefined;
    port.open.mockImplementation(async (nextInput, nextHandlers) => {
      input = nextInput;
      handlers = nextHandlers;
      return await new Promise<GatewayAudioStreamOpenResult>((resolve) => {
        resolveOpen = resolve;
      });
    });
    const gateway = await start({ port });
    const socket = await connect(gateway);
    socket.send(attachFrame({ sessionId: "meeting_late_open" }));
    await waitFor(() => port.open.mock.calls.length === 1 && handlers !== null);
    const wasClosed = closed(socket);
    handlers!.onDrop();
    expect(await wasClosed).toBe(GATEWAY_AUDIO_STREAM_CLOSE.upstreamFailure);

    resolveOpen?.({
      session: { initialize: port.initialize, send: port.send, finish: port.finish, close: port.closeSession },
      accepted: { owner: input!.owner, generation: "generation-late", acceptedResumeFromSequence: null },
    });
    await waitFor(() => port.closeSession.mock.calls.length === 1);
  });

  it("waits for adapter close completion before controller shutdown resolves", async () => {
    const port = streamPort();
    let releaseClose: (() => void) | undefined;
    port.closeSession.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseClose = resolve;
        }),
    );
    const gateway = await start({ port });
    const socket = await connect(gateway);
    socket.send(attachFrame({ sessionId: "meeting_deferred_close" }));
    await nextJson(socket);

    let shutdownSettled = false;
    const shutdown = gateway.controller.close().then(() => {
      shutdownSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(shutdownSettled).toBe(false);
    releaseClose?.();
    await shutdown;
    expect(port.closeSession).toHaveBeenCalledTimes(1);
  });

  it("bounds controller shutdown when adapter open ignores abort and disposes a late result", async () => {
    const port = streamPort();
    let input: GatewayAudioStreamOpenInput | null = null;
    let resolveOpen: ((result: GatewayAudioStreamOpenResult) => void) | undefined;
    port.open.mockImplementation(async (nextInput) => {
      input = nextInput;
      return await new Promise<GatewayAudioStreamOpenResult>((resolve) => {
        resolveOpen = resolve;
      });
    });
    const gateway = await start({ port, cleanupDeadlineMs: 50 });
    const socket = await connect(gateway);
    socket.send(attachFrame({ sessionId: "meeting_never_open" }));
    await waitFor(() => port.open.mock.calls.length === 1);

    const shutdown = gateway.controller.close();
    const outcome = await Promise.race([
      shutdown.then(() => "closed" as const),
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 250)),
    ]);
    resolveOpen?.({
      session: { initialize: port.initialize, send: port.send, finish: port.finish, close: port.closeSession },
      accepted: { owner: input!.owner, generation: "generation-after-close", acceptedResumeFromSequence: null },
    });
    await shutdown;
    expect(outcome).toBe("closed");
    await waitFor(() => port.closeSession.mock.calls.length === 1);
  });

  it("bounds controller shutdown when adapter close never settles", async () => {
    const port = streamPort();
    let releaseClose: (() => void) | undefined;
    port.closeSession.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseClose = resolve;
        }),
    );
    const gateway = await start({ port, cleanupDeadlineMs: 50 });
    const socket = await connect(gateway);
    socket.send(attachFrame({ sessionId: "meeting_never_close" }));
    await nextJson(socket);

    const shutdown = gateway.controller.close();
    const outcome = await Promise.race([
      shutdown.then(() => "closed" as const),
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 250)),
    ]);
    releaseClose?.();
    await shutdown;
    expect(outcome).toBe("closed");
    expect(port.closeSession).toHaveBeenCalledTimes(1);
  });

  it("bounds silent pending attaches per IP and releases admission after disconnect", async () => {
    const port = streamPort();
    const gateway = await start({ port, maxPendingStreamsPerIp: 1 });
    const first = await connect(gateway);
    await rejectedUpgrade(gateway, 429);
    const firstClosed = closed(first);
    first.terminate();
    await firstClosed;

    const retried = await connect(gateway);
    retried.send(attachFrame({ sessionId: "meeting_after_pending_release" }));
    expect(await nextJson(retried)).toMatchObject({ type: "attached" });
  });

  it("bounds authenticated principal streams and releases quota on ordinary close", async () => {
    const port = streamPort();
    const gateway = await start({ port, maxStreamsPerPrincipal: 1 });
    const first = await connect(gateway);
    first.send(attachFrame({ sessionId: "meeting_principal_1" }));
    await nextJson(first);

    const blocked = await connect(gateway);
    const blockedClosed = closed(blocked);
    blocked.send(attachFrame({ sessionId: "meeting_principal_2" }));
    expect(await blockedClosed).toBe(GATEWAY_AUDIO_STREAM_CLOSE.overloaded);
    expect(port.open).toHaveBeenCalledTimes(1);

    const firstClosed = closed(first);
    first.close();
    await firstClosed;
    const retried = await connect(gateway);
    retried.send(attachFrame({ sessionId: "meeting_principal_3" }));
    expect(await nextJson(retried)).toMatchObject({ type: "attached" });
    expect(port.open).toHaveBeenCalledTimes(2);
  });

  it("enforces aggregate audio bytes and recovers in the next window", async () => {
    let clock = 0;
    const port = streamPort();
    const gateway = await start({ port, maxAggregateBytesPerSecond: 3, now: () => clock });
    const first = await connect(gateway);
    first.send(attachFrame({ sessionId: "meeting_bytes_1" }));
    await nextJson(first);
    first.send(initializationFrame());
    await waitFor(() => port.initialize.mock.calls.length === 1);
    first.send(audioFrame(0, Uint8Array.from([1, 2, 3])));
    await waitFor(() => port.send.mock.calls.length === 1);
    const overLimit = closed(first);
    first.send(audioFrame(1, Uint8Array.from([4])));
    expect(await overLimit).toBe(GATEWAY_AUDIO_STREAM_CLOSE.overloaded);

    clock = 1_001;
    const next = await connect(gateway);
    next.send(attachFrame({ sessionId: "meeting_bytes_2" }));
    await nextJson(next);
    next.send(initializationFrame());
    await waitFor(() => port.initialize.mock.calls.length === 2);
    next.send(audioFrame(0, Uint8Array.from([5, 6, 7])));
    await waitFor(() => port.send.mock.calls.length === 2);
  });

  it("closes a stream whose adapter send exceeds the bounded deadline", async () => {
    const port = streamPort();
    let releaseSend: (() => void) | undefined;
    port.send.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseSend = resolve;
        }),
    );
    const gateway = await start({ port, sendDeadlineMs: 50 });
    const socket = await connect(gateway);
    socket.send(attachFrame({ sessionId: "meeting_send_deadline" }));
    await nextJson(socket);
    socket.send(initializationFrame());
    await waitFor(() => port.initialize.mock.calls.length === 1);
    const wasClosed = closed(socket);
    socket.send(audioFrame(0, Uint8Array.from([1])));
    expect(await wasClosed).toBe(GATEWAY_AUDIO_STREAM_CLOSE.upstreamFailure);
    releaseSend?.();
  });

  it("bounds attach time and frame rate, then controller shutdown closes upgraded sockets", async () => {
    const port = streamPort();
    const gateway = await start({ port, attachDeadlineMs: 60, maxFramesPerSecond: 1 });
    const silent = await connect(gateway);
    expect(await closed(silent)).toBe(GATEWAY_AUDIO_STREAM_CLOSE.attachTimeout);

    const socket = await connect(gateway);
    socket.send(attachFrame());
    await nextJson(socket);
    const rateClosed = closed(socket);
    socket.send(initializationFrame());
    socket.send(audioFrame(0, Uint8Array.from([1])));
    expect(await rateClosed).toBe(GATEWAY_AUDIO_STREAM_CLOSE.invalidRequest);

    await waitFor(() => port.closeSession.mock.calls.length >= 1);
    const shutdownSocket = await connect(gateway);
    shutdownSocket.send(attachFrame({ sessionId: "meeting_2" }));
    await nextJson(shutdownSocket);
    const shutdownClosed = closed(shutdownSocket);
    await gateway.controller.close();
    expect(await shutdownClosed).toBeGreaterThan(0);
    expect(port.closeSession).toHaveBeenCalled();
  });

  it("enforces the frame-size and queued-byte backpressure bounds", async () => {
    const oversizedPort = streamPort();
    const oversizedGateway = await start({ port: oversizedPort, maxFrameBytes: 1024 });
    const oversized = await connect(oversizedGateway);
    oversized.send(attachFrame());
    await nextJson(oversized);
    oversized.send(initializationFrame());
    await waitFor(() => oversizedPort.initialize.mock.calls.length === 1);
    const oversizedClosed = closed(oversized);
    oversized.send(audioFrame(0, new Uint8Array(1_021)));
    expect(await oversizedClosed).toBe(GATEWAY_AUDIO_STREAM_CLOSE.tooLarge);

    let releaseSend: (() => void) | undefined;
    const queuedPort = streamPort();
    queuedPort.send.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseSend = resolve;
        }),
    );
    const queuedGateway = await start({ port: queuedPort, maxFrameBytes: 1024, maxQueuedBytes: 1024 });
    const queued = await connect(queuedGateway);
    queued.send(attachFrame());
    await nextJson(queued);
    queued.send(initializationFrame());
    await waitFor(() => queuedPort.initialize.mock.calls.length === 1);
    const queuedClosed = closed(queued);
    queued.send(audioFrame(0, new Uint8Array(700)));
    await waitFor(() => queuedPort.send.mock.calls.length === 1);
    queued.send(audioFrame(1, new Uint8Array(700)));
    expect(await queuedClosed).toBe(GATEWAY_AUDIO_STREAM_CLOSE.overloaded);
    releaseSend?.();
  });
});
