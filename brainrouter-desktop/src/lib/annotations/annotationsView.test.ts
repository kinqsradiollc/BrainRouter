import test from 'node:test';
import assert from 'node:assert/strict';
import type { AnnotationRecord } from '@kinqs/brainrouter-types';
import {
  sortAnnotations, annotationCounts, openAnnotationCount, severityClass, statusClass,
  anchorLabel, annotationSummary, annotationLinkCounts,
  ANNOTATION_STATUS_OPTIONS, ANNOTATION_SEVERITY_OPTIONS, ANNOTATION_TARGET_KIND_OPTIONS,
} from './annotationsView.js';

const rec = (over: Partial<AnnotationRecord>): AnnotationRecord => ({
  id: 'ann_0001',
  type: 'review-finding',
  body: 'A comment',
  workspaceRoot: '/ws',
  status: 'open',
  linkedMemoryIds: [],
  createdAt: '2026-06-17T10:00:00.000Z',
  updatedAt: '2026-06-17T10:00:00.000Z',
  ...over,
});

test('sortAnnotations orders newest-first by createdAt and does not mutate input', () => {
  const list = [
    rec({ id: 'old', createdAt: '2026-06-10T00:00:00.000Z' }),
    rec({ id: 'new', createdAt: '2026-06-16T00:00:00.000Z' }),
    rec({ id: 'mid', createdAt: '2026-06-12T00:00:00.000Z' }),
  ];
  assert.deepEqual(sortAnnotations(list).map((a) => a.id), ['new', 'mid', 'old']);
  assert.deepEqual(list.map((a) => a.id), ['old', 'new', 'mid'], 'input array untouched');
});

test('annotationCounts tallies by status with every key present + a total', () => {
  const list = [
    rec({ status: 'open' }), rec({ status: 'open' }), rec({ status: 'accepted' }),
    rec({ status: 'resolved' }), rec({ status: 'ignored' }),
  ];
  assert.deepEqual(annotationCounts(list), {
    open: 2, accepted: 1, rejected: 0, resolved: 1, ignored: 1, total: 5,
  });
});

test('openAnnotationCount counts only open annotations', () => {
  const list = [rec({ status: 'open' }), rec({ status: 'accepted' }), rec({ status: 'open' }), rec({ status: 'resolved' })];
  assert.equal(openAnnotationCount(list), 2);
});

test('severityClass maps each severity (and undefined→info) to a sev class', () => {
  assert.equal(severityClass('high'), 'high');
  assert.equal(severityClass('low'), 'low');
  assert.equal(severityClass(undefined), 'info');
});

test('statusClass prefixes the status with st-', () => {
  assert.equal(statusClass('open'), 'st-open');
  assert.equal(statusClass('resolved'), 'st-resolved');
});

test('anchorLabel renders file:line ranges, bare lines, blocks, and empties', () => {
  assert.equal(anchorLabel(undefined), '');
  assert.equal(anchorLabel({ filePath: 'src/a.ts' }), 'src/a.ts');
  assert.equal(anchorLabel({ filePath: 'src/a.ts', startLine: 12 }), 'src/a.ts:12');
  assert.equal(anchorLabel({ filePath: 'src/a.ts', startLine: 12, endLine: 18 }), 'src/a.ts:12-18');
  assert.equal(anchorLabel({ filePath: 'src/a.ts', startLine: 12, endLine: 12 }), 'src/a.ts:12');
  assert.equal(anchorLabel({ startLine: 5, endLine: 7 }), 'line 5-7');
  assert.equal(anchorLabel({ block: 'recall()' }), 'block recall()');
});

test('annotationSummary is a compact id · type · status line, and link counts total memory', () => {
  assert.equal(annotationSummary(rec({ id: 'ann_x', type: 'file', status: 'accepted' })), 'ann_x · file · accepted');
  assert.deepEqual(annotationLinkCounts(rec({ linkedMemoryIds: ['m1', 'm2'] })), { memory: 2, total: 2 });
});

test('option arrays cover the full enum sets', () => {
  assert.deepEqual(ANNOTATION_STATUS_OPTIONS, ['open', 'accepted', 'rejected', 'resolved', 'ignored']);
  assert.deepEqual(ANNOTATION_SEVERITY_OPTIONS, ['info', 'low', 'medium', 'high']);
  assert.equal(ANNOTATION_TARGET_KIND_OPTIONS.length, 9);
  assert.ok(ANNOTATION_TARGET_KIND_OPTIONS.includes('review-finding'));
});
