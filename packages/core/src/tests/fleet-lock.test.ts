/** HONK-H3 — single-runner host lock. Isolated per test via a throwaway home. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireFleetLock, readFleetLock, FLEET_LOCK_TTL_MS } from '../fleet/lock.js';

function freshHome(): string {
  return mkdtempSync(path.join(tmpdir(), 'br-fleetlock-'));
}
const ALIVE = () => true;
const DEAD = () => false;

test('acquireFleetLock takes a free lock and records the holder', () => {
  const home = freshHome();
  try {
    const now = new Date('2026-06-30T00:00:00.000Z');
    const h = acquireFleetLock({ home, pid: 100, now, isAlive: ALIVE });
    assert.ok(h, 'free lock is acquired');
    assert.equal(h!.record.pid, 100);
    assert.equal(readFleetLock(home)?.pid, 100);
    assert.equal(readFleetLock(home)?.acquiredAt, now.toISOString());
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a second live runner is refused while the holder is fresh + alive', () => {
  const home = freshHome();
  try {
    const now = new Date('2026-06-30T00:00:00.000Z');
    acquireFleetLock({ home, pid: 100, now, isAlive: ALIVE });
    const second = acquireFleetLock({ home, pid: 200, now: new Date(now.getTime() + 1000), isAlive: ALIVE });
    assert.equal(second, null, 'cannot steal a live lock');
    assert.equal(readFleetLock(home)?.pid, 100, 'holder unchanged');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a dead holder is reclaimed', () => {
  const home = freshHome();
  try {
    const now = new Date('2026-06-30T00:00:00.000Z');
    acquireFleetLock({ home, pid: 100, now, isAlive: ALIVE });
    // pid 100 is now dead from pid 200's perspective.
    const taken = acquireFleetLock({ home, pid: 200, now: new Date(now.getTime() + 1000), isAlive: (p) => p === 200 });
    assert.ok(taken, 'dead holder reclaimed');
    assert.equal(readFleetLock(home)?.pid, 200);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a stale heartbeat is reclaimed even if the pid still resolves (wedged owner)', () => {
  const home = freshHome();
  try {
    const now = new Date('2026-06-30T00:00:00.000Z');
    acquireFleetLock({ home, pid: 100, now, isAlive: ALIVE });
    const later = new Date(now.getTime() + FLEET_LOCK_TTL_MS + 1);
    const taken = acquireFleetLock({ home, pid: 200, now: later, isAlive: ALIVE /* 100 still "alive" but wedged */ });
    assert.ok(taken, 'expired heartbeat is reclaimable');
    assert.equal(readFleetLock(home)?.pid, 200);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('heartbeat refreshes the holder in place and keeps acquiredAt; a fresh heartbeat blocks takeover', () => {
  const home = freshHome();
  try {
    const t0 = new Date('2026-06-30T00:00:00.000Z');
    const h = acquireFleetLock({ home, pid: 100, now: t0, isAlive: ALIVE })!;
    // Just before TTL, the owner heartbeats.
    const beatAt = new Date(t0.getTime() + FLEET_LOCK_TTL_MS - 1);
    assert.equal(h.heartbeat(beatAt), true);
    assert.equal(readFleetLock(home)?.acquiredAt, t0.toISOString(), 'acquiredAt preserved');
    assert.equal(readFleetLock(home)?.heartbeatAt, beatAt.toISOString());
    // A takeover attempt that WOULD have succeeded against the old heartbeat now fails.
    const justAfterOldTtl = new Date(t0.getTime() + FLEET_LOCK_TTL_MS + 1);
    assert.equal(acquireFleetLock({ home, pid: 200, now: justAfterOldTtl, isAlive: ALIVE }), null, 'fresh heartbeat keeps the lock');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('re-acquiring as the same pid is idempotent (keeps acquiredAt, refreshes heartbeat)', () => {
  const home = freshHome();
  try {
    const t0 = new Date('2026-06-30T00:00:00.000Z');
    acquireFleetLock({ home, pid: 100, now: t0, isAlive: ALIVE });
    const again = acquireFleetLock({ home, pid: 100, now: new Date(t0.getTime() + 5000), isAlive: ALIVE });
    assert.ok(again);
    assert.equal(again!.record.acquiredAt, t0.toISOString(), 'same-pid re-acquire keeps acquiredAt');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('release frees the lock for another runner; heartbeat after a takeover returns false', () => {
  const home = freshHome();
  try {
    const now = new Date('2026-06-30T00:00:00.000Z');
    const h = acquireFleetLock({ home, pid: 100, now, isAlive: ALIVE })!;
    h.release();
    assert.equal(readFleetLock(home), null, 'released → no holder');
    const next = acquireFleetLock({ home, pid: 200, now: new Date(now.getTime() + 1), isAlive: ALIVE });
    assert.ok(next, 'a new runner can acquire after release');

    // The old handle must not be able to clobber the new holder's heartbeat.
    assert.equal(h.heartbeat(new Date(now.getTime() + 2)), false, 'stale handle cannot heartbeat');
    assert.equal(readFleetLock(home)?.pid, 200, 'new holder intact');
    // And releasing the stale handle must not remove the new holder's lock.
    h.release();
    assert.equal(readFleetLock(home)?.pid, 200, 'stale release is a no-op');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
