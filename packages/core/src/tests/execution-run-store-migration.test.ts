/**
 * ADR-040 A40-6 — legacy WorkflowRun migration.
 *
 * The failures pinned here are the quiet ones: a migration that deletes the
 * ledger it read, that double-writes on the second open, or that reports a
 * crashed legacy run as still running.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureRun, finishRun, readRun } from '../workflow/run/workflowRun.js';
import { getWorkflowDir } from '../workflow/run/workflowArtifacts.js';
import { readDurableRunSafe, listDurableRuns } from '../orchestration/execution/runStore.js';
import {
  migrateLegacyWorkflowRuns,
  openDurableRuns,
  _resetDurableRunsOpenCache,
} from '../orchestration/execution/runStoreMigration.js';

function withWorkspace(fn: (workspace: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-runmig-'));
  const previousHome = process.env.BRAINROUTER_HOME;
  // getWorkflowsRoot resolves the WORKSPACE-local .brainrouter, but a stray
  // home pointing into the workspace could confuse other state; keep them apart.
  process.env.BRAINROUTER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'br-runmig-home-'));
  _resetDurableRunsOpenCache();
  try {
    fn(fs.realpathSync(dir));
  } finally {
    if (previousHome === undefined) delete process.env.BRAINROUTER_HOME;
    else process.env.BRAINROUTER_HOME = previousHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Seed a legacy run.json for `slug`, finished to `status`, with a stable runId. */
function seedLegacyRun(workspace: string, slug: string, status: 'completed' | 'failed' | 'running', runId?: string): void {
  ensureRun(workspace, slug, { now: '2026-08-15T06:00:00.000Z' });
  if (runId) {
    const p = path.join(getWorkflowDir(workspace, slug), 'run.json');
    const run = JSON.parse(fs.readFileSync(p, 'utf8'));
    run.runId = runId;
    fs.writeFileSync(p, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  }
  if (status !== 'running') finishRun(workspace, slug, status, '2026-08-15T06:05:00.000Z');
}

test('a completed legacy run becomes a durable succeeded record', () => {
  withWorkspace((workspace) => {
    seedLegacyRun(workspace, 'ship-it', 'completed', 'run-ship');
    const result = migrateLegacyWorkflowRuns(workspace);
    assert.deepEqual([...result.migrated], ['run-ship']);

    const durable = readDurableRunSafe(workspace, 'run-ship')!;
    assert.equal(durable.status, 'succeeded');
    assert.equal(durable.definitionHash, null, 'a legacy run has no content hash to claim');
    assert.equal(durable.startedAt, '2026-08-15T06:00:00.000Z');
    assert.equal(durable.endedAt, '2026-08-15T06:05:00.000Z');
  });
});

test('a legacy run left running migrates to interrupted, not running', () => {
  // The owning process is gone by the time new code reads an old ledger; calling
  // it "running" would strand it exactly like an unreconciled crash.
  withWorkspace((workspace) => {
    seedLegacyRun(workspace, 'was-running', 'running', 'run-live');
    migrateLegacyWorkflowRuns(workspace);
    assert.equal(readDurableRunSafe(workspace, 'run-live')!.status, 'interrupted');
  });
});

test('a failed legacy run stays failed', () => {
  withWorkspace((workspace) => {
    seedLegacyRun(workspace, 'broke', 'failed', 'run-broke');
    migrateLegacyWorkflowRuns(workspace);
    assert.equal(readDurableRunSafe(workspace, 'run-broke')!.status, 'failed');
  });
});

test('migration is non-destructive — the legacy ledger survives', () => {
  withWorkspace((workspace) => {
    seedLegacyRun(workspace, 'keep-me', 'completed', 'run-keep');
    migrateLegacyWorkflowRuns(workspace);
    const legacy = readRun(workspace, 'keep-me');
    assert.ok(legacy, 'the legacy run.json must still be readable after migration');
    assert.equal(legacy!.status, 'completed');
  });
});

test('migration is idempotent — a second pass writes nothing new', () => {
  withWorkspace((workspace) => {
    seedLegacyRun(workspace, 'once', 'completed', 'run-once');
    const first = migrateLegacyWorkflowRuns(workspace);
    assert.deepEqual([...first.migrated], ['run-once']);

    const second = migrateLegacyWorkflowRuns(workspace);
    assert.deepEqual([...second.migrated], [], 'nothing new on the second pass');
    assert.deepEqual([...second.skipped], ['run-once']);
    // Exactly one durable record, not two.
    assert.equal(listDurableRuns(workspace).runs.filter((r) => r.runId === 'run-once').length, 1);
  });
});

test('a legacy run with no runId gets a stable derived id', () => {
  withWorkspace((workspace) => {
    seedLegacyRun(workspace, 'no-id-here', 'completed');
    const result = migrateLegacyWorkflowRuns(workspace);
    assert.deepEqual([...result.migrated], ['legacy-no-id-here']);
    // Stable across passes: the derived id must be deterministic.
    const again = migrateLegacyWorkflowRuns(workspace);
    assert.deepEqual([...again.skipped], ['legacy-no-id-here']);
  });
});

test('openDurableRuns migrates once per process and is a no-op after', () => {
  withWorkspace((workspace) => {
    seedLegacyRun(workspace, 'boot', 'completed', 'run-boot');
    const first = openDurableRuns(workspace);
    assert.deepEqual([...first.migrated], ['run-boot']);
    const second = openDurableRuns(workspace);
    assert.deepEqual([...second.migrated], [], 'second open is the guarded no-op');
  });
});

test('a workspace with no legacy runs migrates nothing and does not throw', () => {
  withWorkspace((workspace) => {
    const result = migrateLegacyWorkflowRuns(workspace);
    assert.deepEqual([...result.migrated], []);
    assert.deepEqual([...result.skipped], []);
  });
});
