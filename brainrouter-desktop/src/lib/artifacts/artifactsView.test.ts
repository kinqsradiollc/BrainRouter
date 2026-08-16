import test from 'node:test';
import assert from 'node:assert/strict';
import type { ArtifactRecord } from '@kinqs/brainrouter-types';
import {
  sortArtifacts, artifactCounts, draftArtifactCount, kindLabel, statusClass, artifactSummary, isReactArtifact,
  ARTIFACT_KIND_OPTIONS, ARTIFACT_STATUS_OPTIONS, ARTIFACT_FORMAT_OPTIONS,
  initialSessionScope, filterBySession, showsSessionProvenance, toggleSession, sessionsIn,
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

/* ------------------------------------------------ ADR-028 B2 · session scope */

const art = (id: string, sessionKey?: string): ArtifactRecord => rec({
  id,
  createdAt: `2026-08-0${id.slice(-1)}T00:00:00.000Z`,
  ...(sessionKey ? { sessionKey } : {}),
});

test('the panel opens scoped to the current session, not to everything', () => {
  // Opening onto every artifact you have ever produced is a search problem you
  // did not ask for. Start where you are; widen deliberately.
  const scope = initialSessionScope('s1');
  assert.deepEqual([...(scope ?? [])], ['s1']);
  assert.equal(initialSessionScope(null), null, 'with no session, show everything');
});

test('a null scope means ALL, never none', () => {
  // An empty set would render an empty list — a selection the user did not make
  // that looks like a result.
  const records = [art('a1', 's1'), art('a2', 's2')];
  assert.equal(filterBySession(records, null).length, 2);
});

test('scoping to one session hides the others', () => {
  const records = [art('a1', 's1'), art('a2', 's2')];
  const only = filterBySession(records, new Set(['s1']));
  assert.deepEqual(only.map((a) => a.id), ['a1']);
});

test('provenance is required as soon as more than one session is in view', () => {
  // An aggregated list without provenance is the same misattribution the stale
  // panel caused by accident — only on purpose, which is worse.
  assert.equal(showsSessionProvenance(new Set(['s1'])), false);
  assert.equal(showsSessionProvenance(new Set(['s1', 's2'])), true);
  assert.equal(showsSessionProvenance(null), true, 'all-sessions needs it too');
});

test('deselecting the last session widens to all rather than stranding the user', () => {
  // An empty list is a dead end with no obvious way out.
  assert.equal(toggleSession(new Set(['s1']), 's1', ['s1', 's2']), null);
});

test('selecting every session collapses back to all', () => {
  const both = toggleSession(new Set(['s1']), 's2', ['s1', 's2']);
  assert.equal(both, null, 'all-selected and "all" are the same state');
});

test('toggling from "all" starts from everything, then removes one', () => {
  const scope = toggleSession(null, 's2', ['s1', 's2']);
  assert.deepEqual([...(scope ?? [])], ['s1']);
});

test('the session list is newest-first and deduplicated', () => {
  const records = [art('a1', 's1'), art('a3', 's2'), art('a2', 's1')];
  assert.deepEqual(sessionsIn(records), ['s2', 's1']);
});
