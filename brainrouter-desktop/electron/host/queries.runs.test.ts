/**
 * ADR-040 A40-10 — Desktop Runs is wired to the SAME projection the CLI renders.
 *
 * The panel shell shipped earlier, but its data path (runs.list / runs.detail)
 * was never registered, so it could only ever show an empty state — the "two
 * hosts render the same projection" guarantee was false. This drives the real
 * buildQueries handlers over a seeded durable run and asserts they return Core's
 * runsView projection, so the guarantee is now enforced, not just documented.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { HostContext } from './context.js';
import { buildQueries } from './queries.js';

function hostContext(values: Record<PropertyKey, unknown>): HostContext {
  const fallback = () => undefined;
  return new Proxy(values, {
    get: (target, key) => (Reflect.has(target, key) ? Reflect.get(target, key) : fallback),
  }) as unknown as HostContext;
}

/** Seed a durable run in the store's on-disk format (mirrors startDurableRun). */
function seedDurableRun(workspaceRoot: string, runId: string, over: Record<string, unknown> = {}): void {
  const dir = path.join(workspaceRoot, '.brainrouter', 'runs', runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'safe.json'), JSON.stringify({
    schemaVersion: 1,
    runId,
    executionId: `exec-${runId}`,
    definitionId: null,
    definitionHash: null,
    subworkflowHashes: [],
    status: 'succeeded',
    startedAt: '2026-08-16T00:00:00.000Z',
    revision: 1,
    ...over,
  }, null, 2));
}

async function call(workspaceRoot: string, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const handler = buildQueries(hostContext({ workspaceRoot }))[name];
  assert.ok(handler, `query "${name}" must be registered — the panel is dead without it`);
  return handler(args as never);
}

test('A40-10 runs.list returns Core\'s summary-only projection for the workspace', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'br-runs-list-'));
  seedDurableRun(workspaceRoot, 'run-alpha');

  const result = await call(workspaceRoot, 'runs.list');
  assert.ok(Array.isArray(result.runs));
  const row = result.runs.find((r: any) => r.runId === 'run-alpha');
  assert.ok(row, 'the seeded run is listed');
  assert.equal(row.executionId, 'exec-run-alpha');
  assert.equal(row.status, 'succeeded');
  // A listing has no event stream behind it, so it must say summary-only — not
  // imply an execution map it does not have.
  assert.equal(row.detail, 'summary-only');
});

test('A40-10 runs.detail projects an absent snapshot HONESTLY, never as an empty whole run', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'br-runs-detail-'));
  seedDurableRun(workspaceRoot, 'run-beta');

  const { run } = await call(workspaceRoot, 'runs.detail', { runId: 'run-beta' });
  assert.equal(run.runId, 'run-beta');
  assert.equal(run.executionId, 'exec-run-beta');
  // No per-run event journal is retained yet, so the view says 'unavailable'
  // with a caveat and an EMPTY node list — not a drawn map that lies by omission.
  assert.equal(run.completeness, 'unavailable');
  assert.ok(typeof run.caveat === 'string' && run.caveat.length > 0);
  assert.deepEqual(run.nodes, []);
});

test('A40-10 runs.detail returns null for a run that does not exist', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'br-runs-missing-'));
  const { run } = await call(workspaceRoot, 'runs.detail', { runId: 'ghost' });
  assert.equal(run, null);
});

test('A40-10 runs.preview returns the shared PlanPreview a launch would run', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'br-runs-preview-'));
  const { preview } = await call(workspaceRoot, 'runs.preview', { task: 'implement the billing service' });
  assert.ok(preview, 'a preview is returned for a real task');
  assert.ok('selectionSource' in preview, 'it carries the topology origin');
  assert.ok(Array.isArray(preview.stages), 'it lists the stages');
  assert.equal(typeof preview.createsChildren, 'boolean', 'it says whether the launch spawns children');
});

test('A40-10 runs.preview returns null for an empty task — there is nothing to preview', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'br-runs-preview-empty-'));
  const { preview } = await call(workspaceRoot, 'runs.preview', { task: '   ' });
  assert.equal(preview, null);
});
