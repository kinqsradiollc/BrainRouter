/**
 * ADR-040 A40-6 — durable run storage.
 *
 * The failures pinned here all look like success from the outside: a second
 * launch that quietly takes over the first's directory, a resume that reads
 * stale state after a torn write, and a crashed run that reports itself as
 * still going.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  startDurableRun,
  updateDurableRun,
  readDurableRunSafe,
  readDurableRunResumeState,
  listDurableRuns,
  reconcileInterruptedRuns,
  hashDefinition,
  RUN_STORE_BOUNDS,
} from '../orchestration/execution/runStore.js';

function withWorkspace(fn: (workspace: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-runstore-'));
  try {
    fn(fs.realpathSync(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function start(workspace: string, runId: string, startedAt: string, resumeState?: unknown) {
  return startDurableRun({
    workspaceRoot: workspace,
    runId,
    executionId: `exec-${runId}`,
    definitionId: 'build',
    definitionHash: hashDefinition({ template: 'build' }),
    startedAt,
    resumeState,
  });
}

test('each launch gets its own home, and a second launch cannot take it over', () => {
  // Two saved runs of the same workflow are two runs. Sharing a path by
  // definition id means the second silently erases the first.
  withWorkspace((workspace) => {
    start(workspace, 'run-a', '2026-08-15T01:00:00.000Z');
    assert.throws(() => start(workspace, 'run-a', '2026-08-15T02:00:00.000Z'));
    assert.equal(readDurableRunSafe(workspace, 'run-a')!.startedAt, '2026-08-15T01:00:00.000Z');
  });
});

test('resume material is separate from the listing, and is not world-readable', () => {
  withWorkspace((workspace) => {
    start(workspace, 'run-b', '2026-08-15T01:00:00.000Z', { cursor: 42 });

    const safe = readDurableRunSafe(workspace, 'run-b')!;
    assert.equal('resumeState' in (safe as unknown as Record<string, unknown>), false,
      'the safe record must never carry resume material');

    const resume = readDurableRunResumeState(workspace, 'run-b')!;
    assert.deepEqual(resume.resumeState, { cursor: 42 });

    const mode = fs.statSync(path.join(workspace, '.brainrouter', 'runs', 'run-b', 'protected.json')).mode;
    assert.equal(mode & 0o077, 0, 'protected payload must not be group- or world-readable');
  });
});

test('a listing never carries resume material for any run', () => {
  withWorkspace((workspace) => {
    start(workspace, 'run-c', '2026-08-15T01:00:00.000Z', { secretish: 'resume-token' });
    const serialized = JSON.stringify(listDurableRuns(workspace));
    assert.equal(serialized.includes('resume-token'), false);
  });
});

test('a stale writer loses instead of overwriting a newer revision', () => {
  withWorkspace((workspace) => {
    const created = start(workspace, 'run-d', '2026-08-15T01:00:00.000Z');
    updateDurableRun(workspace, 'run-d', { status: 'succeeded' }, created.revision);
    // A second writer still holding the original revision.
    assert.throws(
      () => updateDurableRun(workspace, 'run-d', { status: 'failed' }, created.revision),
      /moved on/i,
    );
    assert.equal(readDurableRunSafe(workspace, 'run-d')!.status, 'succeeded');
  });
});

test('a torn pair refuses to resume rather than resuming from stale state', () => {
  // If the safe half advanced and the protected half did not, the resume point
  // is not a resume point. Continuing from it is worse than refusing.
  withWorkspace((workspace) => {
    const created = start(workspace, 'run-e', '2026-08-15T01:00:00.000Z', { step: 1 });
    // Advance the safe half only — exactly what a crash between the two writes
    // leaves behind.
    updateDurableRun(workspace, 'run-e', { status: 'running' }, created.revision);
    assert.equal(readDurableRunResumeState(workspace, 'run-e'), undefined);
  });
});

test('updating both halves keeps them in step', () => {
  withWorkspace((workspace) => {
    const created = start(workspace, 'run-f', '2026-08-15T01:00:00.000Z', { step: 1 });
    const next = updateDurableRun(
      workspace,
      'run-f',
      { status: 'running', resumeState: { step: 2 } },
      created.revision,
    );
    const resume = readDurableRunResumeState(workspace, 'run-f')!;
    assert.equal(resume.revision, next.revision);
    assert.deepEqual(resume.resumeState, { step: 2 });
  });
});

test('a run left running by a crash reconciles to interrupted', () => {
  // Reporting a dead run as running forever is how it keeps a queue slot and a
  // person keeps waiting for it.
  withWorkspace((workspace) => {
    start(workspace, 'run-g', '2026-08-15T01:00:00.000Z');
    const done = start(workspace, 'run-h', '2026-08-15T02:00:00.000Z');
    updateDurableRun(workspace, 'run-h', { status: 'succeeded' }, done.revision);

    const reconciled = reconcileInterruptedRuns(workspace);
    assert.deepEqual([...reconciled], ['run-g']);
    assert.equal(readDurableRunSafe(workspace, 'run-g')!.status, 'interrupted');
    assert.equal(readDurableRunSafe(workspace, 'run-h')!.status, 'succeeded',
      'a finished run is not touched');
  });
});

test('a corrupt run is skipped, not thrown on — one bad file cannot hide the rest', () => {
  withWorkspace((workspace) => {
    start(workspace, 'run-i', '2026-08-15T01:00:00.000Z');
    start(workspace, 'run-j', '2026-08-15T02:00:00.000Z');
    fs.writeFileSync(
      path.join(workspace, '.brainrouter', 'runs', 'run-i', 'safe.json'),
      '{ this is not json',
      'utf8',
    );
    const listing = listDurableRuns(workspace);
    assert.equal(listing.runs.length, 1);
    assert.equal(listing.runs[0]!.runId, 'run-j');
  });
});

test('listing is newest-first and pages without repeating or skipping', () => {
  withWorkspace((workspace) => {
    for (let i = 0; i < 7; i += 1) {
      start(workspace, `run-p${i}`, `2026-08-15T0${i}:00:00.000Z`);
    }
    const first = listDurableRuns(workspace, { limit: 3 });
    assert.equal(first.runs[0]!.runId, 'run-p6', 'newest first');
    assert.equal(first.runs.length, 3);
    assert.ok(first.nextCursor);

    const second = listDurableRuns(workspace, { limit: 3, cursor: first.nextCursor });
    const ids = [...first.runs, ...second.runs].map((r) => r.runId);
    assert.equal(new Set(ids).size, ids.length, 'no run appears on two pages');
    assert.deepEqual(ids, ['run-p6', 'run-p5', 'run-p4', 'run-p3', 'run-p2', 'run-p1']);
  });
});

test('the definition hash is fixed at launch and does not follow later edits', () => {
  // Otherwise a run claims to have executed whatever the definition says today.
  withWorkspace((workspace) => {
    const created = start(workspace, 'run-k', '2026-08-15T01:00:00.000Z');
    updateDurableRun(workspace, 'run-k', { status: 'succeeded' }, created.revision);
    assert.equal(readDurableRunSafe(workspace, 'run-k')!.definitionHash, created.definitionHash);
    assert.notEqual(created.definitionHash, hashDefinition({ template: 'something-else' }));
  });
});

test('retention prunes the oldest launches rather than growing forever', () => {
  withWorkspace((workspace) => {
    const total = RUN_STORE_BOUNDS.maxRetainedRuns + 5;
    for (let i = 0; i < total; i += 1) {
      const stamp = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
      start(workspace, `run-r${String(i).padStart(4, '0')}`, stamp);
    }
    const remaining = fs.readdirSync(path.join(workspace, '.brainrouter', 'runs'));
    assert.ok(
      remaining.length <= RUN_STORE_BOUNDS.maxRetainedRuns,
      `expected <= ${RUN_STORE_BOUNDS.maxRetainedRuns}, found ${remaining.length}`,
    );
    assert.equal(readDurableRunSafe(workspace, 'run-r0000'), undefined, 'the oldest went');
  });
});
