/**
 * ADR-035 D9/D10 — turning a coverage proof into durable transcript, asserted on
 * the SESSION that results rather than on the calls that produced it.
 *
 * Every case here is one of the two ways this can be silently wrong: words that
 * land in the wrong unit (or in none), and audio that ends up transcribed twice
 * because a chunk another strategy already claimed was sealed again.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  appendChunk,
  createCaptureSession,
  transcriptSoFar,
  type MeetingCaptureSession,
  type MeetingLiveUtterance,
} from "@kinqs/brainrouter-core/meetings";

import { commitStreamedCoverage } from "./streamCommit";

/** A recording of `count` three-second durability chunks, as D9 writes them. */
function recording(count: number): MeetingCaptureSession {
  let session = createCaptureSession({ id: "mtg-stream", startedAt: "2026-08-01T09:00:00.000Z", scope: { orgId: "org-a" } });
  for (let index = 0; index < count; index += 1) {
    session = appendChunk(session, { byteLength: 1_024, durationMs: 3_000 });
  }
  return session;
}

function final(utteranceId: string, text: string, startMs: number, endMs: number): MeetingLiveUtterance {
  return { kind: "final", state: "final", utteranceId, revision: 0, text, startMs, endMs };
}

function partial(utteranceId: string, text: string, startMs: number, endMs: number): MeetingLiveUtterance {
  return { kind: "partial", state: "partial", utteranceId, revision: 3, text, startMs, endMs };
}

/** Only what a reader of the meeting would see: one line per unit. */
function settledText(session: MeetingCaptureSession): readonly string[] {
  return transcriptSoFar(session).map((entry) => (entry.kind === "settled" ? entry.text : `<${entry.kind}>`));
}

test("D10 — a coverage proof seals the proven run and settles it with the words that START in it", () => {
  const session = recording(4);
  const committed = commitStreamedCoverage(session, 1, [
    final("u0", "good morning", 0, 2_000),
    // Begins inside the proven run and runs past its end. It belongs to THIS
    // unit: bucketing by where an utterance ENDS would drop it out of the
    // transcript entirely, because the next commit buckets by start too.
    final("u1", "everyone", 5_000, 7_400),
    final("u2", "not yet proven", 6_400, 8_000),
  ]);

  assert.equal(committed.segments.length, 1, "one unit for the endpoint's own boundary");
  assert.deepEqual(committed.segments[0]!.chunks, [0, 1]);
  assert.equal(committed.segments[0]!.startMs, 0);
  assert.equal(committed.segments[0]!.endMs, 6_000);
  assert.equal(committed.segments[0]!.state, "done");
  assert.deepEqual(settledText(committed), ["good morning everyone"]);
});

test("a partial never becomes durable transcript — only coverage says the words are final", () => {
  const committed = commitStreamedCoverage(recording(2), 0, [
    partial("u0", "half a sen", 0, 1_400),
    final("u1", "a whole one", 1_400, 2_800),
  ]);
  assert.deepEqual(settledText(committed), ["a whole one"]);
});

test("audio another strategy already claimed is NOT re-sealed, so no range is transcribed twice", () => {
  const session = recording(6);
  const first = commitStreamedCoverage(session, 1, [final("u0", "first stretch", 0, 5_000)]);
  // The same proof again — a duplicate frame is an ordinary distributed-systems
  // event, not a reason to write the meeting twice.
  const repeated = commitStreamedCoverage(first, 1, [final("u9", "SHOULD NOT APPEAR", 0, 5_000)]);
  assert.equal(repeated, first, "nothing was open, so nothing was sealed");

  const second = commitStreamedCoverage(first, 3, [
    // Already inside the sealed unit's range: it belongs to a commit that has
    // happened, and writing it again would put it in the meeting a second time.
    final("u0", "first stretch", 0, 5_000),
    final("u1", "second stretch", 6_100, 11_000),
  ]);
  assert.equal(second.segments.length, 2);
  assert.deepEqual(second.segments[1]!.chunks, [2, 3]);
  assert.deepEqual(settledText(second), ["first stretch", "second stretch"]);
});

test("a settled unit is never rewritten by a later proof — D4's rule, at the durable layer", () => {
  const first = commitStreamedCoverage(recording(4), 1, [final("u0", "as recorded", 0, 5_000)]);
  const later = commitStreamedCoverage(first, 3, [final("u0", "REVISED LATE", 0, 5_000), final("u1", "and on", 6_100, 11_000)]);
  assert.deepEqual(settledText(later), ["as recorded", "and on"]);
});

test("a proven stretch with no speech in it settles as SILENCE, not as a gap", () => {
  // D5's gap is a statement that a range could not be transcribed. A range the
  // endpoint listened to and found nothing in is a different fact, and printing
  // the first for the second is the "quietly wrong" transcript that ADR forbids.
  const committed = commitStreamedCoverage(recording(2), 1, []);
  assert.equal(committed.segments[0]!.state, "done");
  assert.equal(committed.segments[0]!.text, "");
  assert.deepEqual(transcriptSoFar(committed).map((entry) => entry.kind), ["settled"]);
});

test("coverage over chunks that are not on the device yet seals only what IS", () => {
  const session = recording(2);
  // The endpoint cannot prove more than the host wrote; the ledger is the bound.
  const committed = commitStreamedCoverage(session, 9, [final("u0", "everything so far", 0, 5_800)]);
  assert.deepEqual(committed.segments[0]!.chunks, [0, 1]);
  assert.deepEqual(settledText(committed), ["everything so far"]);
});
