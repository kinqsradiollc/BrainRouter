/**
 * ADR-040 A40-9 — the retained event journal makes `/runs <id>` rebuild the real
 * execution map from disk instead of reporting `unavailable`.
 *
 * The end-to-end test is the point: a run emits, the journal captures its events,
 * and `readRunDetail` reduces them back through the SAME reducer the live view
 * uses — so a run read back from disk answers the same questions it did live.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExecutionEvent } from '@kinqs/brainrouter-agent-protocol';
import { appendRunEvent, readRunEvents, readRunDetail, RUN_JOURNAL_BOUNDS } from '../orchestration/execution/runJournal.js';
import { startDurableRun, updateDurableRun } from '../orchestration/execution/runStore.js';
import { isTerminalRunStatus } from '../orchestration/execution/runsView.js';
import { runGraphAsCanonicalExecution } from '../orchestration/execution/graphAdapter.js';
import type { WorkflowGraph } from '../workflow/graph/graph.js';

function tmpWs(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'br-journal-')); }
function ev(seq: number, payload: unknown): ExecutionEvent {
  return { schemaVersion: 1, eventId: `e:${seq}`, executionId: 'e', executionSequence: seq, sessionKey: 's', emittedAt: '2026-08-16T00:00:00.000Z', payload };
}

test('append then read returns the events in order; malformed lines are skipped', () => {
  const ws = tmpWs();
  appendRunEvent(ws, 'run-a', ev(1, { status: 'running' }));
  appendRunEvent(ws, 'run-a', ev(2, { nodeId: 'n', attempt: 1, status: 'succeeded' }));
  // A torn last line must not make the whole history unreadable.
  fs.appendFileSync(path.join(ws, '.brainrouter', 'runs', 'run-a', 'events.jsonl'), '{ this is not json');
  const events = readRunEvents(ws, 'run-a');
  assert.deepEqual(events.map((e) => e.executionSequence), [1, 2]);
});

test('an unsafe run id is refused (no traversal), read of a missing journal is empty', () => {
  const ws = tmpWs();
  appendRunEvent(ws, '../escape', ev(1, { status: 'running' }));
  assert.equal(fs.existsSync(path.join(ws, '.brainrouter', 'runs', '..', 'escape')), false);
  assert.deepEqual(readRunEvents(ws, 'never-written'), []);
});

test('the journal is byte-bounded: it stops appending past the ceiling', () => {
  const ws = tmpWs();
  const big = 'x'.repeat(200 * 1024);
  for (let i = 0; i < 40; i += 1) appendRunEvent(ws, 'run-big', ev(i + 1, { note: big }));
  const size = fs.statSync(path.join(ws, '.brainrouter', 'runs', 'run-big', 'events.jsonl')).size;
  assert.ok(size <= RUN_JOURNAL_BOUNDS.maxBytes + 300 * 1024, 'append stopped near the ceiling, not unbounded');
});

test('a run read back from its journal rebuilds the SAME map it produced live', async () => {
  const ws = tmpWs();
  const graph: WorkflowGraph = {
    nodes: [
      { id: 't', type: 'trigger' },
      { id: 'a', type: 'set', data: { fields: { x: 1 } } },
      { id: 'out', type: 'output', data: { template: 'done' } },
    ],
    edges: [
      { id: 'e0', source: 't', target: 'a' },
      { id: 'e1', source: 'a', target: 'out' },
    ],
  };
  const live = await runGraphAsCanonicalExecution({
    graph,
    deps: { runAgent: async () => 'ok' },
    executionId: 'exec-j',
    runId: 'run-j',
    sessionKey: 'sess',
    workspaceRoot: ws,
    startedAt: '2026-08-16T00:00:00.000Z',
    definitionId: 'g',
  });
  assert.equal(live.result.ok, true);

  // Read the SAME run back from disk — no in-memory store, just the journal.
  const detail = readRunDetail(ws, 'run-j')!;
  assert.ok(detail, 'the run is readable from its retained record + journal');
  assert.equal(detail.completeness, 'complete', 'a full journal reduces to a complete map, not unavailable');
  assert.equal(detail.caveat, undefined);
  // The nodes the run executed are present in the rebuilt map.
  const nodeIds = detail.nodes.map((n) => n.nodeId).sort();
  assert.deepEqual(nodeIds, ['a', 'out', 't']);
  assert.ok(detail.nodes.every((n) => n.status === 'succeeded'));
});

test('a run with a durable record but NO journal reads back as unavailable, honestly', async () => {
  const ws = tmpWs();
  // Create a durable record WITHOUT a journal by projecting in-memory only
  // (no workspaceRoot on the run) then seeding just the durable half.
  await runGraphAsCanonicalExecution({
    graph: { nodes: [{ id: 't', type: 'trigger' }], edges: [] },
    deps: { runAgent: async () => '' },
    executionId: 'exec-n', runId: 'run-n', sessionKey: 's',
    workspaceRoot: ws, startedAt: '2026-08-16T00:00:00.000Z',
  });
  // Delete the journal, keep the durable record.
  fs.rmSync(path.join(ws, '.brainrouter', 'runs', 'run-n', 'events.jsonl'), { force: true });
  const detail = readRunDetail(ws, 'run-n')!;
  assert.equal(detail.completeness, 'unavailable');
  assert.ok(detail.caveat && detail.caveat.length > 0);
});

test('A40-9 live updates — the map grows as events append, and turns terminal when the run finishes', () => {
  // This is what `/runs <id> --watch` polls: readRunDetail re-reduces the journal
  // each tick, so a new occurrence appears as it is emitted, and isTerminalRunStatus
  // tells the watch loop when to stop. The re-read is idempotent (the reducer dedupes
  // by (executionId, sequence)), so polling the whole file each tick is correct.
  const ws = tmpWs();
  startDurableRun({ workspaceRoot: ws, runId: 'live', executionId: 'e', startedAt: '2026-08-16T00:00:00.000Z' });
  appendRunEvent(ws, 'live', ev(1, { status: 'running' }));
  const d1 = readRunDetail(ws, 'live')!;
  assert.equal(isTerminalRunStatus(d1.status), false, 'a running run keeps the watch polling');
  const before = d1.nodes.length;

  appendRunEvent(ws, 'live', ev(2, { nodeId: 'n1', attempt: 1, status: 'succeeded' }));
  const d2 = readRunDetail(ws, 'live')!;
  assert.ok(d2.nodes.length > before, 'the map grew as an event appended — the live update');

  updateDurableRun(ws, 'live', { status: 'succeeded', endedAt: '2026-08-16T00:01:00.000Z' });
  const d3 = readRunDetail(ws, 'live')!;
  assert.equal(isTerminalRunStatus(d3.status), true, 'once terminal, the watch loop stops');
});
