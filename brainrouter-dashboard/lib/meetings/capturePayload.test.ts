/**
 * ADR-035 D2/D3/D9 — putting a meeting back together from what the store holds.
 *
 * The invariant under test throughout: **a transcription unit names every
 * durability chunk it spans.** The queue reads those keys in order, so any
 * drift here transcribes incomplete or wrong audio into plausible text — the
 * one failure worse than a stated gap, because nothing about it looks wrong.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  appendChunk,
  appendSegment,
  createCaptureSession,
  finalizeCapture,
  markDone,
  sealUnit,
  stopCapture,
  type MeetingCaptureSession,
} from "@kinqs/brainrouter-core/meetings";

import {
  parseCapturePayload,
  restoreCaptureSession,
  resumableCaptures,
  serializeCapturePayload,
} from "./capturePayload";
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
  assert.equal(restored.segments.length, 3, "a record with no ledger retains the old one-chunk-per-unit cadence");
  assert.equal(restored.id, "mtg-1");
});

test("D9 — a kill before the first unit seals every durable chunk during recovery", () => {
  let session = createCaptureSession({
    id: "mtg-1",
    scope: SCOPE,
    startedAt: "2026-08-10T09:00:00.000Z",
  });
  session = appendChunk(session, { byteLength: 1024, durationMs: 3_000 });
  assert.equal(session.segments.length, 0, "the durability write is not yet a transcription boundary");

  const restored = restoreCaptureSession({
    record: record({ payload: serializeCapturePayload({ session }), chunkMs: 3_000, chunks: chunks(1) }),
    scope: SCOPE,
    at: "2026-08-10T09:00:03.000Z",
  });

  assert.equal(restored.status, "stopped");
  assert.deepEqual(restored.segments[0]?.chunks, [0]);
  assert.equal(restored.segments[0]?.byteLength, 1024);
  assert.equal(restored.segments[0]?.endMs, 3_000, "the recovered unit covers the audio written before the kill");
});

test("D9 — corrupt current unit references fall back to every physical chunk at the marked cadence", () => {
  let session = createCaptureSession({ id: "mtg-1", scope: SCOPE });
  session = appendChunk(session, { byteLength: 10, durationMs: 3_000 });
  session = appendChunk(session, { byteLength: 20, durationMs: 3_000 });
  session = sealUnit(session);
  const payload = serializeCapturePayload({ session });

  assert.deepEqual(parseCapturePayload(payload).session?.chunks?.map((chunk) => chunk.sequence), [0, 1]);
  assert.deepEqual(parseCapturePayload(payload).session?.segments[0]?.chunks, [0, 1]);

  const parsed = JSON.parse(payload) as { session: MeetingCaptureSession };
  parsed.session = {
    ...parsed.session,
    segments: [{ ...parsed.session.segments[0]!, chunks: [0] }],
  };
  assert.equal(
    parseCapturePayload(JSON.stringify(parsed)).session,
    undefined,
    "a unit that silently drops its second referenced chunk is not trusted",
  );

  const restored = restoreCaptureSession({
    record: record({
      payload: JSON.stringify(parsed),
      chunkMs: 3_000,
      // Listing a chunk does not promise its bytes can currently be read. The
      // restore must still retain every physical reference so playback can name
      // an unreadable one instead of losing it with the corrupt session JSON.
      chunks: chunks(8, 10),
    }),
    scope: SCOPE,
  });
  assert.deepEqual(restored.chunks?.map((chunk) => chunk.sequence), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(restored.segments.map((segment) => segment.chunks), [
    [0, 1, 2, 3, 4, 5, 6],
    [7],
  ]);
  assert.deepEqual(restored.segments.map((segment) => segment.endMs), [21_000, 24_000]);
});

test("a corrupt current capture keeps its original tenant metadata and cannot move with the switcher", () => {
  const originalScope = { orgId: "org-a", workspaceId: "workspace-a" };
  const currentScope = { orgId: "org-b", workspaceId: "workspace-b" };
  let session = createCaptureSession({
    id: "mtg-1",
    startedAt: "2026-08-09T07:30:00.000Z",
    scope: originalScope,
    title: "Original planning session",
    template: "retrospective",
    language: "en-AU",
  });
  session = appendChunk(session, { byteLength: 10, durationMs: 3_000 });
  session = appendChunk(session, { byteLength: 10, durationMs: 3_000 });
  session = sealUnit(session);
  const damaged = {
    ...session,
    // Neither terminality nor this unit claim is trusted during salvage.
    status: "finalized",
    closedAt: "2039-01-01T00:00:00.000Z",
    segments: [{ ...session.segments[0]!, chunks: [0] }],
  };
  const held = record({
    startedAt: "2026-08-10T07:30:00.000Z",
    chunkMs: 3_000,
    chunks: chunks(8, 10),
    payload: JSON.stringify({ session: damaged }),
  });
  assert.equal(parseCapturePayload(held.payload).session, undefined, "the corrupt state is not accepted as a session");

  const restored = restoreCaptureSession({
    record: held,
    scope: currentScope,
    at: "2026-08-11T10:00:00.000Z",
  });
  assert.deepEqual(restored.scope, originalScope);
  assert.equal(restored.title, "Original planning session");
  assert.equal(restored.template, "retrospective");
  assert.equal(restored.language, "en-AU");
  assert.equal(restored.startedAt, "2026-08-09T07:30:00.000Z");
  assert.equal(restored.status, "stopped", "a corrupt terminal status is not carried over");
  assert.equal(restored.stoppedAt, "2026-08-11T10:00:00.000Z");
  assert.equal(restored.closedAt, undefined, "a corrupt terminal timestamp is not carried over");
  assert.deepEqual(restored.chunks?.map((chunk) => chunk.sequence), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(restored.segments.map((segment) => segment.chunks), [[0, 1, 2, 3, 4, 5, 6], [7]]);
  assert.deepEqual(resumableCaptures([held], { scope: currentScope }), [], "org B cannot be offered org A's capture");
  assert.equal(resumableCaptures([held], { scope: originalScope }).length, 1, "the original tenant can still recover it");
});

for (const status of ["finalized", "discarded"] as const) {
  test(`a live session changed only to ${status} without terminal stamps is salvaged`, () => {
    let session = createCaptureSession({
      id: "mtg-1",
      scope: { orgId: "org-a" },
      title: "Lifecycle integrity",
    });
    session = appendChunk(session, { byteLength: 10, durationMs: 3_000 });
    const damaged = { ...session, status };
    const held = record({
      payload: JSON.stringify({ session: damaged }),
      chunkMs: 3_000,
      chunks: chunks(1, 10),
    });

    assert.equal(
      parseCapturePayload(held.payload).session,
      undefined,
      "a terminal status without stoppedAt and closedAt is not a valid session",
    );
    const restored = restoreCaptureSession({
      record: held,
      scope: { orgId: "org-b" },
      at: "2026-08-11T10:00:00.000Z",
    });
    assert.equal(restored.status, "stopped");
    assert.equal(restored.stoppedAt, "2026-08-11T10:00:00.000Z");
    assert.equal(restored.closedAt, undefined);
    assert.equal(restored.scope.orgId, "org-a", "bounded matching-id metadata survives lifecycle salvage");
    assert.deepEqual(restored.chunks?.map((chunk) => chunk.sequence), [0]);
  });
}

test("corrupt metadata is ignored when its raw session id does not match the physical record", () => {
  const payload = JSON.stringify({
    session: {
      id: "mtg-someone-else",
      startedAt: "2026-01-01T00:00:00.000Z",
      scope: { orgId: "org-a" },
      title: "Another recording",
      template: "standup",
      language: "en-AU",
      status: "recording",
      segments: "corrupt",
    },
  });
  const restored = restoreCaptureSession({
    record: record({ payload, chunkMs: 3_000, chunks: chunks(1) }),
    scope: { orgId: "org-b" },
  });
  assert.equal(restored.scope.orgId, "org-b");
  assert.equal(restored.title, "Untitled meeting");
  assert.equal(restored.template, "general");
  assert.equal(restored.language, undefined);
});

test("matching corrupt metadata is retained field-by-field only inside its bounds", () => {
  const payload = JSON.stringify({
    session: {
      id: "mtg-1",
      startedAt: "x".repeat(65),
      scope: { orgId: "org-a", workspaceId: "workspace-a" },
      title: "x".repeat(501),
      template: "not-a-template",
      language: "x".repeat(65),
      status: "recording",
      segments: "corrupt",
    },
  });
  const restored = restoreCaptureSession({
    record: record({ payload, chunkMs: 3_000, chunks: chunks(1) }),
    scope: { orgId: "org-b" },
    template: "standup",
    language: "fr",
  });
  assert.deepEqual(restored.scope, { orgId: "org-a", workspaceId: "workspace-a" }, "the bounded tenant identity survives");
  assert.equal(restored.title, "Untitled meeting", "an overlong title is not carried");
  assert.equal(restored.template, "standup", "an unknown template is not carried");
  assert.equal(restored.language, "fr", "an overlong language tag is not carried");
  assert.equal(restored.startedAt, "2026-08-10T09:00:00.000Z", "an invalid raw instant falls back to the bounded manifest instant");
});

test("an invalid present cadence marker falls back to D9 rather than legacy timing", () => {
  const restored = restoreCaptureSession({
    record: record({ payload: "<<<", chunkMs: 20_000, chunks: chunks(7, 10) }),
    scope: SCOPE,
  });
  assert.deepEqual(restored.segments.map((segment) => segment.chunks), [[0, 1, 2, 3, 4, 5, 6]]);
  assert.equal(restored.segments[0]?.endMs, 21_000, "an invalid marker must not stretch seven current chunks to 140 seconds");
});

test("a capture recorded before the session model existed still comes back, named", () => {
  // The manifests Phase 1 wrote carry a title and a mime type and nothing else.
  const legacy = JSON.stringify({ title: "Weekly sync", mimeType: "audio/webm" });
  const restored = restoreCaptureSession({ record: record({ payload: legacy, chunks: chunks(2) }), scope: SCOPE });
  assert.equal(restored.title, "Weekly sync");
  assert.equal(restored.segments.length, 2);
  assert.equal(restored.scope.orgId, "org-1");
});

test("a legacy orphan chunk keeps the pre-D9 duration when it is adopted", () => {
  // D1b: a closing tab gets very little time, so the write that was meant to
  // record the last segment is exactly the one that does not land.
  const minted = createCaptureSession({ id: "mtg-1", scope: SCOPE, startedAt: "2026-08-10T09:00:00.000Z" });
  const { chunks: _newLedger, ...legacy } = minted;
  let session: MeetingCaptureSession = legacy;
  session = appendSegment(session, { byteLength: 1024, durationMs: 20_000 });
  const restored = restoreCaptureSession({
    record: record({ payload: serializeCapturePayload({ session }), chunks: chunks(3) }),
    scope: SCOPE,
  });
  assert.equal(restored.segments.length, 3);
  assert.deepEqual(restored.segments.map((segment) => segment.index), [0, 1, 2]);
  assert.deepEqual(restored.segments[1]?.chunks, [1]);
  assert.deepEqual(restored.segments[2]?.chunks, [2]);
  assert.equal(restored.segments[2]?.endMs, 60_000, "forcing the D9 3s default here must fail this guard");
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

test("D6 — a lease left in a record by an older build is read and DROPPED", () => {
  // §6's headline failure came from this field. Liveness used to be a heartbeat
  // stamp in the payload, and a tab killed one second ago leaves one that still
  // looks fresh — so the recovered meeting was withheld from the offer for the
  // whole of the old staleness window, on a surface that asks once and never
  // asks again. The answer moved to `captureLock.ts`, where a dead tab's claim
  // is gone the instant the tab is, and a stamp found here must not be able to
  // speak.
  const at = "2026-08-10T09:00:10.000Z";
  let session = createCaptureSession({ id: "mtg-1", startedAt: "2026-08-10T09:00:00.000Z", scope: SCOPE });
  session = appendSegment(session, { byteLength: 1024, durationMs: 20_000 });
  // Written out by hand rather than produced by `acquireCaptureLease`, which no
  // longer exists: a migration fixture has to keep saying what the OLD build
  // wrote long after the code that wrote it is deleted. The stamp is nine
  // seconds old at `at`, which the old thirty-second threshold read as live.
  const lease = { holderId: "wr-killed", holder: "Another tab", epoch: 1, heartbeatAt: "2026-08-10T09:00:01.000Z" };
  // Exactly what the previous build wrote: the lease inside the session AND
  // mirrored at the top level of the envelope.
  const legacy = JSON.stringify({ session: { ...session, writer: lease }, writer: lease });

  const restored = restoreCaptureSession({ record: record({ payload: legacy, chunks: chunks(1) }), scope: SCOPE, at });
  assert.equal((restored as { writer?: unknown }).writer, undefined, "the stamp does not survive into the session");
  assert.equal(restored.segments.length, 1, "and the meeting itself comes back untouched");
  // One second after the kill, with no threshold waited out and nothing re-asked.
  assert.deepEqual(
    resumableCaptures([record({ payload: legacy, chunks: chunks(1) })], { scope: SCOPE, at }).map((entry) => entry.record.sessionId),
    ["mtg-1"],
    "the killed tab's recording is offered back on the FIRST check",
  );
});

test("nothing writes liveness into the envelope any more", () => {
  // A `writer` here would be a second, slower opinion about a fact the browser
  // states exactly — and the offer would start honouring it again the moment
  // somebody restored the field.
  const session = createCaptureSession({ id: "mtg-1", scope: SCOPE });
  const payload = serializeCapturePayload({ title: "Weekly sync", mimeType: "audio/webm", session });
  assert.deepEqual(Object.keys(JSON.parse(payload)).sort(), ["mimeType", "session", "title"]);
  assert.equal("writer" in parseCapturePayload(payload), false);
});

test("the offer judges freshness and stamps recovery from ONE reading of the clock", () => {
  // Two readings a millisecond apart would be harmless; two a test cannot pin
  // are not, now that "is somebody writing to this?" is part of the answer.
  const at = "2026-08-10T10:00:00.000Z";
  let session = createCaptureSession({ id: "mtg-1", startedAt: "2026-08-10T09:00:00.000Z", scope: SCOPE });
  session = appendSegment(session, { byteLength: 1024, durationMs: 20_000 });
  const offered = resumableCaptures(
    [record({ payload: serializeCapturePayload({ session }), chunks: chunks(1) })],
    { scope: SCOPE, at },
  );
  assert.equal(offered.length, 1);
  assert.equal(offered[0].session.stoppedAt, at, "the recovery stamp is the instant the offer was judged at");
});

test("open question 5 + D6 — a capture being written is not offered back, whoever asks", () => {
  // "Nobody is writing to it" is still half of D2's rule; what changed is where
  // the answer comes from. The record cannot hold it — a stamp is only ever a
  // guess about a tab that may already be gone — so the caller asks the browser
  // and hands the live ids in as `exclude`.
  const at = "2026-08-10T09:00:10.000Z";
  let session = createCaptureSession({ id: "mtg-1", startedAt: "2026-08-10T09:00:00.000Z", scope: SCOPE });
  session = appendSegment(session, { byteLength: 1024, durationMs: 20_000 });
  const live = record({ payload: serializeCapturePayload({ session }), chunks: chunks(1) });

  assert.deepEqual(
    resumableCaptures([live], { scope: SCOPE, at, exclude: ["mtg-1"] }),
    [],
    "not while a tab holds the lock for it",
  );
  // …and the instant that tab lets go — or dies, which is the same thing to the
  // browser — the recording is offered back. No threshold, no second check.
  assert.deepEqual(
    resumableCaptures([live], { scope: SCOPE, at }).map((entry) => entry.record.sessionId),
    ["mtg-1"],
  );
});
