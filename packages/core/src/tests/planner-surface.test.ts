/**
 * ADR-028 D5/D6/D7 — the timetable, sources, and the agent's view.
 *
 * The through-line: every one of these refuses to overstate. Drift needs a
 * sample before it says anything, a stale source says its age, and the agent's
 * context is a summary with a count rather than a list.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeDrift, describeDrift, carryOver, needsAttention, describeCarryOver,
  dayView, commitmentFor, MIN_DRIFT_SAMPLE, type TimeBlock,
} from '../planner/timetable.js';
import {
  isStale, describeFreshness,
  STALE_AFTER_MS, type SourceFreshness,
} from '../planner/sourceAdapter.js';
import {
  buildPlannerContext, asUntrustedText, MAX_LISTED_ITEMS,
} from '../planner/agentContext.js';
import type { PlannerItem } from '../planner/itemMerge.js';

const NOW = Date.parse('2026-08-04T12:00:00.000Z');
const block = (over: Partial<TimeBlock> = {}): TimeBlock => ({
  id: 'b', itemId: 'i', estimateMinutes: 60, carriedOver: 0, ...over,
});
const item = (title: string, over: Partial<PlannerItem> = {}): PlannerItem => ({
  id: title, origin: 'owned',
  title: { value: title, at: { physical: 1, logical: 0, deviceId: 'a' } },
  ...over,
});

/* ------------------------------------------------------------ D5 · drift */

test('drift says NOTHING below a usable sample', () => {
  // A 2.4× ratio off three blocks invites planning around a number that will
  // move next week.
  const few = Array.from({ length: MIN_DRIFT_SAMPLE - 1 }, () => block({ actualMinutes: 120 }));
  const d = summarizeDrift(few);
  assert.equal(d.ratio, null);
  assert.equal(d.description, null);
});

test('drift is a ratio that teaches, not a scoreboard', () => {
  const blocks = Array.from({ length: 6 }, () => block({ estimateMinutes: 60, actualMinutes: 108 }));
  const d = summarizeDrift(blocks);
  assert.equal(d.ratio, 1.8);
  assert.match(d.description!, /1\.8×/);
  assert.doesNotMatch(d.description!, /overdue|failed|behind/i);
});

test('finishing early is stated the same way as running over', () => {
  // Praise on one side makes the other feel like failure, and then nobody
  // wants to look at the number.
  const early = describeDrift(0.7);
  assert.match(early, /more room in the day/);
  assert.doesNotMatch(early, /good|great|well done/i);
  assert.match(describeDrift(1.0), /holding up/);
});

test('blocks without an actual are excluded from the ratio', () => {
  const mixed = [...Array.from({ length: 5 }, () => block({ actualMinutes: 60 })), block()];
  assert.equal(summarizeDrift(mixed).sampleSize, 5);
});

test('carry-over is recorded, not scolded', () => {
  const carried = carryOver([block({ carriedOver: 1 }), block({ completedAt: 'x' })], '2026-08-05');
  assert.equal(carried[0]!.carriedOver, 2);
  assert.equal(carried[1]!.carriedOver, 0, 'completed blocks are untouched');
});

test('repeated carry-over is raised as a QUESTION about the task', () => {
  // "This has moved four times" invites a defence; asking what it is waiting on
  // invites the actual answer.
  const stuck = needsAttention([block({ carriedOver: 4 }), block({ carriedOver: 1 })]);
  assert.equal(stuck.length, 1);
  const text = describeCarryOver(stuck[0]!);
  assert.match(text, /waiting on something/);
  assert.match(text, /smaller first step/);
});

test('unscheduled blocks are first-class — a today list is a real plan', () => {
  const view = dayView(
    [block({ id: 'u' }), block({ id: 's', scheduledFor: '2026-08-04T09:00:00.000Z' })],
    '2026-08-04',
  );
  assert.deepEqual(view.scheduled.map((b) => b.id), ['s']);
  assert.deepEqual(view.unscheduled.map((b) => b.id), ['u']);
});

test('over-commitment is stated as a fact, not a warning', () => {
  const c = commitmentFor([block({ estimateMinutes: 660 })], 480);
  assert.equal(c.overBy, 180);
  assert.match(c.note!, /11h planned against 8h available/);
  assert.doesNotMatch(c.note!, /too much|warning|!/);
  assert.equal(commitmentFor([block({ estimateMinutes: 60 })], 480).note, null);
});

/* ------------------------------------------------------- D7 · freshness */

test('a source that has never loaded is stale', () => {
  assert.equal(isStale({ sourceId: 'github', lastFetchedAt: null, itemCount: 0 }, NOW), true);
});

test('a stale source SAYS its age rather than presenting items as current', () => {
  const six: SourceFreshness = {
    sourceId: 'github',
    lastFetchedAt: new Date(NOW - 6 * 3600_000).toISOString(),
    itemCount: 4,
  };
  assert.equal(isStale(six, NOW), true);
  assert.match(describeFreshness(six, NOW), /6 hours old/);
});

test('a fresh source says so briefly', () => {
  const fresh: SourceFreshness = {
    sourceId: 'track', lastFetchedAt: new Date(NOW - 1000).toISOString(), itemCount: 2,
  };
  assert.equal(isStale(fresh, NOW), false);
  assert.match(describeFreshness(fresh, NOW), /current/);
});

test('a failed refresh reports the age AND the error', () => {
  const failed: SourceFreshness = {
    sourceId: 'github',
    lastFetchedAt: new Date(NOW - STALE_AFTER_MS - 1000).toISOString(),
    itemCount: 3,
    lastError: '503',
  };
  const text = describeFreshness(failed, NOW);
  assert.match(text, /last refresh failed/);
  assert.match(text, /503/);
});

/*
 * D7's `collectFromSources` and D8's `partitionForRetention` were exercised
 * here and were **retired 2026-08-12** with no caller anywhere. The behaviours
 * they were tested for are not gone, they are somewhere reachable:
 *
 *  - one failing source not emptying the view — there is one source, and
 *    `runConnectorCheckpointCore` already reports per-connector failures
 *    without discarding the documents that did arrive
 *    (`connector-run-checkpoint.test.ts`);
 *  - the freshness a stale source reports — `sourceFreshnessFromItems`, run on
 *    every turn and covered below and in `planner-turn-context.test.ts`;
 *  - 90-day compaction of completed items — `compactCompletedPlannerItems` in
 *    the server's retention pass, covered by its own query tests.
 *
 * Deleting these tests alongside the code is deliberate. A test kept for a
 * deleted function is the same claim as the function: work that looks covered
 * and runs nowhere.
 */

/* --------------------------------------------------- D6 · agent context */

test('nothing worth saying produces NO section', () => {
  // A section that always appears trains the model to skip it, and then it is
  // not there on the day it matters.
  assert.equal(buildPlannerContext({ todayItems: [], blocks: [], freshness: [], nowMs: NOW }), null);
});

test('the list is bounded, and the remainder is a COUNT', () => {
  // Fifty low-signal lines make the model worse at the five that matter.
  const many = Array.from({ length: MAX_LISTED_ITEMS + 4 }, (_, i) => item(`task ${i}`));
  const text = buildPlannerContext({ todayItems: many, blocks: [], freshness: [], nowMs: NOW })!;
  assert.equal(text.split('\n').filter((l) => l.startsWith('  - ')).length, MAX_LISTED_ITEMS + 1);
  assert.match(text, /\+4 more not listed/);
});

test('completed and deleted items are not injected', () => {
  const text = buildPlannerContext({
    todayItems: [
      item('done', { completed: { value: true, at: { physical: 1, logical: 0, deviceId: 'a' } } }),
      item('gone', { deletedAt: { physical: 1, logical: 0, deviceId: 'a' } }),
      item('live'),
    ],
    blocks: [], freshness: [], nowMs: NOW,
  })!;
  assert.match(text, /live/);
  assert.doesNotMatch(text, /done|gone/);
});

test('freshness appears ONLY when something is stale', () => {
  // "GitHub is current" every turn costs tokens to say nothing.
  const fresh: SourceFreshness = { sourceId: 'github', lastFetchedAt: new Date(NOW - 1000).toISOString(), itemCount: 1 };
  const withFresh = buildPlannerContext({ todayItems: [item('x')], blocks: [], freshness: [fresh], nowMs: NOW })!;
  assert.doesNotMatch(withFresh, /github/);

  const stale: SourceFreshness = { sourceId: 'github', lastFetchedAt: new Date(NOW - 6 * 3600_000).toISOString(), itemCount: 1 };
  const withStale = buildPlannerContext({ todayItems: [item('x')], blocks: [], freshness: [stale], nowMs: NOW })!;
  assert.match(withStale, /github is 6 hours old/);
});

/*
 * Three policy predicates were asserted here — `classifyPlannerAction`,
 * `mayCompleteFromInference`, `mayRaiseBacklog` — and all three were
 * **retired 2026-08-12**: this file was their only consumer. See
 * `planner/agentContext.ts` for where each rule actually lives now. The
 * classification one is covered where it is enforced, in the tool catalog's
 * own inventory test; "never infer completion" is covered by
 * `planner-source-projection.test.ts` asserting the projection emits no
 * `completed` even for a closed issue.
 */
