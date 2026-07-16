import test from 'node:test';
import assert from 'node:assert/strict';
import type { ArtifactRecord } from '@kinqs/brainrouter-types';
import {
  sortArtifacts, artifactCounts, draftArtifactCount, kindLabel, statusClass, artifactSummary, isReactArtifact,
  ARTIFACT_KIND_OPTIONS, ARTIFACT_STATUS_OPTIONS, ARTIFACT_FORMAT_OPTIONS,
} from './artifactsView.js';

const rec = (over: Partial<ArtifactRecord>): ArtifactRecord => ({
  id: 'art_0001',
  kind: 'markdown-report',
  title: 'A report',
  status: 'draft',
  format: 'markdown',
  workspaceRoot: '/ws',
  linkedMemoryIds: [],
  createdAt: '2026-06-17T10:00:00.000Z',
  updatedAt: '2026-06-17T10:00:00.000Z',
  ...over,
});

test('sortArtifacts orders newest-first by createdAt and does not mutate input', () => {
  const list = [
    rec({ id: 'old', createdAt: '2026-06-10T00:00:00.000Z' }),
    rec({ id: 'new', createdAt: '2026-06-16T00:00:00.000Z' }),
    rec({ id: 'mid', createdAt: '2026-06-12T00:00:00.000Z' }),
  ];
  assert.deepEqual(sortArtifacts(list).map((a) => a.id), ['new', 'mid', 'old']);
  assert.deepEqual(list.map((a) => a.id), ['old', 'new', 'mid'], 'input array untouched');
});

test('artifactCounts tallies by status with every key present + a total', () => {
  const list = [
    rec({ status: 'draft' }), rec({ status: 'draft' }), rec({ status: 'final' }), rec({ status: 'archived' }),
  ];
  assert.deepEqual(artifactCounts(list), { draft: 2, final: 1, archived: 1, total: 4 });
});

test('draftArtifactCount counts only draft artifacts', () => {
  const list = [rec({ status: 'draft' }), rec({ status: 'final' }), rec({ status: 'draft' }), rec({ status: 'archived' })];
  assert.equal(draftArtifactCount(list), 2);
});

test('kindLabel humanizes each hyphenated kind', () => {
  assert.equal(kindLabel('design-note'), 'Design note');
  assert.equal(kindLabel('html-prototype'), 'Html prototype');
  assert.equal(kindLabel('verification-summary'), 'Verification summary');
  assert.equal(kindLabel('other'), 'Other');
});

test('statusClass prefixes the status with st-, and artifactSummary is a compact id · kind · status line', () => {
  assert.equal(statusClass('draft'), 'st-draft');
  assert.equal(statusClass('final'), 'st-final');
  assert.equal(artifactSummary(rec({ id: 'art_x', kind: 'sketch', status: 'final' })), 'art_x · sketch · final');
});

test('isReactArtifact detects jsx/tsx code artifacts (case-insensitive), not others', () => {
  assert.equal(isReactArtifact({ format: 'code', language: 'jsx' }), true);
  assert.equal(isReactArtifact({ format: 'code', language: 'TSX' }), true);
  assert.equal(isReactArtifact({ format: 'code', language: 'react' }), true);
  assert.equal(isReactArtifact({ format: 'code', language: 'ts' }), false);
  assert.equal(isReactArtifact({ format: 'code', language: undefined }), false);
  assert.equal(isReactArtifact({ format: 'markdown', language: 'jsx' }), false);
});

test('option arrays cover the full enum sets', () => {
  assert.deepEqual(ARTIFACT_STATUS_OPTIONS, ['draft', 'final', 'archived']);
  assert.deepEqual(ARTIFACT_FORMAT_OPTIONS, ['markdown', 'html', 'text']);
  assert.equal(ARTIFACT_KIND_OPTIONS.length, 7);
  assert.ok(ARTIFACT_KIND_OPTIONS.includes('review-export'));
});
