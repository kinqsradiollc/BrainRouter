/**
 * ADR-035 D10 — capability discovery, and the one property that matters about
 * it: every unhappy answer is the SEGMENTED document.
 *
 * A probe that could reject would make discovery a new way to lose a meeting,
 * and a probe that guessed generously would hand a host a live promise the
 * endpoint cannot keep — which arrives as a connection failure a minute into
 * somebody's recording rather than as a sentence before it starts.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  createStreamingTranscriptionCapabilities,
  SEGMENTED_TRANSCRIPTION_CAPABILITIES,
  selectTranscriptionMode,
} from "@kinqs/brainrouter-core/meetings";

import {
  describeMeetingTranscriptionEndpoint,
  MEETING_CAPABILITIES_PATH,
  meetingStreamUrl,
} from "./transcriptionEndpoint";

interface Call {
  readonly url: string;
  readonly headers: Record<string, string>;
}

function answering(reply: () => Promise<Response> | Response): { readonly calls: Call[]; readonly fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: (init.headers ?? {}) as Record<string, string> });
    return await reply();
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("D10 — a complete v1 document selects the live path, and the request is authenticated and scoped", async () => {
  const advertised = createStreamingTranscriptionCapabilities(["low-latency", "balanced"]);
  const endpoint = answering(() => json(advertised));

  const described = await describeMeetingTranscriptionEndpoint({
    baseUrl: "https://brain.example",
    token: "jwt-abc",
    orgId: "org-a",
    fetchImpl: endpoint.fetchImpl,
  });

  assert.equal(selectTranscriptionMode(described), "streaming");
  assert.deepEqual(described, advertised);
  assert.deepEqual(endpoint.calls, [{
    url: `https://brain.example${MEETING_CAPABILITIES_PATH}`,
    // The same auth gate and the same tenant header the batch POST already uses:
    // a capability is a promise made to one tenant, not to the deployment.
    headers: { Authorization: "Bearer jwt-abc", "X-BrainRouter-Org": "org-a" },
  }]);
});

test("every unhappy answer is the segmented document, and none of them throws", async () => {
  const baseUrl = "https://brain.example";
  const cases: readonly (readonly [string, () => Promise<Response> | Response])[] = [
    ["a gateway too old to know the route", () => json({ error: "not found" }, 404)],
    ["a credential the gateway would not take", () => json({}, 401)],
    ["an error page rather than a document", () => new Response("<html>bad gateway</html>", { status: 502 })],
    // The status is part of the answer, not decoration. A gateway that is
    // REFUSING while echoing a perfectly well-formed promise — a cached body, a
    // proxy that replays the last good response under a 503 — is an endpoint
    // that cannot serve a stream right now, and reading only the body would take
    // the promise and discover the refusal a minute into somebody's recording.
    ["a refusal whose body still looks like a promise", () => json(createStreamingTranscriptionCapabilities(["low-latency"]), 503)],
    // A 200 whose BODY is not the exact contract. Core is the only thing that
    // decides this, and it fails closed on a partial or renamed document.
    ["a document missing part of the promise", () => json({ schemaVersion: 1, segmentedUpload: true, streaming: { persistent: true } })],
    ["a document from a version nobody agreed", () => json({ schemaVersion: 2, segmentedUpload: true, streaming: null })],
    ["a body that is not JSON at all", () => new Response("not json", { status: 200 })],
    ["a network that is not there", () => Promise.reject(new TypeError("fetch failed"))],
  ];

  for (const [why, reply] of cases) {
    const described = await describeMeetingTranscriptionEndpoint({ baseUrl, fetchImpl: answering(reply).fetchImpl });
    assert.deepEqual(described, SEGMENTED_TRANSCRIPTION_CAPABILITIES, why);
    assert.equal(selectTranscriptionMode(described), "segmented", why);
  }
});

test("an unauthenticated dev origin sends no headers it does not have", async () => {
  const endpoint = answering(() => json(SEGMENTED_TRANSCRIPTION_CAPABILITIES));
  await describeMeetingTranscriptionEndpoint({ baseUrl: "http://localhost:3747", fetchImpl: endpoint.fetchImpl });
  assert.deepEqual(endpoint.calls[0]!.headers, {});
});

test("the stream URL is the same origin, upgraded — and carries nothing the gateway refuses", () => {
  // A query string is rejected by the upgrade outright, which is also why the
  // bearer travels in the first frame instead: a token in a URL is written to
  // every proxy log between here and the server.
  assert.equal(meetingStreamUrl("https://brain.example"), "wss://brain.example/v1/audio/transcriptions/stream");
  assert.equal(meetingStreamUrl("http://localhost:3747"), "ws://localhost:3747/v1/audio/transcriptions/stream");
  assert.equal(meetingStreamUrl("https://brain.example/"), "wss://brain.example/v1/audio/transcriptions/stream");
  assert.equal(meetingStreamUrl("https://brain.example").includes("?"), false);
});
