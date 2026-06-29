import test from 'node:test';
import assert from 'node:assert/strict';
import type { RequirementRecord } from '@kinqs/brainrouter-types';
import type { PlanState } from '../task/taskStore.js';
import {
  parseCoversTags,
  stripCoversTags,
  parseRequirementBlocks,
  computeCoverage,
  deriveTraceStatus,
  advanceTraceStatus,
  hashRequirement,
  snapshotTrace,
  diffTrace,
  traceModelFromRecords,
  tracePlanStepsFromPlan,
  isTraceStatus,
  type TraceRequirement,
  type TracePlanStep,
} from '../requirement/trace.js';
import { recordTraceSnapshot, readTraceSnapshot, detectDrift } from '../requirement/traceStore.js';
import { withTempWorkspace } from './_helpers.js';

test('parseCoversTags: extracts ids, dedups, tolerates separators and id schemes', () => {
  assert.deepEqual(parseCoversTags('do the thing (covers: R-1, R-3)'), ['R-1', 'R-3']);
  assert.deepEqual(parseCoversTags('step (covers R-2)'), ['R-2']);
  assert.deepEqual(parseCoversTags('step (covers: req_ab12cd34)'), ['req_ab12cd34']);
  assert.deepEqual(parseCoversTags('step (COVERS: R-1 R-1 R-2)'), ['R-1', 'R-2']);
  assert.deepEqual(parseCoversTags('no tag here'), []);
});

test('stripCoversTags: removes the tag and tidies whitespace', () => {
  assert.equal(stripCoversTags('implement login flow (covers: R-1)'), 'implement login flow');
  assert.equal(stripCoversTags('a  (covers: R-1)  b'), 'a b');
  assert.equal(stripCoversTags('untouched step'), 'untouched step');
});

test('parseRequirementBlocks: headings, status suffix, and criteria', () => {
  const md = [
    '# Requirements',
    '',
    '### R-1: Login flow {ready}',
    'Some prose describing the block.',
    '- [ ] user can enter email',
    '- [x] password is masked',
    '',
    '### R-2: Logout',
    '- [ ] session is cleared',
  ].join('\n');
  const reqs = parseRequirementBlocks(md);
  assert.equal(reqs.length, 2);
  assert.equal(reqs[0].id, 'R-1');
  assert.equal(reqs[0].title, 'Login flow');
  assert.equal(reqs[0].declaredStatus, 'ready');
  assert.deepEqual(
    reqs[0].criteria,
    [
      { text: 'user can enter email', done: false },
      { text: 'password is masked', done: true },
    ],
  );
  assert.equal(reqs[1].id, 'R-2');
  assert.equal(reqs[1].declaredStatus, undefined);
  assert.equal(reqs[1].criteria.length, 1);
});

test('computeCoverage: covered/uncovered/percent', () => {
  const requirements: TraceRequirement[] = [
    { id: 'R-1', title: 'one', criteria: [] },
    { id: 'R-2', title: 'two', criteria: [] },
    { id: 'R-3', title: 'three', criteria: [] },
  ];
  const steps: TracePlanStep[] = [
    { step: 'build one', status: 'completed', covers: ['R-1'] },
    { step: 'build two', status: 'in_progress', covers: ['R-2'] },
  ];
  const report = computeCoverage(requirements, steps);
  assert.equal(report.total, 3);
  assert.equal(report.coveredCount, 2);
  assert.deepEqual(report.uncovered, ['R-3']);
  assert.equal(report.coveragePct, 67); // 2/3 rounded
  assert.equal(report.requirements.find((r) => r.id === 'R-1')?.done, true);
  assert.equal(report.requirements.find((r) => r.id === 'R-2')?.done, false);
});

test('computeCoverage: empty requirement set is 0% not NaN', () => {
  const report = computeCoverage([], []);
  assert.equal(report.coveragePct, 0);
  assert.equal(report.total, 0);
});

test('deriveTraceStatus: walks the forward-only lattice', () => {
  const noCrit: TraceRequirement = { id: 'R-1', title: 't', criteria: [] };
  const withCrit: TraceRequirement = {
    id: 'R-2',
    title: 't',
    criteria: [{ text: 'c1', done: true }, { text: 'c2', done: true }],
  };
  const withUnmetCrit: TraceRequirement = {
    id: 'R-3',
    title: 't',
    criteria: [{ text: 'c1', done: false }],
  };

  assert.equal(deriveTraceStatus(noCrit, []), 'draft');
  assert.equal(
    deriveTraceStatus(noCrit, [{ step: 's', status: 'pending', covers: ['R-1'] }]),
    'planned',
  );
  assert.equal(
    deriveTraceStatus(noCrit, [{ step: 's', status: 'in_progress', covers: ['R-1'] }]),
    'building',
  );
  // criteria-less requirement caps at `done` even when all steps complete
  assert.equal(
    deriveTraceStatus(noCrit, [{ step: 's', status: 'completed', covers: ['R-1'] }]),
    'done',
  );
  // all steps complete AND all criteria satisfied → verified
  assert.equal(
    deriveTraceStatus(withCrit, [{ step: 's', status: 'completed', covers: ['R-2'] }]),
    'verified',
  );
  // steps complete but a criterion is unmet → done, not verified
  assert.equal(
    deriveTraceStatus(withUnmetCrit, [{ step: 's', status: 'completed', covers: ['R-3'] }]),
    'done',
  );
});

test('advanceTraceStatus: never regresses', () => {
  assert.equal(advanceTraceStatus('planned', 'building'), 'building');
  assert.equal(advanceTraceStatus('building', 'planned'), 'building'); // no downgrade
  assert.equal(advanceTraceStatus('verified', 'draft'), 'verified');
  assert.equal(advanceTraceStatus('draft', 'draft'), 'draft');
  assert.ok(isTraceStatus('verified'));
  assert.ok(!isTraceStatus('nope'));
});

test('hashRequirement is deterministic and content-sensitive', () => {
  const a: TraceRequirement = { id: 'R-1', title: 'Login', criteria: [{ text: 'c1', done: false }] };
  const aAgain: TraceRequirement = { id: 'R-1', title: 'Login', criteria: [{ text: 'c1', done: false }] };
  const edited: TraceRequirement = { id: 'R-1', title: 'Login', criteria: [{ text: 'c1', done: true }] };
  assert.equal(hashRequirement(a), hashRequirement(aAgain));
  assert.notEqual(hashRequirement(a), hashRequirement(edited));
});

test('diffTrace: changed / added / removed / stale', () => {
  const before = snapshotTrace([
    { id: 'R-1', title: 'one', criteria: [] },
    { id: 'R-2', title: 'two', criteria: [] },
  ]);
  const after = snapshotTrace([
    { id: 'R-1', title: 'one EDITED', criteria: [] }, // changed
    { id: 'R-3', title: 'three', criteria: [] }, // added (R-2 removed)
  ]);
  const drift = diffTrace(before, after);
  assert.deepEqual(drift.changedIds, ['R-1']);
  assert.deepEqual(drift.addedIds, ['R-3']);
  assert.deepEqual(drift.removedIds, ['R-2']);
  assert.equal(drift.stale, true);

  const same = diffTrace(before, before);
  assert.equal(same.stale, false);
});

test('traceModelFromRecords: explicit covers tag wins over the plan anchor', () => {
  const records: RequirementRecord[] = [makeRecord('req_aaa', ['crit a']), makeRecord('req_bbb', ['crit b'])];
  const plan: PlanState = {
    updatedAt: new Date(0).toISOString(),
    requirementId: 'req_aaa',
    items: [
      { step: 'tagged step (covers: req_bbb)', status: 'completed' },
      { step: 'untagged step falls back to anchor', status: 'pending' },
    ],
  };
  const model = traceModelFromRecords(records, plan);
  assert.equal(model.requirements.length, 2);
  // tagged step covers req_bbb (explicit), untagged covers req_aaa (anchor fallback)
  const report = computeCoverage(model.requirements, model.steps);
  assert.deepEqual(report.uncovered, []);
  assert.equal(report.requirements.find((r) => r.id === 'req_bbb')?.done, true);
  assert.equal(report.requirements.find((r) => r.id === 'req_aaa')?.done, false);
});

test('tracePlanStepsFromPlan: no anchor + no tag → uncovered', () => {
  const plan: PlanState = {
    updatedAt: new Date(0).toISOString(),
    items: [{ step: 'orphan step', status: 'pending' }],
  };
  const steps = tracePlanStepsFromPlan(plan);
  assert.deepEqual(steps[0].covers, []);
});

test('traceStore: snapshot persists and round-trips', () => {
  withTempWorkspace((ws) => {
    const reqs: TraceRequirement[] = [
      { id: 'R-1', title: 'one', criteria: [{ text: 'c', done: false }] },
      { id: 'R-2', title: 'two', criteria: [] },
    ];
    const written = recordTraceSnapshot(ws, 'session:test', reqs);
    const read = readTraceSnapshot(ws, 'session:test');
    assert.deepEqual(read, written);
    assert.equal(Object.keys(read.blocks).length, 2);
  });
});

test('traceStore: detectDrift flags edits after the snapshot, clean when unchanged', () => {
  withTempWorkspace((ws) => {
    const reqs: TraceRequirement[] = [
      { id: 'R-1', title: 'one', criteria: [] },
      { id: 'R-2', title: 'two', criteria: [] },
    ];
    recordTraceSnapshot(ws, 'session:test', reqs);
    // unchanged → not stale
    assert.equal(detectDrift(ws, 'session:test', reqs).stale, false);
    // edit R-1, drop R-2, add R-3 → stale with the right buckets
    const edited: TraceRequirement[] = [
      { id: 'R-1', title: 'one EDITED', criteria: [] },
      { id: 'R-3', title: 'three', criteria: [] },
    ];
    const drift = detectDrift(ws, 'session:test', edited);
    assert.equal(drift.stale, true);
    assert.deepEqual(drift.changedIds, ['R-1']);
    assert.deepEqual(drift.addedIds, ['R-3']);
    assert.deepEqual(drift.removedIds, ['R-2']);
  });
});

test('traceStore: with no prior snapshot every requirement reads as added (stale)', () => {
  withTempWorkspace((ws) => {
    const drift = detectDrift(ws, 'session:test', [{ id: 'R-1', title: 'one', criteria: [] }]);
    assert.equal(drift.stale, true);
    assert.deepEqual(drift.addedIds, ['R-1']);
  });
});

function makeRecord(id: string, acceptanceCriteria: string[]): RequirementRecord {
  return {
    id,
    title: `req ${id}`,
    status: 'ready',
    priority: 'medium',
    acceptanceCriteria,
    clarifyingQuestions: [],
    workspaceRoot: '/tmp/ws',
    taskIds: [],
    artifactIds: [],
    linkedMemoryIds: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}
