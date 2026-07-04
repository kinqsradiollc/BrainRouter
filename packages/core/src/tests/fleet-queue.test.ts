/**
 * HONK-H3 — durable global fleet queue + runner.
 * Each test gets its own throwaway BRAINROUTER_HOME so the jobs.json is isolated;
 * we drive time/randomness by injecting `now`/`random` (the store never calls
 * Date.now/Math.random implicitly in a way these tests can't pin).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  enqueueFleetJob,
  getFleetJob,
  listFleetJobs,
  countRunningFleetJobs,
  claimNextFleetJob,
  completeFleetJob,
  failFleetJob,
  cancelFleetJob,
  reconcileStaleFleetJobs,
  fleetBackoffMs,
  MAX_TERMINAL_RETAINED,
  FLEET_BASE_DELAY_MS,
  FLEET_MAX_DELAY_MS,
} from '../fleet/fleetStore.js';
import { FleetJobRunner } from '../fleet/fleetRunner.js';
import { acquireFleetLock, readFleetLock } from '../fleet/lock.js';
import { BudgetExceededError } from '../provider/budget.js';

function freshHome(): string {
  return mkdtempSync(path.join(tmpdir(), 'br-fleet-'));
}

test('enqueueFleetJob persists a pending job with sane defaults', () => {
  const home = freshHome();
  try {
    const { job, deduped } = enqueueFleetJob({ kind: 'build', workspaceRoot: '/ws' }, { home });
    assert.equal(deduped, false);
    assert.match(job.id, /^fleet_[0-9a-f]{8}$/);
    assert.equal(job.status, 'pending');
    assert.equal(job.attempts, 0);
    assert.equal(job.maxAttempts, 3);
    assert.deepEqual(job.input, {});
    assert.equal(getFleetJob(job.id, home)?.status, 'pending');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('enqueueFleetJob dedups an in-flight idempotencyKey but re-enqueues after the prior job is terminal', () => {
  const home = freshHome();
  try {
    const a = enqueueFleetJob({ kind: 'build', workspaceRoot: '/ws', idempotencyKey: 'k1' }, { home });
    const b = enqueueFleetJob({ kind: 'build', workspaceRoot: '/ws', idempotencyKey: 'k1' }, { home });
    assert.equal(b.deduped, true);
    assert.equal(b.job.id, a.job.id, 'same key while in-flight → same job');
    assert.equal(listFleetJobs({}, home).length, 1);

    // Once the first job is terminal, the key is free again.
    const claimed = claimNextFleetJob(4, { home });
    completeFleetJob(claimed!.id, { ok: true }, { home });
    const c = enqueueFleetJob({ kind: 'build', workspaceRoot: '/ws', idempotencyKey: 'k1' }, { home });
    assert.equal(c.deduped, false);
    assert.notEqual(c.job.id, a.job.id);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('claimNextFleetJob respects the global cap and picks highest-priority/oldest first', () => {
  const home = freshHome();
  try {
    const t0 = new Date('2026-06-30T00:00:00.000Z');
    enqueueFleetJob({ kind: 'build', workspaceRoot: '/a', priority: 0 }, { home, now: t0 });
    const hi = enqueueFleetJob({ kind: 'build', workspaceRoot: '/b', priority: 9 }, { home, now: new Date(t0.getTime() + 1) });
    enqueueFleetJob({ kind: 'build', workspaceRoot: '/c', priority: 0 }, { home, now: new Date(t0.getTime() + 2) });

    const first = claimNextFleetJob(2, { home, pid: 111 });
    assert.equal(first?.id, hi.job.id, 'highest priority wins');
    assert.equal(first?.status, 'running');
    assert.equal(first?.attempts, 1);
    assert.equal(first?.pid, 111);

    const second = claimNextFleetJob(2, { home, pid: 111 }); // oldest of the two priority-0
    assert.equal(second?.workspaceRoot, '/a');

    // Cap of 2 is now full → no further claim even though /c is runnable.
    assert.equal(countRunningFleetJobs(home), 2);
    assert.equal(claimNextFleetJob(2, { home }), null, 'at capacity → null');

    // capacity 0 disables the cap.
    assert.ok(claimNextFleetJob(0, { home }), 'cap 0 disables the limit');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('claimNextFleetJob skips jobs whose runAfter is still in the future', () => {
  const home = freshHome();
  try {
    const now = new Date('2026-06-30T12:00:00.000Z');
    const { job } = enqueueFleetJob({ kind: 'build', workspaceRoot: '/ws' }, { home });
    // Fail it once to push runAfter into the future.
    failFleetJob(job.id, 'boom', { home, now, random: () => 0 });
    const gated = getFleetJob(job.id, home)!;
    assert.equal(gated.status, 'pending');
    assert.ok(gated.runAfter && new Date(gated.runAfter) > now);

    assert.equal(claimNextFleetJob(4, { home, now }), null, 'backoff gate blocks the claim');
    const later = new Date(new Date(gated.runAfter).getTime() + 1);
    assert.ok(claimNextFleetJob(4, { home, now: later }), 'claimable once runAfter passes');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('failFleetJob re-arms with backoff while attempts remain, then fails terminally', () => {
  const home = freshHome();
  try {
    const now = new Date('2026-06-30T00:00:00.000Z');
    const { job } = enqueueFleetJob({ kind: 'build', workspaceRoot: '/ws', maxAttempts: 2 }, { home });

    // attempt 1
    claimNextFleetJob(4, { home, now });
    const r1 = failFleetJob(job.id, 'err1', { home, now, random: () => 0 })!;
    assert.equal(r1.status, 'pending', 'still has an attempt left');
    assert.equal(r1.attempts, 1);
    assert.equal(new Date(r1.runAfter!).getTime() - now.getTime(), fleetBackoffMs(1, () => 0));

    // attempt 2 (the last) → terminal
    const claimAt = new Date(r1.runAfter!);
    claimNextFleetJob(4, { home, now: claimAt });
    const r2 = failFleetJob(job.id, 'err2', { home, now: claimAt, random: () => 0 })!;
    assert.equal(r2.status, 'failed');
    assert.equal(r2.error, 'err2');
    assert.ok(r2.completedAt);
    assert.equal(r2.pid, undefined, 'pid cleared on terminal fail');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('cancelFleetJob cancels active jobs but never resurrects a terminal one', () => {
  const home = freshHome();
  try {
    const { job } = enqueueFleetJob({ kind: 'build', workspaceRoot: '/ws' }, { home });
    claimNextFleetJob(4, { home });
    completeFleetJob(job.id, undefined, { home });
    cancelFleetJob(job.id, { home });
    assert.equal(getFleetJob(job.id, home)?.status, 'done', 'cancel is a no-op on a done job');

    const { job: j2 } = enqueueFleetJob({ kind: 'build', workspaceRoot: '/ws' }, { home });
    cancelFleetJob(j2.id, { home });
    assert.equal(getFleetJob(j2.id, home)?.status, 'cancelled');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('reconcileStaleFleetJobs re-arms running jobs whose pid is dead (survives a host restart)', () => {
  const home = freshHome();
  try {
    const now = new Date('2026-06-30T00:00:00.000Z');
    // One that still has attempts → re-armed pending; one out of attempts → failed.
    const live = enqueueFleetJob({ kind: 'build', workspaceRoot: '/a', maxAttempts: 3 }, { home });
    const spent = enqueueFleetJob({ kind: 'build', workspaceRoot: '/b', maxAttempts: 1 }, { home });
    claimNextFleetJob(4, { home, pid: 4242, now });
    claimNextFleetJob(4, { home, pid: 4242, now });
    assert.equal(countRunningFleetJobs(home), 2);

    const fixed = reconcileStaleFleetJobs((pid) => pid !== 4242 /* 4242 is "dead" */, { home, now, random: () => 0 });
    assert.equal(fixed, 2);
    const rearmed = getFleetJob(live.job.id, home)!;
    assert.equal(rearmed.status, 'pending', 're-armed for retry');
    // Re-arm is BACKED OFF (not instantly re-claimable) so a host-crasher can't
    // burn every attempt across instant reboots.
    assert.ok(rearmed.runAfter && new Date(rearmed.runAfter) > now, 'reconcile applies a backoff gate');
    assert.equal(getFleetJob(spent.job.id, home)?.status, 'failed', 'no attempts left → terminal');
    assert.equal(countRunningFleetJobs(home), 0);
    // Still gated at `now` — only claimable once the backoff elapses.
    assert.equal(claimNextFleetJob(4, { home, now }), null, 'backed-off job is not yet runnable');

    // A live pid is left untouched. Claim past the backoff window.
    const later = new Date(new Date(rearmed.runAfter).getTime() + 1);
    claimNextFleetJob(4, { home, pid: 4242, now: later });
    const none = reconcileStaleFleetJobs(() => true, { home, now: later });
    assert.equal(none, 0);
    assert.equal(countRunningFleetJobs(home), 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('FleetJobRunner.tick drains runnable jobs through an injected executor up to the cap', async () => {
  const home = freshHome();
  try {
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) enqueueFleetJob({ kind: 'echo', workspaceRoot: `/ws/${i}`, input: { i } }, { home });

    const runner = new FleetJobRunner({
      capacity: 2,
      home,
      executors: {
        echo: async (job) => {
          seen.push(job.workspaceRoot);
          return { echoed: job.input.i };
        },
      },
    });

    await runner.tick();
    // Cap is 2, so at most 2 are claimed+run on a single tick.
    assert.equal(seen.length, 2);
    assert.equal(listFleetJobs({ status: ['done'] }, home).length, 2);
    assert.equal(listFleetJobs({ status: ['pending'] }, home).length, 1, 'third waits for a free slot');

    // Next tick drains the remainder.
    await runner.tick();
    assert.equal(seen.length, 3);
    assert.equal(listFleetJobs({ status: ['done'] }, home).length, 3);
    const done = listFleetJobs({ status: ['done'] }, home).find((j) => j.workspaceRoot === '/ws/0')!;
    assert.deepEqual(done.output, { echoed: 0 });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('FleetJobRunner cancels a job with no registered executor instead of hanging', async () => {
  const home = freshHome();
  try {
    const { job } = enqueueFleetJob({ kind: 'unknown-kind', workspaceRoot: '/ws' }, { home });
    const runner = new FleetJobRunner({ capacity: 4, home, executors: {} });
    await runner.tick();
    assert.equal(getFleetJob(job.id, home)?.status, 'cancelled');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('FleetJobRunner.runOne failure path re-arms the job via backoff', async () => {
  const home = freshHome();
  try {
    const { job } = enqueueFleetJob({ kind: 'boom', workspaceRoot: '/ws', maxAttempts: 2 }, { home });
    const runner = new FleetJobRunner({
      capacity: 4,
      home,
      executors: {
        boom: async () => {
          throw new Error('kaboom');
        },
      },
    });
    await runner.tick();
    const after = getFleetJob(job.id, home)!;
    assert.equal(after.status, 'pending', 'one attempt left → re-armed');
    assert.equal(after.error, 'kaboom');
    assert.equal(after.attempts, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('FleetJobRunner.runOne classifies budget failures as terminal', async () => {
  const home = freshHome();
  try {
    const { job } = enqueueFleetJob({ kind: 'budget', workspaceRoot: '/ws', maxAttempts: 3 }, { home });
    const runner = new FleetJobRunner({
      capacity: 4,
      home,
      executors: {
        budget: async () => {
          throw new BudgetExceededError({ capTokens: 10, spentTokens: 10 });
        },
      },
    });
    await runner.tick();
    const after = getFleetJob(job.id, home)!;
    assert.equal(after.status, 'failed');
    assert.equal(after.classification, 'budget_exceeded');
    assert.equal(after.attempts, 1);
    assert.equal(after.runAfter, undefined);
    assert.deepEqual(after.output, { classification: 'budget_exceeded', capTokens: 10, spentTokens: 10 });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('fleetBackoffMs grows exponentially, caps at the ceiling, and stays non-negative', () => {
  assert.equal(fleetBackoffMs(1, () => 0.5), FLEET_BASE_DELAY_MS);
  assert.equal(fleetBackoffMs(2, () => 0.5), FLEET_BASE_DELAY_MS * 2);
  assert.equal(fleetBackoffMs(50, () => 0.5), FLEET_MAX_DELAY_MS, 'caps at the ceiling');
  assert.ok(fleetBackoffMs(3, () => 0) >= 0, 'min-jitter stays non-negative');
  assert.ok(fleetBackoffMs(50, () => 1) <= FLEET_MAX_DELAY_MS, 'max-jitter never exceeds the ceiling');
});

test('accessors return defensive deep copies — mutating a returned job cannot corrupt the store', () => {
  const home = freshHome();
  try {
    const { job } = enqueueFleetJob({ kind: 'build', workspaceRoot: '/ws', input: { nested: { k: 1 } } }, { home });
    // enqueue return
    job.input.nested = { k: 999 };
    job.priority = 42;
    assert.deepEqual(getFleetJob(job.id, home)?.input, { nested: { k: 1 } }, 'enqueue return is decoupled (incl. nested)');
    assert.equal(getFleetJob(job.id, home)?.priority, 0);

    // claim return (this is the object the runner hands to an executor)
    const claimed = claimNextFleetJob(4, { home })!;
    (claimed.input.nested as { k: number }).k = -1;
    claimed.status = 'done';
    assert.equal(getFleetJob(job.id, home)?.status, 'running', 'mutating the claimed copy does not flip stored status');
    assert.deepEqual(getFleetJob(job.id, home)?.input, { nested: { k: 1 } }, 'claimed copy nested input is decoupled');

    // dedup return
    const dup = enqueueFleetJob({ kind: 'build', workspaceRoot: '/ws', idempotencyKey: 'x' }, { home });
    const dup2 = enqueueFleetJob({ kind: 'build', workspaceRoot: '/ws', idempotencyKey: 'x' }, { home });
    assert.equal(dup2.deduped, true);
    dup2.job.workspaceRoot = '/hacked';
    assert.equal(getFleetJob(dup.job.id, home)?.workspaceRoot, '/ws', 'dedup return is decoupled');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('write() prunes terminal jobs beyond MAX_TERMINAL_RETAINED but never prunes active jobs', () => {
  const home = freshHome();
  try {
    const base = new Date('2026-06-30T00:00:00.000Z').getTime();
    // Create + complete (cap + 25) jobs so the terminal set overflows.
    const overflow = 25;
    for (let i = 0; i < MAX_TERMINAL_RETAINED + overflow; i++) {
      const at = new Date(base + i * 1000);
      const { job } = enqueueFleetJob({ kind: 'echo', workspaceRoot: '/ws', input: { i } }, { home, now: at });
      claimNextFleetJob(0, { home, now: at });
      completeFleetJob(job.id, { i }, { home, now: at });
    }
    // Plus a couple of still-active jobs that must always survive.
    const live = enqueueFleetJob({ kind: 'echo', workspaceRoot: '/ws' }, { home });

    const done = listFleetJobs({ status: ['done'] }, home);
    assert.equal(done.length, MAX_TERMINAL_RETAINED, 'terminal jobs capped');
    // The OLDEST completions were dropped; the newest were kept.
    const keptIs = new Set(done.map((j) => (j.input as { i: number }).i));
    assert.ok(!keptIs.has(0), 'oldest terminal job pruned');
    assert.ok(keptIs.has(MAX_TERMINAL_RETAINED + overflow - 1), 'newest terminal job retained');
    assert.equal(getFleetJob(live.job.id, home)?.status, 'pending', 'active job never pruned');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('FleetJobRunner.start acquires the host lock; a second runner stands down and does not drain', async () => {
  const home = freshHome();
  try {
    enqueueFleetJob({ kind: 'echo', workspaceRoot: '/ws' }, { home });

    // Runner A owns the host (pid 100, alive).
    const a = new FleetJobRunner({ capacity: 4, home, lockPid: 100, lockIsAlive: () => true, executors: { echo: async () => ({}) } });
    const startA = a.start();
    assert.equal(startA.acquired, true, 'first runner acquires the lock');
    assert.equal(readFleetLock(home)?.pid, 100);
    a.stop();
    // After stop, A released the lock — but reacquire it for B's refusal test.
    const held = acquireFleetLock({ home, pid: 100, isAlive: () => true })!;
    assert.ok(held);

    // Runner B (pid 200) sees a live foreign holder → stands down, never drains.
    let drained = 0;
    const b = new FleetJobRunner({
      capacity: 4,
      home,
      lockPid: 200,
      lockIsAlive: () => true,
      executors: { echo: async () => { drained += 1; return {}; } },
    });
    const startB = b.start();
    assert.equal(startB.acquired, false, 'second runner is refused the lock');
    await b.tick(); // even a forced tick must not drain without the lock
    assert.equal(drained, 0, 'a runner without the lock does not drain');
    assert.equal(listFleetJobs({ status: ['pending'] }, home).length, 1, 'job untouched by the stood-down runner');
    held.release();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
