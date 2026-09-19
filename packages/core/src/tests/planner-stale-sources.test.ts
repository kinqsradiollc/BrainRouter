/**
 * ADR-028 D7 / ADR-060 D5 — a stale source says so.
 *
 * `staleSources` was wired end to end: Core computed it, both hosts projected
 * it, the shared surface rendered it with `role="status"`. It was also always
 * empty, because the freshness it filtered came from a caller-supplied option
 * that NO caller supplied. A calendar that stopped answering looked exactly
 * like one that was up to date — the failure ADR-028 D7 exists to prevent,
 * shipped behind a working-looking pipeline.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceFreshnessFromItems } from '../planner/agentContext.js';
import { describeFreshness, isStale, STALE_AFTER_MS } from '../planner/sourceAdapter.js';
import type { PlannerItem } from '../planner/itemMerge.js';

const NOW = Date.parse('2026-09-19T12:00:00.000Z');
const at = { physical: NOW, logical: 0, deviceId: 'test' };
const EVERY_30_MIN = 60 * 60_000;

function mirrored(id: string, sourceLabel: string, fetchedAt: string, sourceId = `connector:${sourceLabel}`): PlannerItem {
  return {
    id,
    origin: 'mirrored',
    source: sourceLabel,
    fetchedAt,
    provenance: { sourceId, sourceLabel, fetchedAt },
    title: { value: id, at },
  };
}

test('what a person reads is the source\'s NAME, never its connector id', () => {
  const items = [mirrored('a', 'Family · iCloud', '2026-09-19T06:00:00.000Z', 'connector:conn_1a2b3c4d')];
  const [entry] = sourceFreshnessFromItems(items, () => EVERY_30_MIN);
  assert.equal(entry!.sourceId, 'connector:conn_1a2b3c4d', 'identity is kept, so two calendars named Work stay apart');
  assert.equal(describeFreshness(entry!, NOW), 'Family · iCloud is 6 hours old.');
});

test('freshness is read off the items on screen, one entry per source, newest read wins', () => {
  const items: PlannerItem[] = [
    mirrored('a', 'Family · iCloud', '2026-09-19T08:00:00.000Z'),
    // Same source, a newer read: the source answered, so it is not stale.
    mirrored('b', 'Family · iCloud', '2026-09-19T11:58:00.000Z'),
    mirrored('c', 'Work · Google', '2026-09-19T06:00:00.000Z'),
    { id: 'mine', origin: 'owned', title: { value: 'Mine', at } },
  ];
  const freshness = sourceFreshnessFromItems(items, () => EVERY_30_MIN);
  assert.deepEqual(freshness.map((f) => f.label).sort(), ['Family · iCloud', 'Work · Google']);
  const family = freshness.find((f) => f.label === 'Family · iCloud')!;
  assert.equal(family.itemCount, 2);
  assert.equal(family.lastFetchedAt, '2026-09-19T11:58:00.000Z', 'the newest read, not the first seen');
  assert.equal(isStale(family, NOW), false);

  const work = freshness.find((f) => f.label === 'Work · Google')!;
  assert.equal(isStale(work, NOW), true);
  assert.equal(describeFreshness(work, NOW), 'Work · Google is 6 hours old.');
});

test('a source that does not refresh itself is never stale — it is as current as the last run you asked for', () => {
  const items = [mirrored('c', 'GitHub', '2026-09-18T06:00:00.000Z', 'connector:manual')];
  assert.deepEqual(
    sourceFreshnessFromItems(items, (id) => (id === 'connector:manual' ? undefined : EVERY_30_MIN)),
    [],
    'left out entirely rather than shown as a day old',
  );
});

test('the bar is the source\'s own cadence, not one number for everything', () => {
  const items = [mirrored('a', 'Family', '2026-09-19T11:20:00.000Z')];
  // 40 minutes old. Under the shared 15-minute default it is stale; against a
  // calendar polled every 30 minutes (D5: twice that) it has not missed a beat.
  assert.equal(isStale(sourceFreshnessFromItems(items, () => STALE_AFTER_MS)[0]!, NOW), true);
  assert.equal(isStale(sourceFreshnessFromItems(items, () => EVERY_30_MIN)[0]!, NOW), false);
});

test('an item the source has never answered for is stale, and one with no source is nobody\'s', () => {
  const never: PlannerItem = { ...mirrored('x', 'Work', '2026-09-19T12:00:00.000Z'), fetchedAt: undefined };
  delete (never as { provenance?: unknown }).provenance;
  const [entry] = sourceFreshnessFromItems([never], () => EVERY_30_MIN);
  assert.equal(entry!.label, 'Work', 'the legacy source field still names it');
  assert.equal(entry!.lastFetchedAt, null);
  assert.equal(isStale(entry!, NOW), true);

  const anonymous: PlannerItem = { id: 'y', origin: 'mirrored', title: { value: 'y', at } };
  assert.deepEqual(sourceFreshnessFromItems([anonymous], () => EVERY_30_MIN), [], 'nothing to name, nothing to claim about');
});
