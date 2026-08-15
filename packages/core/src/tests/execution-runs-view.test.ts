/**
 * ADR-040 A40-9/A40-10 — the projection both hosts render.
 *
 * The property worth pinning is what the view does when it does NOT have the
 * events: a partial run drawn as a whole one is a view that lies, and it lies
 * in the most convincing way available — by looking complete.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toRunsListRows,
  toRunDetailView,
  runsJson,
  runDetailJson,
} from '../orchestration/execution/runsView.js';
import type { DurableRunSafeRecord } from '../orchestration/execution/runStore.js';
import type { ExecutionSnapshot } from '../orchestration/execution/reducer.js';

function record(over: Partial<DurableRunSafeRecord> = {}): DurableRunSafeRecord {
  return {
    schemaVersion: 1,
    runId: 'run-1',
    executionId: 'exec-1',
    definitionId: 'build',
    definitionHash: 'abc',
    subworkflowHashes: [],
    status: 'succeeded',
    startedAt: '2026-08-15T05:00:00.000Z',
    revision: 3,
    ...over,
  };
}

function snapshot(over: Partial<ExecutionSnapshot> = {}): ExecutionSnapshot {
  return {
    executionId: 'exec-1',
    status: 'succeeded',
    completeness: 'complete',
    watermark: 3,
    occurrences: [
      { nodeExecutionId: 'n1#1', nodeId: 'n1', attempt: 1, iterationPath: [], status: 'succeeded', childSessionIds: [], usage: { promptTokens: 1, completionTokens: 1, toolCalls: 0, wallClockMs: 5 }, terminalReasonCodes: [] },
    ],
    decisions: [],
    traversals: [],
    terminalReasonCodes: [],
    usage: { promptTokens: 1, completionTokens: 1, toolCalls: 0, wallClockMs: 5 },
    pendingSequences: [],
    truncated: false,
    ...over,
  };
}

test('a listing row says it is a summary, not a projected map', () => {
  // A listing has no event stream behind it and must not imply one.
  const rows = toRunsListRows([record()]);
  assert.equal(rows[0]!.detail, 'summary-only');
  assert.equal(rows[0]!.runId, 'run-1');
});

test('a detail view with no retained events says so instead of drawing an empty map', () => {
  // An empty node list rendered without a caveat reads as "this run did
  // nothing", which is a different and much more confident claim.
  const view = toRunDetailView(record(), undefined);
  assert.equal(view.completeness, 'unavailable');
  assert.match(view.caveat ?? '', /only its summary is known/i);
  assert.equal(view.nodes.length, 0);
});

test('a gapped snapshot carries its caveat into the view', () => {
  const view = toRunDetailView(record(), snapshot({ completeness: 'gapped' }));
  assert.equal(view.completeness, 'gapped');
  assert.match(view.caveat ?? '', /incomplete/i);
});

test('a complete snapshot carries no caveat', () => {
  const view = toRunDetailView(record(), snapshot());
  assert.equal(view.completeness, 'complete');
  assert.equal(view.caveat, undefined);
  assert.equal(view.nodes.length, 1);
});

test('completeness is taken from the snapshot, never inferred from status', () => {
  // A succeeded run whose events are missing is still a gapped MAP. Deriving
  // completeness from status would quietly upgrade it to trustworthy.
  const view = toRunDetailView(
    record({ status: 'succeeded' }),
    snapshot({ completeness: 'gapped' }),
  );
  assert.equal(view.status, 'succeeded');
  assert.equal(view.completeness, 'gapped');
});

test('both hosts get the same nodes, iteration paths intact', () => {
  const view = toRunDetailView(record(), snapshot({
    occurrences: [
      { nodeExecutionId: 'a', nodeId: 'n1', attempt: 2, iterationPath: [1, 0], status: 'failed', childSessionIds: [], usage: { promptTokens: 0, completionTokens: 0, toolCalls: 0, wallClockMs: 0 }, terminalReasonCodes: [] },
    ],
  }));
  assert.deepEqual([...view.nodes[0]!.iterationPath], [1, 0]);
  assert.equal(view.nodes[0]!.attempt, 2);
});

test('--json output is parseable and versioned', () => {
  const listing = JSON.parse(runsJson(toRunsListRows([record()])));
  assert.equal(listing.schemaVersion, 1);
  assert.equal(listing.runs.length, 1);

  const detail = JSON.parse(runDetailJson(toRunDetailView(record(), snapshot())));
  assert.equal(detail.schemaVersion, 1);
  assert.equal(detail.run.runId, 'run-1');
});

test('the json listing carries no resume material', () => {
  // The listing is built from the safe record only; this is the assertion that
  // notices if that ever stops being true.
  const serialized = runsJson(toRunsListRows([record()]));
  assert.equal(serialized.includes('resumeState'), false);
  assert.equal(serialized.includes('protected'), false);
});
