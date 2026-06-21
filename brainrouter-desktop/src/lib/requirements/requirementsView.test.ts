import test from 'node:test';
import assert from 'node:assert/strict';
import type { RequirementRecord } from '@kinqs/brainrouter-types';
import {
  sortRequirements, activeRequirementCount, priorityClass, linkCounts, requirementSummary,
  requirementOrigin, requirementProvenance,
} from './requirementsView.js';

const rec = (over: Partial<RequirementRecord>): RequirementRecord => ({
  id: 'req_0001',
  title: 'A requirement',
  status: 'draft',
  priority: 'medium',
  acceptanceCriteria: [],
  clarifyingQuestions: [],
  workspaceRoot: '/ws',
  taskIds: [],
  artifactIds: [],
  linkedMemoryIds: [],
  createdAt: '2026-06-17T10:00:00.000Z',
  updatedAt: '2026-06-17T10:00:00.000Z',
  ...over,
});

test('sortRequirements orders active work before archived, by status then priority', () => {
  const list = [
    rec({ id: 'done', status: 'done' }),
    rec({ id: 'archived', status: 'archived' }),
    rec({ id: 'ready-low', status: 'ready', priority: 'low' }),
    rec({ id: 'ready-high', status: 'ready', priority: 'high' }),
    rec({ id: 'draft', status: 'draft' }),
  ];
  assert.deepEqual(
    sortRequirements(list).map((r) => r.id),
    ['draft', 'ready-high', 'ready-low', 'done', 'archived'],
  );
});

test('sortRequirements breaks ties by createdAt newest-first and does not mutate input', () => {
  const list = [
    rec({ id: 'old', createdAt: '2026-06-10T00:00:00.000Z' }),
    rec({ id: 'new', createdAt: '2026-06-16T00:00:00.000Z' }),
  ];
  const sorted = sortRequirements(list);
  assert.deepEqual(sorted.map((r) => r.id), ['new', 'old']);
  assert.deepEqual(list.map((r) => r.id), ['old', 'new'], 'input array untouched');
});

test('activeRequirementCount excludes done + archived', () => {
  const list = [
    rec({ status: 'draft' }), rec({ status: 'in-progress' }), rec({ status: 'ready' }),
    rec({ status: 'done' }), rec({ status: 'archived' }),
  ];
  assert.equal(activeRequirementCount(list), 3);
});

test('priorityClass maps each priority to a severity class', () => {
  assert.equal(priorityClass('high'), 'high');
  assert.equal(priorityClass('medium'), 'medium');
  assert.equal(priorityClass('low'), 'low');
});

test('linkCounts totals tasks + artifacts + memory', () => {
  const c = linkCounts(rec({ taskIds: ['t1', 't2'], artifactIds: ['a1'], linkedMemoryIds: [] }));
  assert.deepEqual(c, { tasks: 2, artifacts: 1, memory: 0, total: 3 });
});

test('requirementSummary is a compact id · status · priority line', () => {
  assert.equal(requirementSummary(rec({ id: 'req_x', status: 'ready', priority: 'high' })), 'req_x · ready · high');
});

test('requirement provenance marks auto records and preserves trace ids', () => {
  const auto = rec({ origin: 'auto', sourceEventId: 'mem_source', linkedMemoryIds: ['mem_1', 'mem_2'] });
  assert.equal(requirementOrigin(auto), 'auto');
  assert.deepEqual(requirementProvenance(auto), {
    origin: 'auto', sourceEventId: 'mem_source', memoryIds: ['mem_1', 'mem_2'],
  });
  assert.equal(requirementOrigin(rec({})), 'manual');
});
