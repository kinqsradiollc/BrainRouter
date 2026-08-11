/**
 * ADR-038 — one Planner judgement suite for every host.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GROUP_LABEL,
  canEdit,
  conflictBanner,
  emptyMessage,
  estimateForItem,
  formatMinutes,
  groupFor,
  keyboardBlockTime,
  layOutDay,
  localDateOf,
  noteList,
  sortForToday,
  provenanceFor,
  visibleEstimate,
  weekStart,
  weekView,
} from './viewModel.js';
import type { PlannerBlockView, PlannerItemView } from './types.js';

const TODAY = '2026-08-11';
const item = (over: Partial<PlannerItemView> & { id: string }): PlannerItemView => ({
  title: over.id,
  completed: false,
  origin: 'owned',
  conflictFields: [],
  ...over,
});
const block = (over: Partial<PlannerBlockView> & { id: string }): PlannerBlockView => ({
  itemId: 'one',
  estimateMinutes: 60,
  carriedOver: 0,
  ...over,
});

test('ADR-038 groups a day as Now, Next, and Later without a punitive overdue badge', () => {
  const scheduled = new Set(['scheduled']);
  assert.equal(groupFor(item({ id: 'old', dueDate: '2026-08-01' }), TODAY, scheduled), 'overdue');
  assert.equal(groupFor(item({ id: 'soon', dueDate: '2026-08-15' }), TODAY, scheduled), 'next');
  assert.equal(groupFor(item({ id: 'later' }), TODAY, scheduled), 'anytime');
  assert.match(GROUP_LABEL.overdue, /^Now/);
  assert.match(GROUP_LABEL.next, /^Next/);
  assert.match(GROUP_LABEL.anytime, /^Later/);
  assert.doesNotMatch(GROUP_LABEL.overdue, /late|overdue|!/i);
});

test('ADR-038 sorting stays deterministic across both hosts', () => {
  const sorted = sortForToday([
    item({ id: 'later', title: 'Later' }),
    item({ id: 'next', title: 'Next', dueDate: '2026-08-13' }),
    item({ id: 'now', title: 'Now', dueDate: TODAY }),
    item({ id: 'old', title: 'Old', dueDate: '2026-08-01' }),
  ], TODAY, new Set());
  assert.deepEqual(sorted.map((row) => row.id), ['old', 'now', 'next', 'later']);
});

test('ADR-038 keeps source-owned fields read-only and planner metadata editable', () => {
  const mirrored = item({ id: 'issue', origin: 'mirrored', source: 'GitHub' });
  assert.equal(canEdit(mirrored, 'title'), false);
  assert.equal(canEdit(mirrored, 'completed'), false);
  assert.equal(canEdit(mirrored, 'delete'), false);
  assert.equal(canEdit(mirrored, 'priority'), true);
  assert.equal(canEdit(mirrored, 'estimateMinutes'), true);
  assert.equal(canEdit(item({
    id: 'source-action',
    origin: 'mirrored',
    capabilities: { complete: true },
  }), 'completed'), true);
});

test('ADR-038 calendar groups local dates and lays overlapping blocks into lanes', () => {
  const first = new Date(2026, 7, 11, 9).toISOString();
  const second = new Date(2026, 7, 11, 9, 30).toISOString();
  assert.equal(localDateOf(first), TODAY);
  const days = weekView([
    block({ id: 'a', scheduledFor: first }),
    block({ id: 'b', scheduledFor: second }),
  ], weekStart(TODAY), TODAY);
  assert.equal(days.length, 7);
  const layout = layOutDay(days.find((day) => day.date === TODAY)!.blocks);
  assert.deepEqual(layout.map((position) => position.lanes), [2, 2]);
  assert.equal(keyboardBlockTime('2026-08-11T09:00:00.000Z', 'ArrowDown'), '2026-08-11T10:00:00.000Z');
  assert.equal(keyboardBlockTime('2026-08-11T09:00:00.000Z', 'ArrowRight'), '2026-08-12T09:00:00.000Z');
  assert.equal(keyboardBlockTime('not-a-date', 'ArrowDown'), null);
});

test('ADR-038 presents notes, estimates, conflicts, and useful empty states', () => {
  assert.deepEqual(noteList([item({ id: 'note', notes: 'Context' }), item({ id: 'task', dueDate: TODAY })]).map((row) => row.id), ['note']);
  assert.equal(estimateForItem('one', [block({ id: 'a', estimateMinutes: 45 }), block({ id: 'b', estimateMinutes: 30 })]), 75);
  assert.equal(visibleEstimate(item({ id: 'one', estimateMinutes: 25 }), [block({ id: 'a', estimateMinutes: 45 })]), 25);
  assert.equal(formatMinutes(75), '1h 15m');
  assert.match(conflictBanner([item({ id: 'x', conflictFields: ['title'] })])!, /Both versions were kept/);
  assert.ok(emptyMessage('today').note.length > 40);
});

test('ADR-038 prefers structured provenance and carries source freshness', () => {
  const source = provenanceFor(item({
    id: 'connected',
    origin: 'mirrored',
    source: 'legacy',
    provenance: { source: 'GitHub', kind: 'issue', externalId: '#38', url: 'https://example.test/38' },
    sourceFreshness: { label: 'Refreshed yesterday', stale: true },
  }));
  assert.deepEqual(source, {
    source: 'GitHub',
    kind: 'issue',
    externalId: '#38',
    url: 'https://example.test/38',
    freshness: { label: 'Refreshed yesterday', stale: true },
  });
});
