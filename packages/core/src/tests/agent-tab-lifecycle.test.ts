/**
 * ADR-027 D10 (P7-3) — agent tab lifecycle.
 *
 * The asymmetry under test: leaving a tab open is clutter, closing one someone
 * is reading is lost work. Every assertion below leans on that asymmetry.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as lifecycle from '../research/agentTabLifecycle.js';
import {
  createPool,
  openTab,
  setBusy,
  adoptByHuman,
  reap,
  applyReap,
  agentTabCount,
  releaseSession,
  TabLifecycleError,
} from '../research/agentTabLifecycle.js';

function poolWith(urls: string[], cap = 2): ReturnType<typeof createPool> {
  let pool = createPool(cap);
  for (const url of urls) pool = openTab(pool, url).pool;
  return pool;
}

test('a cap must be a positive integer', () => {
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => createPool(bad), TabLifecycleError, `for ${bad}`);
  }
});

test('re-reading a URL reuses the agent tab instead of opening another', () => {
  // A fresh tab per read is how accumulation starts.
  let pool = createPool(4);
  const first = openTab(pool, 'https://e.com/a');
  pool = first.pool;
  const second = openTab(pool, 'https://e.com/a');
  assert.equal(second.tab.id, first.tab.id);
  assert.equal(second.pool.tabs.length, 1);
  assert.ok(second.tab.lastUsedAt > first.tab.lastUsedAt, 'reuse refreshes recency');
});

test('a human-owned tab on the same URL is never reused', () => {
  // Navigating it would move the page out from under whoever is reading.
  let pool = createPool(4);
  const opened = openTab(pool, 'https://e.com/a');
  pool = adoptByHuman(opened.pool, opened.tab.id);
  const again = openTab(pool, 'https://e.com/a');
  assert.notEqual(again.tab.id, opened.tab.id);
  assert.equal(again.pool.tabs.length, 2);
});

test('reaping closes the least recently used agent tab', () => {
  const pool = poolWith(['https://e.com/1', 'https://e.com/2', 'https://e.com/3'], 2);
  const decision = reap(pool);
  assert.equal(decision.close.length, 1);
  assert.equal(decision.close[0]!.url, 'https://e.com/1');
  assert.match(decision.reasons[decision.close[0]!.id]!, /least recently used/);
});

test('a human-adopted tab is NEVER reaped, even when it is the oldest', () => {
  // The whole point: adoption outranks recency.
  let pool = poolWith(['https://e.com/1', 'https://e.com/2', 'https://e.com/3'], 2);
  const oldest = pool.tabs[0]!;
  pool = adoptByHuman(pool, oldest.id);
  const decision = reap(pool);
  assert.ok(!decision.close.some((t) => t.id === oldest.id), 'the adopted tab survives');
  assert.ok(decision.keep.some((t) => t.id === oldest.id));
});

test('adoption also removes the tab from the agent count', () => {
  // Human tabs must not push the agent over its own cap.
  let pool = poolWith(['https://e.com/1', 'https://e.com/2'], 2);
  assert.equal(agentTabCount(pool), 2);
  pool = adoptByHuman(pool, pool.tabs[0]!.id);
  assert.equal(agentTabCount(pool), 1);
  assert.equal(reap(pool).close.length, 0, 'under cap once one is adopted');
});

test('a busy tab is never reaped mid-read', () => {
  let pool = poolWith(['https://e.com/1', 'https://e.com/2', 'https://e.com/3'], 2);
  pool = setBusy(pool, pool.tabs[0]!.id, true);
  const decision = reap(pool);
  assert.ok(!decision.close.some((t) => t.id === pool.tabs[0]!.id));
});

test('adopting an unknown tab is an error, not a silent no-op', () => {
  const pool = createPool(2);
  assert.throws(() => adoptByHuman(pool, 'tab-nope'), /unknown tab/);
});

test('there is no way to un-adopt a tab', () => {
  // "The human is finished" is not observable from here, and guessing wrong
  // closes a page in use. Asserting the absence keeps someone from adding it
  // without confronting that.
  const exported = Object.keys(lifecycle);
  for (const forbidden of ['releaseByHuman', 'unadopt', 'returnToAgent', 'disown']) {
    assert.ok(!exported.includes(forbidden), `${forbidden} must not exist`);
  }
});

test('session teardown closes agent tabs and leaves adopted ones alone', () => {
  // A session ending says nothing about whether someone is still reading.
  let pool = poolWith(['https://e.com/1', 'https://e.com/2'], 4);
  pool = adoptByHuman(pool, pool.tabs[1]!.id);
  const decision = releaseSession(pool);
  assert.equal(decision.close.length, 1);
  assert.equal(decision.keep.length, 1);
  assert.equal(decision.keep[0]!.owner, 'human');
  assert.match(decision.reasons[decision.close[0]!.id]!, /session ended/);
});

test('applying a reap leaves the pool under cap', () => {
  const pool = poolWith(['a', 'b', 'c', 'd'], 2);
  const after = applyReap(pool, reap(pool));
  assert.equal(agentTabCount(after), 2);
});

test('the pool never reads a wall clock', () => {
  // Ordering comes from a monotonic sequence so a clock change cannot reorder
  // reaping, and so tests are deterministic.
  const a = poolWith(['x', 'y'], 4);
  const b = poolWith(['x', 'y'], 4);
  assert.deepEqual(a.tabs.map((t) => [t.openedAt, t.lastUsedAt]), b.tabs.map((t) => [t.openedAt, t.lastUsedAt]));
});
