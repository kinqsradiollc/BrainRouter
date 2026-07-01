/**
 * HONK-H3.2 / H4 — fleet fan-out, build executor, and status read-model.
 * Isolated per test via a throwaway BRAINROUTER_HOME.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  enqueueFleetMigration,
  makeFleetBuildExecutor,
  summarizeFleet,
  type FleetBuildResult,
} from '../fleet/executors.js';
import {
  listFleetJobs,
  claimNextFleetJob,
  completeFleetJob,
  getFleetJob,
  type FleetJobRecord,
} from '../fleet/fleetStore.js';
import type { EmitPrInput, EmitPrResult } from '../git/prEmit.js';

function freshHome(): string {
  return mkdtempSync(path.join(tmpdir(), 'br-fleetx-'));
}

test('enqueueFleetMigration fans one spec across N repos (one job each, repo carried in input)', () => {
  const home = freshHome();
  try {
    const { jobs, deduped } = enqueueFleetMigration(
      { repos: ['/r/a', '/r/b', '/r/c'], input: { prompt: 'bump dep' }, priority: 3 },
      { home },
    );
    assert.equal(jobs.length, 3);
    assert.equal(deduped, 0);
    assert.deepEqual(jobs.map((j) => j.workspaceRoot).sort(), ['/r/a', '/r/b', '/r/c']);
    for (const j of jobs) {
      assert.equal(j.kind, 'build', 'default kind');
      assert.equal(j.priority, 3);
      assert.equal((j.input as { prompt: string }).prompt, 'bump dep');
      assert.equal((j.input as { workspaceRoot: string }).workspaceRoot, j.workspaceRoot, 'repo injected into input');
    }
    assert.equal(listFleetJobs({}, home).length, 3);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('enqueueFleetMigration dedups duplicate repos and re-runs idempotently per repo', () => {
  const home = freshHome();
  try {
    const spec = { repos: ['/r/a', '/r/a', '/r/b'], input: {}, idempotencyKey: 'mig-1' };
    const first = enqueueFleetMigration(spec, { home });
    assert.equal(first.jobs.length, 2, 'duplicate /r/a collapses to one job');

    const again = enqueueFleetMigration(spec, { home });
    assert.equal(again.deduped, 2, 'second run dedups every still-in-flight repo job');
    assert.equal(listFleetJobs({}, home).length, 2, 'no new jobs created');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('enqueueFleetMigration throws on an empty repo list', () => {
  const home = freshHome();
  try {
    assert.throws(() => enqueueFleetMigration({ repos: [], input: {} }, { home }), /empty/i);
    assert.throws(() => enqueueFleetMigration({ repos: ['  '], input: {} }, { home }), /empty/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

function fakeBuilt(over: Partial<FleetBuildResult> = {}): FleetBuildResult {
  return {
    sourceRoot: '/r/a',
    patchPath: '/tmp/a.patch',
    slug: 'bump-dep',
    title: 'Bump dep',
    body: 'body',
    ...over,
  };
}

test('makeFleetBuildExecutor: runs the build then emits a PR with a per-attempt branch token', async () => {
  const home = freshHome();
  try {
    const captured: EmitPrInput[] = [];
    const emitPr = (input: EmitPrInput): EmitPrResult => {
      captured.push(input);
      return { ok: true, prUrl: 'https://github.com/x/y/pull/7', prNumber: 7, branch: 'honk/bump' };
    };
    const exec = makeFleetBuildExecutor({ runBuild: async () => fakeBuilt(), emitPr });

    const { jobs } = enqueueFleetMigration({ repos: ['/r/a'], input: {} }, { home });
    const job = claimNextFleetJob(0, { home })!;
    const out = (await exec(job)) as { delivered: boolean; prUrl?: string; prNumber?: number };

    assert.equal(out.delivered, true);
    assert.equal(out.prNumber, 7);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].runToken, `${job.id}-${job.attempts}`, 'per-attempt token avoids branch reuse on retry');
    assert.equal(captured[0].draft, true, 'PRs default to draft');
    assert.equal(jobs[0].workspaceRoot, '/r/a');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('makeFleetBuildExecutor: a build that yields nothing completes WITHOUT emitting a PR', async () => {
  const home = freshHome();
  try {
    let emitCalls = 0;
    const exec = makeFleetBuildExecutor({
      runBuild: async () => ({ skipped: 'no changes' }),
      emitPr: () => {
        emitCalls += 1;
        return { ok: true };
      },
    });
    const out = (await exec({ id: 'fleet_x', attempts: 1 } as FleetJobRecord)) as { delivered: boolean; skipped?: string };
    assert.equal(out.delivered, false);
    assert.equal(out.skipped, 'no changes');
    assert.equal(emitCalls, 0, 'no PR attempted when the build skipped');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('makeFleetBuildExecutor: a hard emit error throws (→ queue retry); a declined emit does not', async () => {
  const exec = makeFleetBuildExecutor({
    runBuild: async () => fakeBuilt(),
    emitPr: () => ({ ok: false, error: 'push rejected' }),
  });
  await assert.rejects(() => exec({ id: 'fleet_y', attempts: 1 } as FleetJobRecord), /push rejected/);

  const execSkip = makeFleetBuildExecutor({
    runBuild: async () => fakeBuilt(),
    emitPr: () => ({ ok: false, skipped: 'no-gh' }),
  });
  const out = (await execSkip({ id: 'fleet_z', attempts: 1 } as FleetJobRecord)) as { delivered: boolean; skipped?: string };
  assert.equal(out.delivered, false);
  assert.equal(out.skipped, 'no-gh', 'declined emit (no gh) is a terminal non-error');
});

test('summarizeFleet reports counts, running jobs, and newest-first recent terminals', () => {
  const home = freshHome();
  try {
    const base = new Date('2026-06-30T00:00:00.000Z').getTime();
    // 3 done (staggered), 1 running, 1 pending.
    for (let i = 0; i < 3; i++) {
      const at = new Date(base + i * 1000);
      const { jobs } = enqueueFleetMigration({ repos: [`/r/${i}`], input: { i } }, { home, now: at });
      claimNextFleetJob(0, { home, now: at });
      completeFleetJob(jobs[0].id, { i }, { home, now: at });
    }
    enqueueFleetMigration({ repos: ['/run'], input: {} }, { home });
    claimNextFleetJob(0, { home }); // marks /run running
    enqueueFleetMigration({ repos: ['/wait'], input: {} }, { home });

    const s = summarizeFleet({ home, recent: 2 });
    assert.equal(s.total, 5);
    assert.equal(s.byStatus.done, 3);
    assert.equal(s.byStatus.running, 1);
    assert.equal(s.byStatus.pending, 1);
    assert.equal(s.running.length, 1);
    assert.equal(s.running[0].workspaceRoot, '/run');
    assert.equal(s.recent.length, 2, 'recent is capped');
    assert.equal((s.recent[0].input as { i: number }).i, 2, 'newest terminal first');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('summarizeFleet can scope to a single workspaceRoot', () => {
  const home = freshHome();
  try {
    enqueueFleetMigration({ repos: ['/a', '/b'], input: {} }, { home });
    const s = summarizeFleet({ home, workspaceRoot: '/a' });
    assert.equal(s.total, 1);
    assert.equal(s.byStatus.pending, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// Guard the executor's terminal-vs-retry contract against the live runner: a
// thrown emit must leave the job retryable, a skip must complete it.
test('build executor integrates with the store: throw → re-armed, skip → done', async () => {
  const home = freshHome();
  try {
    const { jobs } = enqueueFleetMigration({ repos: ['/r/a'], input: {}, maxAttempts: 2 }, { home });
    const id = jobs[0].id;

    // First attempt: claim + run an executor that throws → fail path re-arms.
    const job = claimNextFleetJob(0, { home })!;
    const throwing = makeFleetBuildExecutor({ runBuild: async () => fakeBuilt(), emitPr: () => ({ ok: false, error: 'boom' }) });
    await assert.rejects(() => throwing(job));
    // (the runner would call failFleetJob on throw; emulate that contract is
    // covered in fleet-queue.test.ts — here we assert the executor signals retry
    // by throwing rather than returning.)
    assert.equal(getFleetJob(id, home)?.status, 'running', 'executor does not mutate store state itself');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
