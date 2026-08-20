// ADR-041 A41-13 (W1) — the spill store: a disk-backed cold tier for ResultCache.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SpillStore } from '../util/result/spillStore.js';
import { ResultCache } from '../util/result/resultHandoff.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spill-'));
}

test('A41-13 — SpillStore round-trips a value and drops it', () => {
  const dir = tmpDir();
  try {
    const store = new SpillStore(dir);
    store.spill('r-abc123', 'the full result body');
    assert.equal(store.retrieve('r-abc123'), 'the full result body');
    store.drop('r-abc123');
    assert.equal(store.retrieve('r-abc123'), undefined, 'dropped ref is gone');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('A41-13 — SpillStore refuses path-traversal refs (never escapes its dir)', () => {
  const dir = tmpDir();
  try {
    const store = new SpillStore(dir);
    store.spill('../escape', 'nope');
    store.spill('a/b', 'nope');
    // Nothing written under the dir for the bad refs, and retrieve is undefined.
    assert.equal(store.retrieve('../escape'), undefined);
    assert.equal(store.retrieve('a/b'), undefined);
    const files = fs.readdirSync(dir);
    assert.deepEqual(files, [], 'no files written for unsafe refs');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('A41-13 — a ResultCache WITHOUT a spill store loses evicted entries (byte-neutral default)', () => {
  const cache = new ResultCache(60_000, 1); // maxEntries = 1
  cache.put('r-1', 'first');
  cache.put('r-2', 'second'); // evicts r-1 (LRU, over cap)
  assert.equal(cache.get('r-1'), undefined, 'without spill, an evicted entry is gone');
  assert.equal(cache.get('r-2'), 'second');
});

test('A41-13 — a ResultCache WITH a spill store recovers an evicted entry from disk', () => {
  const dir = tmpDir();
  try {
    const spill = new SpillStore(dir);
    const cache = new ResultCache(60_000, 1, () => Date.now(), spill);
    cache.put('r-1', 'first result body');
    cache.put('r-2', 'second'); // evicts r-1 → spilled to disk
    // r-1 is no longer in memory but is recovered from the cold tier.
    assert.equal(cache.get('r-1'), 'first result body', 'evicted entry recovered from spill');
    // After recovery it is promoted back to memory and the disk copy is dropped.
    assert.equal(spill.retrieve('r-1'), undefined, 'disk copy dropped after promotion');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('A41-13 — a ResultCache WITH a spill store recovers an EXPIRED entry via get', () => {
  const dir = tmpDir();
  try {
    let clock = 1000;
    const spill = new SpillStore(dir);
    const cache = new ResultCache(100, 8, () => clock, spill);
    cache.put('r-x', 'body');
    clock += 200; // past the 100ms TTL
    assert.equal(cache.get('r-x'), 'body', 'expired entry is cold-tiered then recovered');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
