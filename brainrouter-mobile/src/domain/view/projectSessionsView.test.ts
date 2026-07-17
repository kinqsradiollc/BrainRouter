import test from 'node:test';
import assert from 'node:assert/strict';
import type { SessionRow } from '../../types.js';
import {
  PROJECT_SESSION_BASE,
  filterProjectSessions,
  loadingProjectSessions,
  nextProjectVisibleCount,
  normalizeProjectSessionsResult,
  projectMatches,
  projectMoreLabel,
  projectSessionsNeedRefresh,
  reorderProjectRoots,
  sidebarProjectRoots,
  shouldShowProjectToggle,
  visibleProjectSessions,
  withCachedProjectSessions,
} from './projectSessionsView.js';

const rows: SessionRow[] = [
  { sessionKey: 'new-1', firstUserMessage: 'Improve the desktop sidebar' },
  { sessionKey: 'new-2', firstUserMessage: 'Review plan annotations' },
  { sessionKey: 'abc-3', firstUserMessage: 'Fix CI checks' },
  { sessionKey: 'abc-4', firstUserMessage: 'Editor polish' },
  { sessionKey: 'abc-5', firstUserMessage: 'Branch refresh' },
  { sessionKey: 'abc-6', firstUserMessage: 'Artifacts preview' },
  { sessionKey: 'abc-7', firstUserMessage: 'Workspace switching' },
];

test('normalizeProjectSessionsResult accepts legacy array results', () => {
  const state = normalizeProjectSessionsResult(rows, 1234);
  assert.equal(state.rows.length, rows.length);
  assert.equal(state.loading, false);
  assert.equal(state.error, null);
  assert.equal(state.loadedAt, 1234);
});

test('normalizeProjectSessionsResult accepts object results with truncation', () => {
  const state = normalizeProjectSessionsResult({ rows, truncated: true }, 5678);
  assert.equal(state.rows.length, rows.length);
  assert.equal(state.truncated, true);
  assert.equal(state.loadedAt, 5678);
});

test('loadingProjectSessions preserves old rows while marking refresh in flight', () => {
  const prev = normalizeProjectSessionsResult(rows, 10);
  const state = loadingProjectSessions(prev, 20);
  assert.equal(state.rows.length, rows.length);
  assert.equal(state.loading, true);
  assert.equal(state.loadedAt, 10);
});

test('withCachedProjectSessions mirrors active-session rows into a project cache', () => {
  const cached = withCachedProjectSessions({
    '/w/a': { rows: [], loading: true, error: 'old error', loadedAt: 1, truncated: true },
  }, '/w/a', rows, 30);
  assert.deepEqual(cached['/w/a'].rows, rows);
  assert.equal(cached['/w/a'].loading, false);
  assert.equal(cached['/w/a'].error, null);
  assert.equal(cached['/w/a'].loadedAt, 30);
  assert.equal(cached['/w/a'].truncated, true);
});

test('projectSessionsNeedRefresh treats missing and stale data as refreshable', () => {
  assert.equal(projectSessionsNeedRefresh(undefined, 100), true);
  assert.equal(projectSessionsNeedRefresh({ rows, loading: true, error: null, loadedAt: 1 }, 100, 10), false);
  assert.equal(projectSessionsNeedRefresh({ rows, loading: false, error: null, loadedAt: 95 }, 100, 10), false);
  assert.equal(projectSessionsNeedRefresh({ rows, loading: false, error: null, loadedAt: 80 }, 100, 10), true);
});

test('sidebarProjectRoots keeps active project in the persisted position', () => {
  assert.deepEqual(sidebarProjectRoots('/w/b', ['/w/a', '/w/b', '/w/c']), ['/w/a', '/w/b', '/w/c']);
  assert.deepEqual(sidebarProjectRoots('/w/current', ['/w/a', '/w/a', '/w/b']), ['/w/current', '/w/a', '/w/b']);
  assert.deepEqual(sidebarProjectRoots(null, ['/w/a', '/w/a', '/w/b']), ['/w/a', '/w/b']);
});

test('reorderProjectRoots moves dragged project before the drop target', () => {
  assert.deepEqual(reorderProjectRoots(['/w/a', '/w/b', '/w/c'], '/w/c', '/w/a'), ['/w/c', '/w/a', '/w/b']);
  assert.deepEqual(reorderProjectRoots(['/w/a', '/w/b', '/w/c'], '/w/a', '/w/c'), ['/w/b', '/w/a', '/w/c']);
  assert.deepEqual(reorderProjectRoots(['/w/a', '/w/b'], '/missing', '/w/a'), ['/w/a', '/w/b']);
});

test('filterProjectSessions matches title or session key', () => {
  assert.deepEqual(filterProjectSessions(rows, 'sidebar').map((r) => r.sessionKey), ['new-1']);
  assert.deepEqual(filterProjectSessions(rows, 'abc-3').map((r) => r.sessionKey), ['abc-3']);
  assert.equal(filterProjectSessions(rows, '').length, rows.length);
});

test('projectMatches checks root, folder name, and loaded session titles', () => {
  assert.equal(projectMatches('/tmp/SWI-UI', rows, 'swi'), true);
  assert.equal(projectMatches('/tmp/SWI-UI', rows, 'workspace switching'), true);
  assert.equal(projectMatches('/tmp/SWI-UI', rows, 'not-present'), false);
});

test('visibleProjectSessions and show-more helpers page expanded projects', () => {
  const visible = visibleProjectSessions(rows, '', PROJECT_SESSION_BASE);
  assert.equal(visible.length, PROJECT_SESSION_BASE);
  assert.equal(projectMoreLabel(rows.length, visible.length), 'Show 1 more');
  assert.equal(shouldShowProjectToggle(rows.length, visible.length), true);
  assert.equal(nextProjectVisibleCount(PROJECT_SESSION_BASE, rows.length), rows.length);
  assert.equal(nextProjectVisibleCount(rows.length, rows.length), PROJECT_SESSION_BASE);
});
