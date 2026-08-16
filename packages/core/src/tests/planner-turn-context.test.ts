/**
 * ADR-028 D6 — the planner block that reaches the model.
 *
 * `planner-surface.test.ts` proves `buildPlannerContext` summarises correctly.
 * This file covers the part that was missing for as long as the decision was
 * unwired: where the freshness it reports comes from, and that the block is
 * assembled from the same user-scoped store the `planner_*` tools write to.
 *
 * The caller itself is pinned by `inert-value-sweep.test.ts` ("the planner
 * context reaches the model on the turn path") — a different test from this one,
 * on purpose, because a unit that works and a unit that is called are two claims.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPlannerContext, sourceFreshnessFromItems, PLANNER_CONTEXT_TAG,
} from '../planner/agentContext.js';
import { isStale } from '../planner/sourceAdapter.js';
import type { PlannerItem } from '../planner/itemMerge.js';

const NOW = Date.parse('2026-08-12T12:00:00.000Z');
const stamp = { physical: 1, logical: 0, deviceId: 'a' };

function mirrored(id: string, sourceId: string, fetchedAt: string | null): PlannerItem {
  return {
    id,
    origin: 'mirrored',
    source: sourceId,
    ...(fetchedAt ? { fetchedAt } : {}),
    ...(fetchedAt
      ? {
        provenance: {
          sourceId, sourceLabel: sourceId, fetchedAt,
        },
      }
      : {}),
    title: { value: id, at: stamp },
  };
}

test('freshness is derived from the items, not kept in a second place', () => {
  const items = [
    mirrored('a', 'github', '2026-08-12T11:58:00.000Z'),
    mirrored('b', 'github', '2026-08-12T11:30:00.000Z'),
    mirrored('c', 'jira', '2026-08-12T04:00:00.000Z'),
  ];
  const freshness = sourceFreshnessFromItems(items);
  assert.deepEqual(
    freshness.map((f) => [f.sourceId, f.itemCount]),
    [['github', 2], ['jira', 1]],
  );
  // The NEWEST stamp wins. Taking the oldest would report GitHub as half an hour
  // stale on the strength of one item a refresh happened to leave behind.
  assert.equal(freshness[0]!.lastFetchedAt, '2026-08-12T11:58:00.000Z');
  assert.equal(isStale(freshness[0]!, NOW), false);
  assert.equal(isStale(freshness[1]!, NOW), true);
});

test('owned items contribute no source — there is nothing that could be stale', () => {
  const owned: PlannerItem = { id: 'own', origin: 'owned', title: { value: 'mine', at: stamp } };
  assert.deepEqual(sourceFreshnessFromItems([owned]), []);
});

test('a source that has never answered is reported as unloaded, not as current', () => {
  const [freshness] = sourceFreshnessFromItems([mirrored('a', 'linear', null)]);
  assert.equal(freshness!.lastFetchedAt, null);
  assert.equal(isStale(freshness!, NOW), true);
});

test('the derived freshness reaches the block only when something IS stale', () => {
  const current = buildPlannerContext({
    todayItems: [mirrored('a', 'github', new Date(NOW - 60_000).toISOString())],
    blocks: [],
    freshness: sourceFreshnessFromItems([mirrored('a', 'github', new Date(NOW - 60_000).toISOString())]),
    nowMs: NOW,
  })!;
  assert.doesNotMatch(current, /github/);

  const old = mirrored('a', 'github', new Date(NOW - 6 * 3_600_000).toISOString());
  const stale = buildPlannerContext({
    todayItems: [old], blocks: [], freshness: sourceFreshnessFromItems([old]), nowMs: NOW,
  })!;
  assert.match(stale, /github is 6 hours old/);
});

test('the block carries a stable tag so a stale one can be removed', () => {
  // The turn phase replaces or removes by this tag; two literals would drift.
  assert.equal(PLANNER_CONTEXT_TAG, 'planner-context');
});
