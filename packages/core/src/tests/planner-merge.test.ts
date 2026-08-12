/**
 * ADR-028 D1/D3/D4 — the clock and the merge rules.
 *
 * The properties worth pinning are the ones where a plausible-looking
 * implementation loses someone's work:
 *
 *  - A fast device must not win every conflict forever.
 *  - Two devices editing DIFFERENT fields is not a conflict.
 *  - Concurrent text edits keep both. Nothing is discarded to reach a decision.
 *  - Delete-versus-edit resurrects as conflicted, rather than picking.
 *  - Mirrored items are re-read, never merged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hlcNow, hlcReceive, hlcZero, compareHlc, hlcAfter, clockSkewMs, describeSkew,
  NOTABLE_SKEW_MS,
} from '../sync/hybridClock.js';
import {
  causalValue, mergeField, mergeText, mergeCompletion, mergeOwnedItem, refreshMirrored, canEditLocally,
  type PlannerItem, type Stamped,
} from '../planner/itemMerge.js';

const A = 'device-a';
const B = 'device-b';
const at = (physical: number, logical = 0, deviceId = A) => ({ physical, logical, deviceId });
const s = <T>(value: T, stamp = at(100)): Stamped<T> => ({ value, at: stamp });

/* --------------------------------------------------------------- the clock */

test('a stamp never goes backwards when the wall clock does', () => {
  // NTP correction, a suspended laptop, someone changing the date. The physical
  // clock moving back must not reorder events that already happened.
  const first = hlcNow(hlcZero(A), 1000);
  const second = hlcNow(first, 500);
  assert.equal(second.physical, 1000, 'physical is clamped forward');
  assert.equal(second.logical, 1, 'ordering is preserved by the logical counter');
  assert.ok(hlcAfter(second, first));
});

test('the logical counter resets once real time advances', () => {
  const a = hlcNow(hlcZero(A), 1000);
  const b = hlcNow(a, 1000);
  const c = hlcNow(b, 2000);
  assert.equal(b.logical, 1);
  assert.equal(c.logical, 0);
});

test('a FAST device stops winning after one exchange — the whole reason for an HLC', () => {
  // With Date.now() ordering, a device five minutes fast wins every conflict it
  // participates in, silently and permanently.
  const fast = hlcNow(hlcZero(B), 500_000);
  const slow = hlcReceive(hlcZero(A), fast, 1_000);
  assert.ok(slow.physical >= fast.physical, 'the slow device absorbs the high clock');
  const slowNext = hlcNow(slow, 2_000);
  assert.ok(hlcAfter(slowNext, fast), 'and its next edit now beats the fast one');
});

test('receiving keeps our own device id — it is our clock, having seen theirs', () => {
  const received = hlcReceive(hlcZero(A), at(900, 3, B), 100);
  assert.equal(received.deviceId, A);
  assert.equal(received.logical, 4, 'disambiguated against the remote at equal physical');
});

test('ordering is TOTAL, so two devices resolve the same pair identically', () => {
  // A partial order lets each side pick a different winner and converge on
  // nothing.
  assert.equal(compareHlc(at(1, 0, A), at(1, 0, B)) < 0, true);
  assert.equal(compareHlc(at(1, 0, B), at(1, 0, A)) > 0, true);
  assert.equal(compareHlc(at(1, 0, A), at(1, 0, A)), 0);
});

test('notable clock skew is reported rather than silently absorbed', () => {
  assert.equal(describeSkew(clockSkewMs(at(0), at(60_000))), null, 'ordinary drift stays quiet');
  const notice = describeSkew(clockSkewMs(at(0), at(NOTABLE_SKEW_MS + 60_000)));
  assert.match(notice!, /minutes ahead/);
  assert.match(notice!, /Ordering is still correct/);
});

// `formatHlc`/`parseHlc` and their round-trip test were retired 2026-08-12:
// stamps cross the wire as objects, validated by `isPlannerWireHlc`, and the
// string form had no producer or consumer to round-trip against.

/* --------------------------------------------------------------- the merge */

test('two devices editing DIFFERENT fields both win', () => {
  // Whole-record LWW loses an edit that nothing was competing with.
  const ours: PlannerItem = {
    id: 'i1', origin: 'owned', title: s('Ship it'),
    dueDate: s('2026-08-10', at(200, 0, A)),
  };
  const theirs: PlannerItem = {
    id: 'i1', origin: 'owned', title: s('Ship it'),
    priority: s(1, at(150, 0, B)),
  };
  const merged = mergeOwnedItem(ours, theirs);
  assert.equal(merged.dueDate?.value, '2026-08-10');
  assert.equal(merged.priority?.value, 1);
});

test('a later stamp wins a single field', () => {
  assert.equal(mergeField(s('old', at(100)), s('new', at(200)))!.value, 'new');
  assert.equal(mergeField(s('new', at(200)), s('old', at(100)))!.value, 'new');
});

test('CONCURRENT text edits keep both, and mark the field conflicted', () => {
  // A planner is not important enough to lose a paragraph over, and exactly
  // important enough that quietly losing one destroys trust in all of it.
  const r = mergeText(s('our version', at(300, 1, A)), s('their version', at(300, 1, B)));
  assert.ok(r.conflict, 'concurrent edits must not be resolved silently');
  assert.equal(r.conflict!.ours, 'our version');
  assert.equal(r.conflict!.theirs, 'their version');
  assert.equal(r.conflict!.reason, 'concurrent_text');
});

test('a strictly LATER text edit supersedes without a conflict', () => {
  // It saw the earlier one. Marking this conflicted would cry wolf.
  const r = mergeText(s('first', at(100, 0, A)), s('second', at(500, 0, B)));
  assert.equal(r.conflict, undefined);
  assert.equal(r.value!.value, 'second');
});

test('different wall times do not invent causality between offline replicas', () => {
  const ours = causalValue('our offline edit', at(100, 0, A));
  const theirs = causalValue('their later-clock edit', at(500, 0, B));
  const result = mergeText(ours, theirs);
  assert.equal(result.conflict?.reason, 'concurrent_text');
  assert.equal(result.conflict?.ours, 'our offline edit');
  assert.equal(result.conflict?.theirs, 'their later-clock edit');
});

test('an edit carrying the version it observed supersedes without crying conflict', () => {
  const first = causalValue('first', at(100, 0, A));
  const second = causalValue('second', at(500, 0, B), first);
  const result = mergeText(first, second);
  assert.equal(result.conflict, undefined);
  assert.equal(result.value?.value, 'second');
});

test('identical text is never a conflict, whatever the stamps', () => {
  const r = mergeText(s('Same', at(100, 0, A)), s('Same', at(100, 0, B)));
  assert.equal(r.conflict, undefined);
});

test('complete wins at equal clocks — the deliberate asymmetry', () => {
  // Un-completing something you finished is worse than re-completing something
  // that bounced back: the first makes you doubt the record.
  const done = mergeCompletion(s(true, at(100, 0, A)), s(false, at(100, 0, B)));
  assert.equal(done!.value, true);
  const alsoDone = mergeCompletion(s(false, at(100, 0, A)), s(true, at(100, 0, B)));
  assert.equal(alsoDone!.value, true);
});

test('a later un-complete still wins — the tie-break is only for ties', () => {
  const r = mergeCompletion(s(true, at(100, 0, A)), s(false, at(900, 0, B)));
  assert.equal(r!.value, false);
});

test('an edit AFTER a delete resurrects the item as conflicted', () => {
  // Someone was working on this after someone else removed it. Silently
  // undeleting and silently discarding the edit are both wrong.
  const deleted: PlannerItem = {
    id: 'i1', origin: 'owned', title: s('Draft', at(100, 0, A)), deletedAt: at(200, 0, A),
  };
  const edited: PlannerItem = {
    id: 'i1', origin: 'owned', title: s('Draft, revised', at(400, 0, B)),
  };
  const merged = mergeOwnedItem(deleted, edited);
  assert.equal(merged.deletedAt, undefined, 'the edit resurrects it');
  assert.equal(merged.conflicts?.deleted?.reason, 'delete_vs_edit');
  assert.equal(merged.title.value, 'Draft, revised', 'and the edit is not lost');
});

test('a delete after the last edit simply stands', () => {
  const edited: PlannerItem = { id: 'i1', origin: 'owned', title: s('Draft', at(100, 0, B)) };
  const deleted: PlannerItem = {
    id: 'i1', origin: 'owned', title: s('Draft', at(100, 0, B)), deletedAt: at(900, 0, A),
  };
  const merged = mergeOwnedItem(deleted, edited);
  assert.ok(merged.deletedAt, 'no edit came after it');
  assert.equal(merged.conflicts?.deleted, undefined);
});

test('a delete-versus-edit choice survives stale pulls in either direction', () => {
  const deletion = at(200, 0, A);
  const edit = at(400, 0, B);
  const choice = at(500, 0, A);
  const stale: PlannerItem = {
    id: 'i1', origin: 'owned', title: s('Edited', edit), deletedAt: deletion,
    conflicts: {
      deleted: {
        ours: 'deleted', theirs: 'edited', oursAt: deletion, theirsAt: edit,
        reason: 'delete_vs_edit',
      },
    },
  };
  const keptEdit: PlannerItem = {
    id: 'i1', origin: 'owned', title: s('Edited', edit),
    deletionResolution: { deleted: false, at: choice },
  };
  const keptDelete: PlannerItem = {
    id: 'i1', origin: 'owned', title: s('Edited', edit), deletedAt: choice,
    deletionResolution: { deleted: true, at: choice },
  };

  for (const merged of [mergeOwnedItem(keptEdit, stale), mergeOwnedItem(stale, keptEdit)]) {
    assert.equal(merged.deletedAt, undefined);
    assert.equal(merged.conflicts?.deleted, undefined);
    assert.deepEqual(merged.deletionResolution, { deleted: false, at: choice });
  }
  for (const merged of [mergeOwnedItem(keptDelete, stale), mergeOwnedItem(stale, keptDelete)]) {
    assert.deepEqual(merged.deletedAt, choice);
    assert.equal(merged.conflicts?.deleted, undefined);
    assert.deepEqual(merged.deletionResolution, { deleted: true, at: choice });
  }
});

test('a resolution watermark prevents an old pulled conflict from reappearing', () => {
  const oldConflict = {
    ours: 'ours', theirs: 'theirs',
    oursAt: at(300, 1, A), theirsAt: at(300, 1, B),
    reason: 'concurrent_text' as const,
  };
  const resolution = at(400, 0, A);
  const resolved: PlannerItem = {
    id: 'i1', origin: 'owned', title: s('chosen', resolution),
    conflictResolutions: { title: resolution },
  };
  const staleServer: PlannerItem = {
    id: 'i1', origin: 'owned', title: s('theirs', at(300, 1, B)),
    conflicts: { title: oldConflict },
  };
  const merged = mergeOwnedItem(resolved, staleServer);
  assert.equal(merged.title.value, 'chosen');
  assert.equal(merged.conflicts?.title, undefined);
  assert.deepEqual(merged.conflictResolutions?.title, resolution);
});

test('concurrent conflict resolutions converge by total HLC without a new conflict', () => {
  const aResolution = at(400, 0, A);
  const bResolution = at(400, 0, B);
  const a: PlannerItem = {
    id: 'i1', origin: 'owned', title: s('keep A', aResolution),
    conflictResolutions: { title: aResolution },
  };
  const b: PlannerItem = {
    id: 'i1', origin: 'owned', title: s('keep B', bResolution),
    conflictResolutions: { title: bResolution },
  };
  const ab = mergeOwnedItem(a, b);
  const ba = mergeOwnedItem(b, a);
  assert.equal(ab.title.value, 'keep B');
  assert.equal(ba.title.value, 'keep B');
  assert.equal(ab.conflicts?.title, undefined);
  assert.deepEqual(ab, ba);
});

test('resolving a notes conflict to empty text remains a durable value', () => {
  const resolution = at(500, 0, A);
  const resolved: PlannerItem = {
    id: 'i1', origin: 'owned', title: s('title'), notes: s('', resolution),
    conflictResolutions: { notes: resolution },
  };
  const stale: PlannerItem = {
    id: 'i1', origin: 'owned', title: s('title'), notes: s('stale notes', at(300, 0, B)),
    conflicts: {
      notes: {
        ours: 'first', theirs: 'stale notes',
        oursAt: at(300, 0, A), theirsAt: at(300, 0, B), reason: 'concurrent_text',
      },
    },
  };
  const merged = mergeOwnedItem(resolved, stale);
  assert.equal(merged.notes?.value, '');
  assert.equal(merged.conflicts?.notes, undefined);
});

/* ------------------------------------------------------- mirrored items */

test('a mirrored item is RE-READ, not merged — the remote is the truth', () => {
  // If an issue changed while you were offline there is no conflict. The issue
  // is whatever GitHub says it is.
  const local: PlannerItem = {
    id: 'gh-41', origin: 'mirrored', source: 'github',
    title: s('Stale title', at(900, 0, A)),
    priority: s(2, at(800, 0, A)),
  };
  const refreshed = refreshMirrored(
    local,
    { title: s('Real title', at(1, 0, 'remote')), source: 'github' },
    '2026-08-04T12:00:00.000Z',
  );
  assert.equal(refreshed.title.value, 'Real title', 'an older remote stamp still wins');
  assert.equal(refreshed.fetchedAt, '2026-08-04T12:00:00.000Z');
  assert.equal(refreshed.priority?.value, 2, 'planner-owned metadata survives');
});

test('planner metadata on a mirrored item is editable; source fields are not', () => {
  const item = { origin: 'mirrored' as const, source: 'github' };
  assert.equal(canEditLocally(item, 'priority').allowed, true);
  assert.equal(canEditLocally(item, 'scheduledFor').allowed, true);
  const deleteDenied = canEditLocally(item, 'delete');
  assert.equal(deleteDenied.allowed, false);
  assert.match(deleteDenied.reason!, /Delete or close it in its source/);
  const denied = canEditLocally(item, 'title');
  assert.equal(denied.allowed, false);
  assert.match(denied.reason!, /reverted by the next refresh/);
  assert.match(denied.reason!, /github/);
});

test('every field of an owned item is editable', () => {
  assert.equal(canEditLocally({ origin: 'owned' }, 'title').allowed, true);
});
