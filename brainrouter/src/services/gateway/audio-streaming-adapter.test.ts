/**
 * ADR-035 D10 adapter contracts, end to end over the real transport: the gate
 * decides whether streaming exists at all, audio bytes reach the endpoint
 * unchanged, live text comes back on the meeting's own timeline, a committed
 * millisecond becomes a chunk-sequence coverage proof, and a failure says
 * whether it was the audio or the endpoint.
 */
import { SEGMENTED_TRANSCRIPTION_CAPABILITIES } from "@kinqs/brainrouter-core/meetings";
import { afterEach, describe, expect, it } from "vitest";

import { GATEWAY_AUDIO_STREAM_CLOSE } from "./audio-streaming-protocol.js";
import { startFakeSidecar, type FakeSidecar, type FakeSidecarOptions } from "./audio-streaming-sidecar-harness.js";
import {
  attachFrame,
  audioFrame,
  capabilities,
  closed,
  connect,
  initializationFrame,
  installGatewayTestCleanup,
  nextJson,
  rejectedUpgrade,
  start,
  waitFor,
  type RunningGateway,
} from "./audio-streaming-test-helpers.js";

installGatewayTestCleanup();

const configured = process.env.BRAINROUTER_STT_STREAM_URL;
const sidecars: FakeSidecar[] = [];

afterEach(async () => {
  for (const sidecar of sidecars.splice(0)) await sidecar.close();
  if (configured === undefined) delete process.env.BRAINROUTER_STT_STREAM_URL;
  else process.env.BRAINROUTER_STT_STREAM_URL = configured;
});

/** A gateway bound with the environment pointing at a fresh fake endpoint. */
async function streaming(
  options: FakeSidecarOptions = {},
): Promise<{ readonly fake: FakeSidecar; readonly gateway: RunningGateway }> {
  const fake = await startFakeSidecar(options);
  sidecars.push(fake);
  process.env.BRAINROUTER_STT_STREAM_URL = fake.url;
  return { fake, gateway: await start() };
}

/** Attach, then bootstrap the container so audio frames are accepted. */
async function attached(gateway: RunningGateway, overrides: Record<string, unknown> = {}) {
  const socket = await connect(gateway);
  const first = nextJson(socket);
  socket.send(attachFrame(overrides));
  return { socket, attached: await first };
}

describe("gateway streaming adapter", () => {
  it("leaves production segmented when no endpoint is configured", async () => {
    delete process.env.BRAINROUTER_STT_STREAM_URL;
    const gateway = await start();
    expect(await (await capabilities(gateway)).json()).toEqual(SEGMENTED_TRANSCRIPTION_CAPABILITIES);
    await rejectedUpgrade(gateway, 503);
  });

  it("advertises the endpoint's own latency modes and refuses one it does not offer", async () => {
    const { gateway } = await streaming({ modes: ["balanced"] });
    expect(await (await capabilities(gateway)).json()).toMatchObject({
      streaming: { latencyModes: ["balanced"] },
    });

    const socket = await connect(gateway);
    const wasClosed = closed(socket);
    socket.send(attachFrame({ latencyMode: "low-latency" }));
    expect(await wasClosed).toBe(GATEWAY_AUDIO_STREAM_CLOSE.invalidRequest);
  });

  it("forwards the session metadata and every audio byte to the endpoint unchanged", async () => {
    const { fake, gateway } = await streaming();
    const { socket } = await attached(gateway);
    await waitFor(() => fake.streamAttempts() === 1);
    expect(fake.streamHeaders()).toMatchObject({
      "content-type": "audio/webm;codecs=opus",
      "x-latency-mode": "balanced",
      "x-language": "en-AU",
    });
    // The bearer that established this session ends at gateway authentication.
    expect(JSON.stringify(fake.streamHeaders())).not.toContain("br_stream_secret");

    socket.send(initializationFrame(Uint8Array.from([0x1a, 0x45, 0xdf])));
    socket.send(audioFrame(0, Uint8Array.from([0xa3, 0x81]), 60_000, 63_000));
    await waitFor(() => fake.received().length === 5);
    expect([...fake.received()]).toEqual([0x1a, 0x45, 0xdf, 0xa3, 0x81]);
  });

  it("returns live text on the meeting's timeline, with revisions that only move forward", async () => {
    const { fake, gateway } = await streaming();
    const { socket } = await attached(gateway);
    await waitFor(() => fake.streamAttempts() === 1);
    socket.send(initializationFrame());
    socket.send(audioFrame(0, Uint8Array.from([1]), 60_000, 63_000));
    await waitFor(() => fake.received().length === 1);

    const firstPartial = nextJson(socket);
    fake.emit({ type: "partial", utteranceId: "u0", startMs: 100, endMs: 2_500, text: "recognise" });
    const first = (await firstPartial).event as Record<string, unknown>;
    expect(first).toMatchObject({
      kind: "partial",
      revision: 0,
      text: "recognise",
      startMs: 60_100,
      endMs: 62_500,
    });

    const secondPartial = nextJson(socket);
    fake.emit({ type: "partial", utteranceId: "u0", startMs: 100, endMs: 2_900, text: "recognised the" });
    const second = (await secondPartial).event as Record<string, unknown>;
    expect(second).toMatchObject({ kind: "partial", revision: 1, utteranceId: first.utteranceId });

    const sealed = nextJson(socket);
    fake.emit({ type: "final", utteranceId: "u0", startMs: 100, endMs: 2_900, text: "recognised the room" });
    expect((await sealed).event).toMatchObject({
      kind: "final",
      revision: 2,
      utteranceId: first.utteranceId,
      text: "recognised the room",
      endMs: 62_900,
    });
  });

  it("turns a committed millisecond into a coverage proof over the chunks it actually sent", async () => {
    const { fake, gateway } = await streaming();
    const { socket, attached: accepted } = await attached(gateway, {
      sessionId: "meeting_resume",
      resumeFromSequence: 4,
    });
    // A fresh decode has no memory, so the accepted checkpoint is the one the
    // host proved it persisted — never a higher one.
    expect(accepted).toMatchObject({ acceptedResumeFromSequence: 4 });
    await waitFor(() => fake.streamAttempts() === 1);
    socket.send(initializationFrame());
    socket.send(audioFrame(5, Uint8Array.from([1]), 15_000, 18_000));
    socket.send(audioFrame(6, Uint8Array.from([2]), 18_000, 21_000));
    await waitFor(() => fake.received().length === 2);

    const firstCoverage = nextJson(socket);
    fake.emit({ type: "committed", throughMs: 3_000 });
    expect((await firstCoverage).event).toEqual({ kind: "coverage", coveredThroughSequence: 5 });

    const nextCoverage = nextJson(socket);
    // Behind what is already covered, and short of any chunk boundary: neither
    // may produce a proof, so the next event on the wire is the later one.
    fake.emit({ type: "committed", throughMs: 2_000 });
    fake.emit({ type: "committed", throughMs: 3_500 });
    fake.emit({ type: "committed", throughMs: 6_000 });
    expect((await nextCoverage).event).toEqual({ kind: "coverage", coveredThroughSequence: 6 });
  });

  it("separates undecodable audio from an endpoint failure", async () => {
    for (const [code, expected] of [
      ["undecodable_audio", GATEWAY_AUDIO_STREAM_CLOSE.undecodableAudio],
      ["decoder_failed", GATEWAY_AUDIO_STREAM_CLOSE.upstreamFailure],
      ["stream_capacity", GATEWAY_AUDIO_STREAM_CLOSE.upstreamFailure],
    ] as const) {
      const { fake, gateway } = await streaming();
      const { socket } = await attached(gateway, { sessionId: `meeting_${code}` });
      await waitFor(() => fake.streamAttempts() === 1);
      const wasClosed = closed(socket);
      fake.emit({ type: "error", code });
      expect(await wasClosed).toBe(expected);
    }
  });

  it("keeps a refused or vanished endpoint in the refundable class", async () => {
    const refused = await streaming({ streamStatus: 503 });
    const refusedSocket = await connect(refused.gateway);
    const refusedClosed = closed(refusedSocket);
    refusedSocket.send(attachFrame());
    expect(await refusedClosed).toBe(GATEWAY_AUDIO_STREAM_CLOSE.upstreamFailure);
    expect(refused.fake.streamAttempts()).toBe(1);

    const vanished = await streaming();
    const { socket } = await attached(vanished.gateway, { sessionId: "meeting_vanished" });
    await waitFor(() => vanished.fake.streamAttempts() === 1);
    const vanishedClosed = closed(socket);
    vanished.fake.endStream();
    expect(await vanishedClosed).toBe(GATEWAY_AUDIO_STREAM_CLOSE.upstreamFailure);
  });

  it("refuses the upgrade without touching the endpoint when it cannot confirm the protocol", async () => {
    for (const options of [{ capabilitiesStatus: 500 }, { protocol: "some.other.stream.v1" }]) {
      const { fake, gateway } = await streaming(options);
      expect(await (await capabilities(gateway)).json()).toEqual(SEGMENTED_TRANSCRIPTION_CAPABILITIES);
      const socket = await connect(gateway);
      const wasClosed = closed(socket);
      socket.send(attachFrame());
      expect(await wasClosed).toBe(GATEWAY_AUDIO_STREAM_CLOSE.unavailable);
      expect(fake.streamAttempts()).toBe(0);
    }
  });

  it("closes on a line that never ends", async () => {
    const { fake, gateway } = await streaming();
    const { socket } = await attached(gateway);
    await waitFor(() => fake.streamAttempts() === 1);
    const wasClosed = closed(socket);
    fake.emitRaw(`{"type":"partial","text":"${"x".repeat(80 * 1024)}`);
    expect(await wasClosed).toBe(GATEWAY_AUDIO_STREAM_CLOSE.upstreamFailure);
  });

  it("delivers every event in a burst, not just the first of each read", async () => {
    const { fake, gateway } = await streaming();
    const { socket } = await attached(gateway);
    await waitFor(() => fake.streamAttempts() === 1);
    socket.send(initializationFrame());
    socket.send(audioFrame(0, Uint8Array.from([1]), 0, 3_000));
    await waitFor(() => fake.received().length === 1);

    // Well over the single-line ceiling, but every line is terminated: a live
    // endpoint emitting quickly is not a malformed one.
    const burst = Array.from(
      { length: 200 },
      (_unused, index) =>
        `${JSON.stringify({
          type: "partial",
          utteranceId: "u0",
          startMs: 0,
          endMs: 1_000 + index,
          text: `partial ${index} ${"x".repeat(400)}`,
        })}\n`,
    ).join("");
    expect(burst.length).toBeGreaterThan(64 * 1024);

    const last = new Promise<Record<string, unknown>>((resolve) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString("utf8")) as { event?: Record<string, unknown> };
        if (message.event?.endMs === 1_199) resolve(message.event);
      });
    });
    fake.emitRaw(burst);
    expect(await last).toMatchObject({ kind: "partial", revision: 199 });
  });

  it("treats a line that is not one of ours as an endpoint failure", async () => {
    const { fake, gateway } = await streaming();
    const { socket } = await attached(gateway);
    await waitFor(() => fake.streamAttempts() === 1);
    const wasClosed = closed(socket);
    fake.emitRaw("{ this is not json }\n");
    expect(await wasClosed).toBe(GATEWAY_AUDIO_STREAM_CLOSE.upstreamFailure);
  });

  it("ends the endpoint's audio on a deliberate finish and closes normally", async () => {
    const { fake, gateway } = await streaming();
    const { socket } = await attached(gateway);
    await waitFor(() => fake.streamAttempts() === 1);
    socket.send(initializationFrame());
    socket.send(audioFrame(0, Uint8Array.from([7]), 0, 3_000));
    await waitFor(() => fake.received().length === 1);

    const finished = nextJson(socket);
    const wasClosed = closed(socket);
    socket.send(JSON.stringify({ type: "finish" }));
    expect(await finished).toEqual({ type: "finished" });
    expect(await wasClosed).toBe(1000);
    expect(fake.bodyEnded()).toBe(true);
  });
});
