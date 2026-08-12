/**
 * ADR-035 D10 binary-flow guards: bootstrap precedes contiguous chunks,
 * chunk ranges remain valid, and deliberate finish closes the generation.
 */
import { describe, expect, it } from "vitest";

import { GATEWAY_AUDIO_STREAM_CLOSE } from "./audio-streaming-protocol.js";
import {
  attachFrame,
  audioFrame,
  closed,
  connect,
  initializationFrame,
  installGatewayTestCleanup,
  nextJson,
  start,
  streamPort,
  waitFor,
} from "./audio-streaming-test-helpers.js";

installGatewayTestCleanup();

describe("gateway persistent audio binary-flow contracts", () => {
  it("requires initialization before audio and rejects a non-contiguous sequence", async () => {
    const port = streamPort();
    const gateway = await start({ port });
    const uninitialized = await connect(gateway);
    uninitialized.send(attachFrame());
    await nextJson(uninitialized);
    const uninitializedClosed = closed(uninitialized);
    uninitialized.send(audioFrame(0, Uint8Array.from([1])));
    expect(await uninitializedClosed).toBe(GATEWAY_AUDIO_STREAM_CLOSE.protocol);

    await waitFor(() => port.closeSession.mock.calls.length === 1);
    const gapSocket = await connect(gateway);
    gapSocket.send(attachFrame());
    await nextJson(gapSocket);
    gapSocket.send(initializationFrame());
    await waitFor(() => port.initialize.mock.calls.length === 1);
    const gapClosed = closed(gapSocket);
    gapSocket.send(audioFrame(1, Uint8Array.from([1])));
    expect(await gapClosed).toBe(GATEWAY_AUDIO_STREAM_CLOSE.invalidRequest);
  });

  it("allows an explicit empty initialization and rejects oversized or overlapping chunk ranges", async () => {
    const durationPort = streamPort();
    const durationGateway = await start({ port: durationPort, maxChunkDurationMs: 1_000 });
    const duration = await connect(durationGateway);
    duration.send(attachFrame({ sessionId: "meeting_duration" }));
    await nextJson(duration);
    duration.send(initializationFrame());
    await waitFor(() => durationPort.initialize.mock.calls.length === 1);
    expect(durationPort.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        initializationSegment: new Uint8Array(),
      }),
    );
    const durationClosed = closed(duration);
    duration.send(audioFrame(0, Uint8Array.from([1]), 0, 1_001));
    expect(await durationClosed).toBe(GATEWAY_AUDIO_STREAM_CLOSE.invalidRequest);

    const overlapPort = streamPort();
    const overlapGateway = await start({ port: overlapPort });
    const overlap = await connect(overlapGateway);
    overlap.send(attachFrame({ sessionId: "meeting_overlap" }));
    await nextJson(overlap);
    overlap.send(initializationFrame());
    await waitFor(() => overlapPort.initialize.mock.calls.length === 1);
    overlap.send(audioFrame(0, Uint8Array.from([1]), 0, 3_000));
    await waitFor(() => overlapPort.send.mock.calls.length === 1);
    const overlapClosed = closed(overlap);
    overlap.send(audioFrame(1, Uint8Array.from([2]), 2_999, 6_000));
    expect(await overlapClosed).toBe(GATEWAY_AUDIO_STREAM_CLOSE.invalidRequest);
  });

  it("finishes deliberately only after initialization and closes the generation as finished", async () => {
    const port = streamPort();
    const gateway = await start({ port });
    const socket = await connect(gateway);
    socket.send(attachFrame({ sessionId: "meeting_finish" }));
    await nextJson(socket);
    socket.send(initializationFrame());
    await waitFor(() => port.initialize.mock.calls.length === 1);
    const finished = nextJson(socket);
    const finishedClosed = closed(socket);
    socket.send(JSON.stringify({ type: "finish" }));
    expect(await finished).toEqual({ type: "finished" });
    expect(await finishedClosed).toBe(1000);
    await waitFor(() => port.closeSession.mock.calls.length === 1);
    expect(port.finish).toHaveBeenCalledTimes(1);
    expect(port.closeSession).toHaveBeenCalledWith("finished");
  });
});
