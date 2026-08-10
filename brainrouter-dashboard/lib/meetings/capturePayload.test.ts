/**
 * ADR-035 D2/D3 — putting a meeting back together from what the store holds.
 *
 * The invariant under test throughout: **a segment's index is its chunk's
 * sequence.** The queue reads audio by index, so any drift here transcribes the
 * wrong audio into text that looks perfectly plausible — the one failure worse
 * than a stated gap, because nothing about it looks wrong.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { appendSegment, createCaptureSession, finalizeCapture, markDone, stopCapture } from "@kinqs/brainrouter-core/meetings";

import { parseCapturePayload, restoreCaptureSession, resumableCaptures, serializeCapturePayload } from "./capturePayload";
import type { CaptureChunkRef } from "./captureStorage";
import type { CaptureSessionRecord } from "./captureStore";

const SCOPE = { orgId: "org-1" as string | null };

function chunks(count: number, byteLength = 1024): CaptureChunkRef[] {
  return Array.from({ length: count }, (_unused, sequence) => ({ sequence, byteLength }));
}

function record(overrides: Partial<CaptureSessionRecord> = {}): CaptureSessionRecord {
  const held = overrides.chunks ?? chunks(0);
  return {
    sessionId: "mtg-1",
    startedAt: "2026-08-10T09:00:00.000Z",
    closed: false,
    payload: "",
    chunks: held,
    byteLength: held.reduce((total, chunk) => total + chunk.byteLength, 0),
    ...overrides,
  };
}

test("an unreadable payload leaves the audio beside it reachable", () => {
  assert.deepEqual(parseCapturePayload("{not json"), {});
  const restored = restoreCaptureSession({ record: record({ payload: "<<<", chunks: chunks(3) }), scope: SCOPE });
  assert.equal(restored.segments.length, 3);
  assert.equal(restored.id, "mtg-1");
});

test("a capture recorded before the session model existed still comes back, named", () => {
  // The manifests Phase 1 wrote carry a title and a mime type and nothing else.
  const legacy = JSON.stringify({ title: "Weekly sync", mimeType: "audio/webm" });
  const restored = restoreCaptureSession({ record: record({ payload: legacy, chunks: chunks(2) }), scope: SCOPE });
  assert.equal(restored.title, "Weekly sync");
  assert.equal(restored.segments.length, 2);
  assert.equal(restored.scope.orgId, "org-1");
});

test("a chunk the manifest never mentioned is adopted, not stranded", () => {
  // D1b: a closing tab gets very little time, so the write that was meant to
  // record the last segment is exactly the one that does not land.
  let session = createCaptureSession({ id: "mtg-1", scope: SCOPE, startedAt: "2026-08-10T09:00:00.000Z" });
  session = appendSegment(session, { byteLength: 1024, durationMs: 20_000 });
  const restored = restoreCaptureSession({
    record: record({ payload: serializeCapturePayload({ session }), chunks: chunks(3) }),
    scope: SCOPE,
  });
  assert.equal(restored.segments.length, 3);
  assert.deepEqual(restored.segments.map((segment) => segment.index), [0, 1, 2]);
});

// The adoption RULE is `adoptCaptureChunks` in the shared model and is tested
// there; what these check is that this host asks it, and asks it about what the
// store actually holds. The rule used to be written out here as well as on the
// desktop, with both copies admitting nothing kept them aligned.
test("adoption never invents a segment across a hole in the sequences", () => {
  // A missing chunk 1 must not make chunk 2 become segment 1: that segment would
  // then be transcribed from chunk 1's audio, and the text would look fine.
  const torn: CaptureChunkRef[] = [
    { sequence: 0, byteLength: 10 },
    { sequence: 2, byteLength: 10 },
  ];
  const restored = restoreCaptureSession({ record: record({ chunks: torn }), scope: SCOPE });
  assert.equal(restored.segments.length, 1);
});

test("adoption reads the store's order, not the order it was handed", () => {
  const shuffled: CaptureChunkRef[] = [
    { sequence: 2, byteLength: 30 },
    { sequence: 0, byteLength: 10 },
    { sequence: 1, byteLength: 20 },
  ];
  const restored = restoreCaptureSession({ record: record({ chunks: shuffled }), scope: SCOPE });
  assert.deepEqual(restored.segments.map((segment) => segment.byteLength), [10, 20, 30]);
});

test("adopting into a cleanly stopped capture keeps the moment it stopped", () => {
  let session = createCaptureSession({ id: "mtg-1", scope: SCOPE });
  session = appendSegment(session, { byteLength: 10, durationMs: 20_000 });
  session = stopCapture(session, "2026-08-10T09:30:00.000Z");
  const restored = restoreCaptureSession({
    record: record({ payload: serializeCapturePayload({ session }), chunks: chunks(2, 10) }),
    scope: SCOPE,
  });
  assert.equal(restored.status, "stopped");
  assert.equal(restored.stoppedAt, "2026-08-10T09:30:00.000Z");
  assert.equal(restored.segments.length, 2);
});

test("the recovery offer is scoped: another org's recording is not offered back here", () => {
  // Open question 5, reproduced and then refused. `resumableSessions` is the
  // shared predicate AND the scope; the store could only ever have restated the
  // first half, because it treats the payload as opaque text.
  const mine = createCaptureSession({ id: "mtg-mine", scope: SCOPE });
  const theirs = createCaptureSession({ id: "mtg-theirs", scope: { orgId: "org-elsewhere" } });
  const offered = resumableCaptures([
    record({ sessionId: "mtg-mine", payload: serializeCapturePayload({ session: mine }), chunks: chunks(1) }),
    record({ sessionId: "mtg-theirs", payload: serializeCapturePayload({ session: theirs }), chunks: chunks(1) }),
  ], { scope: SCOPE });
  assert.deepEqual(offered.map((entry) => entry.record.sessionId), ["mtg-mine"]);
});

test("the offer leaves out silence, settled meetings, and the recording in hand", () => {
  const finished = finalizeCapture(appendSegment(
    createCaptureSession({ id: "mtg-done", scope: SCOPE }),
    { byteLength: 10, durationMs: 20_000 },
  ));
  const offered = resumableCaptures([
    // Record pressed and cancelled a second later: an offer with nothing in it
    // is an offer users learn to dismiss.
    record({ sessionId: "mtg-empty", startedAt: "2026-08-10T11:00:00.000Z", chunks: [] }),
    record({ sessionId: "mtg-done", payload: serializeCapturePayload({ session: finished }), chunks: chunks(1) }),
    record({ sessionId: "mtg-live", startedAt: "2026-08-10T10:00:00.000Z", chunks: chunks(1) }),
    record({ sessionId: "mtg-old", startedAt: "2026-08-10T08:00:00.000Z", chunks: chunks(1) }),
  ], { scope: SCOPE, exclude: ["mtg-live"] });
  // Newest first, which is the order a person reads a recovery offer in.
  assert.deepEqual(offered.map((entry) => entry.record.sessionId), ["mtg-old"]);
});

test("a capture with no session payload is offered under the workspace in context", () => {
  // The degradation that has to stay: a recording from before the session model
  // existed carries no scope, so there is no other org it could belong to, and
  // withholding it would be losing a meeting to protect a field it never had.
  const offered = resumableCaptures([record({ chunks: chunks(1) })], { scope: SCOPE });
  assert.equal(offered.length, 1);
  assert.equal(offered[0]?.session.scope.orgId, "org-1");
});

test("text already transcribed survives the reload that rebuilt the queue", () => {
  let session = createCaptureSession({ id: "mtg-1", scope: SCOPE });
  session = appendSegment(session, { byteLength: 10, durationMs: 20_000 });
  session = markDone(session, 0, "the part we already have");
  const restored = restoreCaptureSession({
    record: record({ payload: serializeCapturePayload({ session }), chunks: chunks(2, 10) }),
    scope: SCOPE,
  });
  assert.equal(restored.segments[0]?.text, "the part we already have");
  assert.equal(restored.segments[0]?.state, "done");
  assert.equal(restored.segments[1]?.state, "pending");
});

test("a scope from another org is NOT rewritten to the one now in context", () => {
  // Open question 5 — the offer is exactly where a recording could silently
  // change hands, so restoring must not be the thing that moves it.
  const session = createCaptureSession({ id: "mtg-1", scope: { orgId: "org-elsewhere" } });
  const restored = restoreCaptureSession({
    record: record({ payload: serializeCapturePayload({ session }), chunks: chunks(1) }),
    scope: SCOPE,
  });
  assert.equal(restored.scope.orgId, "org-elsewhere");
});

test("a session whose segment indices have drifted is rejected rather than trusted", () => {
  const corrupt = JSON.stringify({
    session: {
      id: "mtg-1",
      startedAt: "2026-08-10T09:00:00.000Z",
      scope: { orgId: null },
      title: "Broken",
      template: "general",
      status: "recording",
      segments: [{ index: 4, byteLength: 10, startMs: 0, endMs: 1, state: "done", attempts: 1 }],
    },
  });
  assert.equal(parseCapturePayload(corrupt).session, undefined);
  // …and the audio still comes back, minted over the chunks that exist.
  const restored = restoreCaptureSession({ record: record({ payload: corrupt, chunks: chunks(2) }), scope: SCOPE });
  assert.equal(restored.segments.length, 2);
});

test("recovery corrects a segment left mid-attempt by the kill", () => {
  // ADR-028: "Transcribing…" on an attempt whose process is gone is the lie this
  // ADR exists to end. It keeps its spent attempt so the bound still means
  // something across restarts.
  let session = createCaptureSession({ id: "mtg-1", scope: SCOPE });
  session = appendSegment(session, { byteLength: 10, durationMs: 20_000 });
  const midAttempt = {
    ...session,
    segments: [{ ...session.segments[0]!, state: "transcribing" as const, attempts: 1 }],
  };
  const restored = restoreCaptureSession({
    record: record({ payload: serializeCapturePayload({ session: midAttempt }), chunks: chunks(1, 10) }),
    scope: SCOPE,
  });
  assert.equal(restored.status, "stopped");
  assert.equal(restored.segments[0]?.state, "failed");
  assert.equal(restored.segments[0]?.attempts, 1);
});
