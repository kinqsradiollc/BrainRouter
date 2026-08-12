/**
 * ADR-035 D10 adapter-event guards: coverage follows completed sends, events
 * cross the socket boundary canonically, and failed sends cannot leak output.
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
  nextJsonOrClose,
  start,
  streamPort,
  waitFor,
} from "./audio-streaming-test-helpers.js";

installGatewayTestCleanup();

describe("gateway persistent audio adapter-event contracts", () => {
  it("rejects coverage that outruns completed sends or moves backwards", async () => {
    const aheadPort = streamPort();
    const aheadGateway = await start({ port: aheadPort });
    const ahead = await connect(aheadGateway);
    ahead.send(attachFrame({ sessionId: "meeting_ahead" }));
    await nextJson(ahead);
    const aheadResult = nextJsonOrClose(ahead);
    aheadPort.handlers()!.onEvent({ kind: "coverage", coveredThroughSequence: 0 });
    expect(await aheadResult).toEqual({ kind: "close", code: GATEWAY_AUDIO_STREAM_CLOSE.upstreamFailure });

    const backwardsPort = streamPort();
    const backwardsGateway = await start({ port: backwardsPort });
    const backwards = await connect(backwardsGateway);
    backwards.send(attachFrame({ sessionId: "meeting_backwards" }));
    await nextJson(backwards);
    backwards.send(initializationFrame());
    await waitFor(() => backwardsPort.initialize.mock.calls.length === 1);
    backwards.send(audioFrame(0, Uint8Array.from([1])));
    backwards.send(audioFrame(1, Uint8Array.from([2])));
    await waitFor(() => backwardsPort.send.mock.calls.length === 2);
    const firstCoverage = nextJson(backwards);
    backwardsPort.handlers()!.onEvent({ kind: "coverage", coveredThroughSequence: 1 });
    await firstCoverage;
    const backwardsResult = nextJsonOrClose(backwards);
    backwardsPort.handlers()!.onEvent({ kind: "coverage", coveredThroughSequence: 0 });
    expect(await backwardsResult).toEqual({ kind: "close", code: GATEWAY_AUDIO_STREAM_CLOSE.upstreamFailure });
  });

  it("buffers adapter events until a send succeeds and discards them when it fails", async () => {
    const successfulPort = streamPort();
    let releaseSend: (() => void) | undefined;
    successfulPort.send.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseSend = resolve;
        }),
    );
    const successfulGateway = await start({ port: successfulPort });
    const successful = await connect(successfulGateway);
    successful.send(attachFrame({ sessionId: "meeting_buffer_success" }));
    await nextJson(successful);
    successful.send(initializationFrame());
    await waitFor(() => successfulPort.initialize.mock.calls.length === 1);
    const forwarded: Record<string, unknown>[] = [];
    successful.on("message", (raw) => forwarded.push(JSON.parse(raw.toString("utf8"))));
    successful.send(audioFrame(0, Uint8Array.from([1])));
    await waitFor(() => successfulPort.send.mock.calls.length === 1);
    successfulPort.handlers()!.onEvent({
      kind: "final",
      utteranceId: "utterance_buffered",
      revision: 0,
      text: "buffered",
      startMs: 0,
      endMs: 10,
    });
    successfulPort.handlers()!.onEvent({ kind: "coverage", coveredThroughSequence: 0 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(forwarded).toEqual([]);
    releaseSend?.();
    await waitFor(() => forwarded.length === 2);
    expect(forwarded.map((message) => (message.event as { kind: string }).kind)).toEqual(["final", "coverage"]);

    const failedPort = streamPort();
    let rejectSend: ((error: Error) => void) | undefined;
    failedPort.send.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSend = reject;
        }),
    );
    const failedGateway = await start({ port: failedPort });
    const failed = await connect(failedGateway);
    failed.send(attachFrame({ sessionId: "meeting_buffer_failure" }));
    await nextJson(failed);
    failed.send(initializationFrame());
    await waitFor(() => failedPort.initialize.mock.calls.length === 1);
    const leaked: Record<string, unknown>[] = [];
    failed.on("message", (raw) => leaked.push(JSON.parse(raw.toString("utf8"))));
    failed.send(audioFrame(0, Uint8Array.from([1])));
    await waitFor(() => failedPort.send.mock.calls.length === 1);
    failedPort.handlers()!.onEvent({
      kind: "final",
      utteranceId: "utterance_discarded",
      revision: 0,
      text: "must not leak",
      startMs: 0,
      endMs: 10,
    });
    const failedClosed = closed(failed);
    rejectSend?.(new Error("adapter detail must not escape"));
    expect(await failedClosed).toBe(GATEWAY_AUDIO_STREAM_CLOSE.upstreamFailure);
    expect(leaked).toEqual([]);
  });

  it("forwards one-read canonical events and rejects fields smuggled onto text events", async () => {
    const port = streamPort();
    const gateway = await start({ port });
    const socket = await connect(gateway);
    socket.send(attachFrame({ sessionId: "meeting_equal_ack" }));
    await nextJson(socket);
    socket.send(initializationFrame());
    await waitFor(() => port.initialize.mock.calls.length === 1);
    socket.send(audioFrame(0, Uint8Array.from([1])));
    await waitFor(() => port.send.mock.calls.length === 1);

    let textReads = 0;
    const getterBackedEvent = {
      kind: "final" as const,
      utteranceId: "utterance_1",
      revision: 0,
      get text() {
        textReads += 1;
        return textReads === 1 ? "stable text" : "mutated text";
      },
      startMs: 0,
      endMs: 10,
    };
    const canonical = nextJson(socket);
    port.handlers()!.onEvent(getterBackedEvent);
    expect(await canonical).toMatchObject({
      type: "transcript.event",
      event: { kind: "final", utteranceId: "utterance_1", text: "stable text" },
    });
    expect(textReads).toBe(1);

    const invalid = nextJsonOrClose(socket);
    port.handlers()!.onEvent({
      kind: "partial",
      utteranceId: "utterance_2",
      revision: 0,
      text: "unsafe",
      startMs: 5,
      endMs: 10,
      coveredThroughSequence: 0,
    } as never);
    expect(await invalid).toEqual({ kind: "close", code: GATEWAY_AUDIO_STREAM_CLOSE.upstreamFailure });
  });

  it("rejects zero-duration adapter utterances before they reach a host", async () => {
    for (const kind of ["partial", "final"] as const) {
      const port = streamPort();
      const gateway = await start({ port });
      const socket = await connect(gateway);
      socket.send(attachFrame({ sessionId: `meeting_zero_${kind}` }));
      await nextJson(socket);

      const rejected = nextJsonOrClose(socket);
      port.handlers()!.onEvent({
        kind,
        utteranceId: `utterance_zero_${kind}`,
        revision: 0,
        text: "must not escape",
        startMs: 3_000,
        endMs: 3_000,
      });
      expect(await rejected).toEqual({ kind: "close", code: GATEWAY_AUDIO_STREAM_CLOSE.upstreamFailure });
    }
  });
});
