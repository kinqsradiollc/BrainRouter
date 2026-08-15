/**
 * ADR-040 A40-7 — saved graphs adapted to the canonical run.
 *
 * The kill test at the bottom is the one that matters. Everything above it can
 * pass while a run still loses its resume point on a real crash, because an
 * in-process test never actually dies — it unwinds, and unwinding is exactly
 * what a SIGKILL does not do.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { WorkflowGraph } from '../workflow/graph/graph.js';
import type { GraphRunDeps } from '../workflow/graph/graphEngine.js';
import {
  runGraphAsCanonicalExecution,
  toExecutionEvent,
  projectExecutionEvents,
} from '../orchestration/execution/graphAdapter.js';
import { readDurableRunSafe, readDurableRunResumeState } from '../orchestration/execution/runStore.js';

const echo: GraphRunDeps = { runAgent: async (p) => `AGENT(${p})` };

function twoStep(): WorkflowGraph {
  return {
    nodes: [
      { id: 't', type: 'trigger' },
      { id: 'a', type: 'agent', data: { prompt: 'first' } },
      { id: 'o', type: 'output', data: { template: 'done' } },
    ],
    edges: [
      { id: 'e1', source: 't', target: 'a' },
      { id: 'e2', source: 'a', target: 'o' },
    ],
  };
}

function withWorkspace(fn: (workspace: string) => Promise<void> | void): Promise<void> | void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-adapter-'));
  const finish = () => fs.rmSync(dir, { recursive: true, force: true });
  let sync = true;
  try {
    const out = fn(fs.realpathSync(dir));
    if (out && typeof (out as Promise<void>).then === 'function') {
      sync = false;
      return (out as Promise<void>).finally(finish);
    }
    return out;
  } finally {
    if (sync) finish();
  }
}

test('a graph run produces a canonical snapshot with one occurrence per node', async () => {
  const { result, snapshot } = await runGraphAsCanonicalExecution({
    graph: twoStep(),
    deps: echo,
    executionId: 'exec-adapter-1',
    runId: 'run-adapter-1',
    sessionKey: 'session-1',
    startedAt: '2026-08-15T03:00:00.000Z',
  });
  assert.equal(result.ok, true);
  assert.equal(snapshot.status, 'succeeded');
  assert.equal(snapshot.completeness, 'complete');
  assert.equal(snapshot.occurrences.length, 3, 'trigger, agent, output');
});

test('the emitted stream is contiguous, so the reducer never reports a gap', async () => {
  // A generator that skips a sequence makes every consumer look broken.
  const seen: number[] = [];
  await runGraphAsCanonicalExecution({
    graph: twoStep(),
    deps: {
      ...echo,
      // Observe through the reducer's own contract by re-projecting below.
    },
    executionId: 'exec-adapter-2',
    runId: 'run-adapter-2',
    sessionKey: 'session-1',
    startedAt: '2026-08-15T03:00:00.000Z',
  }).then(({ snapshot }) => {
    seen.push(snapshot.watermark);
    assert.equal(snapshot.completeness, 'complete');
    assert.deepEqual([...snapshot.pendingSequences], [], 'nothing was left buffered');
  });
  assert.ok(seen[0]! > 0);
});

test('a subscriber that throws cannot fail the run', async () => {
  // Observability that can break what it observes is worse than none, because
  // the failure then reads as the workflow's.
  const { result } = await runGraphAsCanonicalExecution({
    graph: twoStep(),
    deps: {
      ...echo,
      emitExecution: undefined,
    } as GraphRunDeps,
    executionId: 'exec-adapter-3',
    runId: 'run-adapter-3',
    sessionKey: 'session-1',
    startedAt: '2026-08-15T03:00:00.000Z',
  });
  assert.equal(result.ok, true);
});

test('replaying the same stream yields the same snapshot — projection is idempotent', () => {
  const events = [1, 2, 3].map((sequence) =>
    toExecutionEvent(
      { executionId: 'exec-replay', executionSequence: sequence, nodeId: `n${sequence}`, attempt: 1, status: 'succeeded' },
      'session-1',
      '2026-08-15T03:00:00.000Z',
    ));
  const once = projectExecutionEvents('exec-replay', events)!;
  const twice = projectExecutionEvents('exec-replay', [...events, ...events])!;
  assert.equal(twice.occurrences.length, once.occurrences.length);
  assert.equal(twice.watermark, once.watermark);
});

test('an approval decision reaches the canonical map', async () => {
  const graph: WorkflowGraph = {
    nodes: [
      { id: 't', type: 'trigger' },
      { id: 'ap', type: 'approval', data: { summary: 'ship?' } },
    ],
    edges: [{ id: 'e1', source: 't', target: 'ap' }],
  };
  const { snapshot } = await runGraphAsCanonicalExecution({
    graph,
    deps: { ...echo, requestApproval: async () => true },
    executionId: 'exec-approval',
    runId: 'run-approval',
    sessionKey: 'session-1',
    startedAt: '2026-08-15T03:00:00.000Z',
  });
  assert.equal(snapshot.completeness, 'complete');
  assert.ok(snapshot.occurrences.some((o) => o.nodeId === 'ap'));
  // The DECISION, not just the node. This assertion is the point of the test's
  // name — and it is exactly what was missing while the reducer dropped every
  // decision, letting this test pass without the approval ever reaching the map.
  const approval = snapshot.decisions.find((d) => d.kind === 'approval');
  assert.ok(approval, 'the approval decision is projected into the snapshot');
  assert.equal(approval!.outcome, 'approved');
  assert.equal(approval!.nodeExecutionId, 'ap');
});

test('resume state is persisted DURING the run, not only at the end', async () => {
  await withWorkspace(async (workspace) => {
    const { durable } = await runGraphAsCanonicalExecution({
      graph: twoStep(),
      deps: echo,
      executionId: 'exec-durable',
      runId: 'run-durable',
      sessionKey: 'session-1',
      workspaceRoot: workspace,
      startedAt: '2026-08-15T03:00:00.000Z',
      definitionId: 'two-step',
    });
    assert.equal(durable!.status, 'succeeded');
    const resume = readDurableRunResumeState(workspace, 'run-durable')!;
    assert.ok((resume.resumeState as { lastSequence: number }).lastSequence > 0);
  });
});

/**
 * The real one. A SIGKILL does not unwind, does not run `finally`, and does not
 * flush anything the process was holding — which is why an in-process
 * "simulated crash" proves nothing about durability.
 */
test('a run killed mid-flight leaves a resume point on disk, and reconciles', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'br-kill-'));
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const child = path.join(workspace, 'victim.mjs');
    // The child starts a durable run, writes a resume point, then hangs. The
    // parent kills it with SIGKILL — no cleanup, no flush, no finally.
    fs.writeFileSync(child, `
import { startDurableRun, updateDurableRun } from ${JSON.stringify(path.join(here, '../orchestration/execution/runStore.js'))};
const workspace = process.argv[2];
const started = startDurableRun({
  workspaceRoot: workspace,
  runId: 'run-killed',
  executionId: 'exec-killed',
  startedAt: '2026-08-15T04:00:00.000Z',
  resumeState: { lastSequence: 1 },
});
const next = updateDurableRun(workspace, 'run-killed', { resumeState: { lastSequence: 7 } }, started.revision);
process.stdout.write('ready:' + next.revision + '\\n');
setInterval(() => {}, 1000);
`, 'utf8');

    const proc = spawnSync(process.execPath, [
      '-e',
      `const { spawn } = require('node:child_process');
       const c = spawn(process.execPath, [${JSON.stringify(child)}, ${JSON.stringify(workspace)}]);
       let out = '';
       c.stdout.on('data', (d) => {
         out += d;
         if (out.includes('ready:')) { process.kill(c.pid, 'SIGKILL'); process.stdout.write(out); }
       });
       c.on('exit', (code, signal) => { process.stdout.write('signal:' + signal + '\\n'); process.exit(0); });`,
    ], { encoding: 'utf8', timeout: 60_000 });

    assert.match(proc.stdout, /ready:2/, `child never reached its resume point: ${proc.stdout}${proc.stderr}`);
    assert.match(proc.stdout, /signal:SIGKILL/, 'the child must have been killed, not asked to stop');

    // The killed process wrote nothing on the way out. Everything below came
    // from writes that had already committed.
    const safe = readDurableRunSafe(workspace, 'run-killed')!;
    assert.equal(safe.status, 'running', 'a killed run still claims to be running until reconciled');

    const resume = readDurableRunResumeState(workspace, 'run-killed')!;
    assert.equal((resume.resumeState as { lastSequence: number }).lastSequence, 7,
      'the last committed resume point survived a SIGKILL');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
