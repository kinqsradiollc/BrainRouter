import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadExpandedProjects, saveExpandedProjects, withExpanded, toggleExpanded } from './expandedProjectsStore.js';

// Minimal localStorage shim for the persistence round-trip.
function withStorage(fn: () => void): void {
  const store = new Map<string, string>();
  const prev = (globalThis as { localStorage?: unknown }).localStorage;
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
  };
  try { fn(); } finally { (globalThis as { localStorage?: unknown }).localStorage = prev; }
}

test('expandedProjectsStore: save → load round-trips and de-dupes', () => {
  withStorage(() => {
    saveExpandedProjects(['/a', '/b', '/a']);
    assert.deepEqual(loadExpandedProjects().sort(), ['/a', '/b']);
  });
});

test('expandedProjectsStore: load returns [] when empty or corrupt', () => {
  withStorage(() => {
    assert.deepEqual(loadExpandedProjects(), []);
    globalThis.localStorage!.setItem('br-expanded-projects', '{not json');
    assert.deepEqual(loadExpandedProjects(), []);
    globalThis.localStorage!.setItem('br-expanded-projects', '{"a":1}');
    assert.deepEqual(loadExpandedProjects(), []); // not an array → []
  });
});

test('expandedProjectsStore: load survives a missing localStorage (no throw)', () => {
  const prev = (globalThis as { localStorage?: unknown }).localStorage;
  (globalThis as { localStorage?: unknown }).localStorage = undefined;
  try {
    assert.deepEqual(loadExpandedProjects(), []);
    assert.doesNotThrow(() => saveExpandedProjects(['/x']));
  } finally {
    (globalThis as { localStorage?: unknown }).localStorage = prev;
  }
});

test('withExpanded: adds a workspace and is idempotent (regression: switch keeps A expanded)', () => {
  // Switching away from active workspace A must keep A in the expanded set so it
  // doesn't collapse to a non-active row.
  const start: string[] = [];
  const afterSwitch = withExpanded(start, '/workspace-A');
  assert.deepEqual(afterSwitch, ['/workspace-A']);
  // Idempotent: a second switch-away returns the SAME reference (no churn).
  assert.equal(withExpanded(afterSwitch, '/workspace-A'), afterSwitch);
  // Empty root is a no-op.
  assert.equal(withExpanded(afterSwitch, ''), afterSwitch);
});

test('toggleExpanded: flips membership', () => {
  assert.deepEqual(toggleExpanded([], '/a'), ['/a']);
  assert.deepEqual(toggleExpanded(['/a', '/b'], '/a'), ['/b']);
});
