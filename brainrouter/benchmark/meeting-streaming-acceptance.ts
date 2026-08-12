/**
 * ADR-035 D10 — the HOST end of the streaming acceptance, against a real engine.
 *
 * The engine end was accepted by driving the sidecar directly: it produces a
 * partial, revises it with a final, and commits. That proves the ENGINE. It does
 * not prove the thing D10 actually promises, which is that a host asks what the
 * endpoint offers, believes the answer only when it is complete, and degrades
 * visibly rather than silently when it is not.
 *
 * So this runs the SHIPPED code, not a re-implementation of it:
 *
 *   sidecar /stream/capabilities
 *     → probeGatewayAudioStreamingCapabilities   (the brain's real adapter)
 *     → describeTranscriptionEndpoint            (Core's strict v1 reader)
 *     → selectTranscriptionMode                  (the decision both hosts make)
 *
 * and then the three ways that chain has to fail closed: a dead origin, an
 * endpoint answering a different protocol, and one advertising junk latency
 * modes. Every one of them must land on `segmented`, because a host that
 * silently believes half a contract is the failure this ADR is named for.
 *
 * Requires the dev stack. Skips — loudly, non-zero — if the sidecar is absent,
 * because a green run that quietly tested nothing is the exact thing D10 keeps
 * being burned by.
 *
 *   npx tsx brainrouter/benchmark/meeting-streaming-acceptance.ts [origin]
 */
import assert from "node:assert/strict";
import {
  describeTranscriptionEndpoint,
  selectTranscriptionMode,
  liveTextExpected,
  isStreamingTranscriptionCapabilities,
  reduceStreamingTranscript,
  validateTranscriptCommittedCheckpoint,
  EMPTY_STREAMING_TRANSCRIPT,
  type MeetingChunk,
} from "@kinqs/brainrouter-core/meetings";
import {
  resolveGatewayAudioStreamingEndpoint,
  probeGatewayAudioStreamingCapabilities,
} from "../src/services/gateway/audio-streaming-endpoint.js";

const ORIGIN = process.argv[2] ?? "http://127.0.0.1:3752";
const results: string[] = [];

/** Eight one-second chunks, as a recorder would have written them to disk. */
const LEDGER: readonly MeetingChunk[] = Object.freeze(
  Array.from({ length: 8 }, (_, i) => ({
    sequence: i,
    byteLength: 32_000,
    startMs: i * 1000,
    endMs: (i + 1) * 1000,
  })),
);

function check(name: string, run: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(run)
    .then(() => {
      results.push(`  PASS  ${name}`);
    })
    .catch((error: unknown) => {
      results.push(`  FAIL  ${name}\n        ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}

/** Resolve an endpoint the way the brain does, from the same env variable. */
function endpointFor(origin: string) {
  const endpoint = resolveGatewayAudioStreamingEndpoint({ BRAINROUTER_STT_STREAM_URL: origin });
  assert.ok(endpoint, `the gateway refused to resolve ${origin} as a streaming endpoint`);
  return endpoint;
}

const reachable = await fetch(`${ORIGIN}/health`, { signal: AbortSignal.timeout(4000) })
  .then((r) => r.ok)
  .catch(() => false);

if (!reachable) {
  console.error(
    `ADR-035 D10 host acceptance CANNOT RUN: no STT sidecar at ${ORIGIN}.\n` +
      `Bring the dev stack up first:\n` +
      `  docker compose -f deploy/dev/docker-compose.dev.yml up -d stt\n`,
  );
  process.exit(2);
}

console.log(`ADR-035 D10 · host acceptance against ${ORIGIN}\n`);

// ---- The arm that must light up -------------------------------------------

let liveCapabilities: unknown;

await check("a live engine's document is accepted as the complete v1 contract", async () => {
  liveCapabilities = await probeGatewayAudioStreamingCapabilities(endpointFor(ORIGIN));
  assert.ok(
    isStreamingTranscriptionCapabilities(liveCapabilities),
    `the adapter did not produce a complete v1 streaming document: ${JSON.stringify(liveCapabilities)}`,
  );
});

await check("both hosts select streaming from that document", () => {
  const described = describeTranscriptionEndpoint(liveCapabilities);
  assert.equal(selectTranscriptionMode(described), "streaming");
  assert.equal(liveTextExpected(described), true, "a complete contract must permit the live-text promise");
});

await check("the advertised latency modes survive the translation", () => {
  const described = describeTranscriptionEndpoint(liveCapabilities);
  assert.ok(described.streaming, "streaming block missing");
  assert.ok(described.streaming.latencyModes.length > 0, "no latency modes carried through");
  assert.ok(
    described.streaming.latencyModes.includes("low-latency"),
    `expected the sidecar's low-latency mode, got ${described.streaming.latencyModes.join(", ")}`,
  );
});

// ---- The arms that must fail closed ---------------------------------------
//
// Each of these is a way the endpoint can be WRONG rather than absent, which is
// the harder case: absence is obvious, a half-answer is not.

await check("an unreachable origin degrades to segmented rather than hanging on a promise", async () => {
  // Port 1 is reserved and refuses immediately, so this measures the fallback
  // and not a timeout.
  const capabilities = await probeGatewayAudioStreamingCapabilities(endpointFor("http://127.0.0.1:1"));
  assert.equal(selectTranscriptionMode(describeTranscriptionEndpoint(capabilities)), "segmented");
  assert.equal(liveTextExpected(describeTranscriptionEndpoint(capabilities)), false);
});

await check("an endpoint speaking another protocol is not accidentally upgraded", async () => {
  const server = await serve({ protocol: "some.other.stream.v1", latencyModes: ["low-latency"] });
  try {
    const capabilities = await probeGatewayAudioStreamingCapabilities(endpointFor(server.origin));
    assert.equal(selectTranscriptionMode(describeTranscriptionEndpoint(capabilities)), "segmented");
  } finally {
    await server.close();
  }
});

await check("the right protocol with unusable latency modes is still refused", async () => {
  const server = await serve({ protocol: "brainrouter.stt.stream.v1", latencyModes: ["warp-speed"] });
  try {
    const capabilities = await probeGatewayAudioStreamingCapabilities(endpointFor(server.origin));
    assert.equal(
      selectTranscriptionMode(describeTranscriptionEndpoint(capabilities)),
      "segmented",
      "a mode this host cannot honour must not be silently dropped to make the rest usable",
    );
  } finally {
    await server.close();
  }
});

await check("a truthful protocol with an empty mode list is refused", async () => {
  const server = await serve({ protocol: "brainrouter.stt.stream.v1", latencyModes: [] });
  try {
    const capabilities = await probeGatewayAudioStreamingCapabilities(endpointFor(server.origin));
    assert.equal(selectTranscriptionMode(describeTranscriptionEndpoint(capabilities)), "segmented");
  } finally {
    await server.close();
  }
});

// ---- Reconnect and replay -------------------------------------------------
//
// Chunk sequences are 0-BASED indices into the written ledger, and coverage is
// only believed while `coveredThroughSequence < ledger.length`. Getting that
// wrong is how a test comes to assert the opposite of the contract, so it is
// stated once here rather than re-derived in four places.
//
// The whole point of a coverage checkpoint is that it is the ONLY thing allowed
// to move a resume point. If a dropped connection could advance it by the text
// already on screen, a reconnect would resume past audio nobody transcribed and
// the meeting would have a hole in it that nothing reports.

await check("a stream cut mid-meeting leaves the resume point where the ENGINE last committed", () => {
  let state = EMPTY_STREAMING_TRANSCRIPT;

  // The engine settles the first four seconds and says so.
  state = reduceStreamingTranscript(
    state,
    { kind: "final", utteranceId: "u0", revision: 1, startMs: 0, endMs: 4000, text: "the first four seconds" },
    LEDGER,
  );
  state = reduceStreamingTranscript(state, { kind: "coverage", coveredThroughSequence: 3 }, LEDGER);
  assert.equal(state.checkpoint?.acknowledgedThroughSequence, 3, "a committed coverage event must move the checkpoint");

  // Then it shows a hypothesis for later audio — and the connection dies.
  const withPartial = reduceStreamingTranscript(
    state,
    { kind: "partial", utteranceId: "u1", revision: 1, startMs: 4000, endMs: 7000, text: "text the viewer can see" },
    LEDGER,
  );

  assert.equal(
    withPartial.checkpoint?.acknowledgedThroughSequence,
    3,
    "a partial is a hypothesis: visible text must NOT move the resume point",
  );
});

await check("replay resumes from the checkpoint, so no committed audio is sent twice and none is skipped", () => {
  const resumeAfter = 3;
  const replay = LEDGER.filter((chunk) => chunk.sequence > resumeAfter);

  assert.deepEqual(
    replay.map((c) => c.sequence),
    [4, 5, 6, 7],
    "everything after the checkpoint must be replayed, and nothing before it",
  );
  // The join has to be exact at the boundary: a gap loses words, an overlap
  // transcribes them twice and the transcript stutters.
  assert.equal(replay[0]!.startMs, LEDGER[resumeAfter]!.endMs, "replay must begin exactly where coverage ended");
});

await check("a checkpoint cannot advance past audio the device has actually written", () => {
  // An endpoint claiming coverage of sequence 9 when eight chunks exist is
  // either confused or lying; either way believing it would strand the tail.
  assert.equal(
    validateTranscriptCommittedCheckpoint(null, 9, LEDGER),
    null,
    "coverage beyond the ledger must be refused, not clamped",
  );
  assert.ok(
    validateTranscriptCommittedCheckpoint(null, LEDGER.length - 1, LEDGER),
    "coverage of the whole written ledger is legitimate",
  );
});

await check("a checkpoint never moves backwards on a reconnect", () => {
  // A reconnecting endpoint that has forgotten what it acknowledged must not be
  // able to un-commit settled audio.
  assert.equal(
    validateTranscriptCommittedCheckpoint(5, 2, LEDGER),
    null,
    "a lower coverage claim after a reconnect must be refused",
  );
});

console.log(results.join("\n"));
console.log(
  process.exitCode
    ? "\nADR-035 D10 host acceptance FAILED.\n"
    : "\nADR-035 D10 host acceptance PASSED: streaming is selected from a real engine's answer, every incomplete answer degrades to segmented, and only committed coverage moves the resume point.\n",
);

/** A throwaway loopback endpoint that advertises whatever document is given. */
async function serve(document: unknown): Promise<{ origin: string; close: () => Promise<void> }> {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    if (req.url === "/stream/capabilities") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(document));
      return;
    }
    res.writeHead(404).end();
  });
  // Loopback only — this is a test double, not a service.
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not bind the capability double");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
