/**
 * ADR-035 D10 endpoint-gate guards: production stays segmented until an operator
 * names a streaming endpoint, an unusable value is the same as none, and the
 * advertisement follows what the endpoint actually confirms.
 */
import { SEGMENTED_TRANSCRIPTION_CAPABILITIES } from "@kinqs/brainrouter-core/meetings";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createGatewayAudioCapabilityCache,
  probeGatewayAudioStreamingCapabilities,
  resolveGatewayAudioStreamingEndpoint,
  type GatewayAudioStreamingEndpoint,
} from "./audio-streaming-endpoint.js";
import { startFakeSidecar, type FakeSidecar } from "./audio-streaming-sidecar-harness.js";

const sidecars: FakeSidecar[] = [];

afterEach(async () => {
  for (const sidecar of sidecars.splice(0)) await sidecar.close();
});

async function sidecar(options: Parameters<typeof startFakeSidecar>[0] = {}): Promise<FakeSidecar> {
  const started = await startFakeSidecar(options);
  sidecars.push(started);
  return started;
}

function endpointFor(fake: FakeSidecar): GatewayAudioStreamingEndpoint {
  const endpoint = resolveGatewayAudioStreamingEndpoint({ BRAINROUTER_STT_STREAM_URL: fake.url });
  if (!endpoint) throw new Error("endpoint did not resolve");
  return endpoint;
}

describe("gateway streaming endpoint gate", () => {
  it("stays off unless an operator names an endpoint", () => {
    expect(resolveGatewayAudioStreamingEndpoint({})).toBeNull();
    expect(resolveGatewayAudioStreamingEndpoint({ BRAINROUTER_STT_STREAM_URL: "   " })).toBeNull();
  });

  it("treats an unusable value as no endpoint rather than a guess", () => {
    for (const value of [
      "not a url",
      "ftp://stt:3752",
      "http://user:secret@stt:3752",
      "http://stt:3752/?token=abc",
      "http://stt:3752/#fragment",
    ]) {
      expect(resolveGatewayAudioStreamingEndpoint({ BRAINROUTER_STT_STREAM_URL: value })).toBeNull();
    }
  });

  it("derives both paths and an origin-exact policy from the configured base", () => {
    const endpoint = resolveGatewayAudioStreamingEndpoint({ BRAINROUTER_STT_STREAM_URL: "http://stt:3752/" });
    expect(endpoint).toMatchObject({
      origin: "http://stt:3752",
      streamPath: "/stream",
      capabilitiesPath: "/stream/capabilities",
      policy: { mode: "self-hosted", allowlist: ["http://stt:3752"] },
    });
  });

  it("bounds the timeout and falls back on garbage", () => {
    const read = (raw: string | undefined): number =>
      resolveGatewayAudioStreamingEndpoint({ BRAINROUTER_STT_STREAM_URL: "http://stt:3752", BRAINROUTER_STT_STREAM_TIMEOUT_MS: raw })!
        .timeoutMs;
    expect(read(undefined)).toBe(15_000);
    expect(read("nonsense")).toBe(15_000);
    expect(read("0")).toBe(15_000);
    expect(read("-5")).toBe(15_000);
    expect(read("120")).toBe(1_000);
    expect(read("30000")).toBe(30_000);
    expect(read("9999999")).toBe(120_000);
  });
});

describe("gateway streaming capability probe", () => {
  it("advertises exactly the modes the endpoint confirms", async () => {
    const fake = await sidecar({ modes: ["balanced", "low-latency"] });
    expect(await probeGatewayAudioStreamingCapabilities(endpointFor(fake))).toEqual({
      schemaVersion: 1,
      segmentedUpload: true,
      streaming: {
        persistent: true,
        partialResults: true,
        serverBoundaries: true,
        coverageCheckpoints: true,
        resumable: true,
        latencyModes: ["balanced", "low-latency"],
      },
    });
  });

  it("falls back to segmented for a foreign protocol, an unknown mode, a failure, and garbage", async () => {
    for (const options of [
      { protocol: "some.other.stream.v1" },
      { modes: ["instant"] },
      { modes: [] as string[] },
      { capabilitiesStatus: 500 },
      { capabilitiesBody: "<html>not json</html>" },
    ]) {
      const fake = await sidecar(options);
      expect(await probeGatewayAudioStreamingCapabilities(endpointFor(fake))).toEqual(
        SEGMENTED_TRANSCRIPTION_CAPABILITIES,
      );
    }
  });

  it("falls back to segmented when the endpoint is not there at all", async () => {
    const fake = await sidecar();
    const endpoint = endpointFor(fake);
    await fake.close();
    sidecars.length = 0;
    expect(await probeGatewayAudioStreamingCapabilities(endpoint)).toEqual(SEGMENTED_TRANSCRIPTION_CAPABILITIES);
  });
});

describe("gateway streaming capability cache", () => {
  const endpoint = resolveGatewayAudioStreamingEndpoint({ BRAINROUTER_STT_STREAM_URL: "http://stt:3752" })!;
  const streaming = {
    schemaVersion: 1,
    segmentedUpload: true,
    streaming: {
      persistent: true,
      partialResults: true,
      serverBoundaries: true,
      coverageCheckpoints: true,
      resumable: true,
      latencyModes: ["balanced"],
    },
  } as const;

  it("probes once for concurrent and repeated reads inside the window", async () => {
    let at = 1_000;
    const probe = vi.fn(async () => streaming);
    const read = createGatewayAudioCapabilityCache(endpoint, () => at, probe as never);
    expect(await Promise.all([read(), read()])).toEqual([streaming, streaming]);
    at = 9_000;
    expect(await read()).toEqual(streaming);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("re-probes once the window has passed, so a recovered endpoint is advertised again", async () => {
    let at = 1_000;
    const probe = vi
      .fn()
      .mockResolvedValueOnce(SEGMENTED_TRANSCRIPTION_CAPABILITIES)
      .mockResolvedValueOnce(streaming);
    const read = createGatewayAudioCapabilityCache(endpoint, () => at, probe as never);
    expect(await read()).toEqual(SEGMENTED_TRANSCRIPTION_CAPABILITIES);
    at = 11_500;
    expect(await read()).toEqual(streaming);
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
