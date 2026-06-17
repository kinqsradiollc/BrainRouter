import test from 'node:test';
import assert from 'node:assert/strict';
import { isStaleWorkspaceEvent, nextActiveWorkspace, workspaceChanged, tagQueryId, parseQueryId, isStaleQueryResult, nextRunningWorkspaces } from './workspaceEvents.js';

const A = '/ws/alpha', B = '/ws/beta';
const ev = (workspaceRoot: string | undefined, kind: string) => ({ workspaceRoot, event: { kind } });

test('isStaleWorkspaceEvent: same workspace passes', () => {
  assert.equal(isStaleWorkspaceEvent(ev(A, 'tool-end'), A), false);
});

test('isStaleWorkspaceEvent: a DIFFERENT workspace is stale (dropped)', () => {
  assert.equal(isStaleWorkspaceEvent(ev(A, 'tool-end'), B), true);
});

test('isStaleWorkspaceEvent: session-changed is NEVER stale (it redefines the active workspace)', () => {
  assert.equal(isStaleWorkspaceEvent(ev(B, 'session-changed'), A), false);
});

test('isStaleWorkspaceEvent: untagged events always pass (legacy/no regression)', () => {
  assert.equal(isStaleWorkspaceEvent(ev(undefined, 'tool-end'), A), false);
});

test('isStaleWorkspaceEvent: before any active workspace is set, nothing is dropped', () => {
  assert.equal(isStaleWorkspaceEvent(ev(A, 'tool-end'), null), false);
});

test('nextActiveWorkspace: session-changed with a workspaceRoot switches the active workspace', () => {
  assert.equal(nextActiveWorkspace({ workspaceRoot: B, event: { kind: 'session-changed' } }, A), B);
});

test('nextActiveWorkspace: non-session-changed events do NOT change the active workspace', () => {
  assert.equal(nextActiveWorkspace({ workspaceRoot: B, event: { kind: 'tool-end' } }, A), A);
  assert.equal(nextActiveWorkspace({ workspaceRoot: B, event: { kind: 'assistant-delta' } }, A), A);
});

test('nextActiveWorkspace: a session-changed WITHOUT a workspaceRoot leaves it unchanged', () => {
  assert.equal(nextActiveWorkspace({ event: { kind: 'session-changed' } }, A), A);
});

test('workspaceChanged: switching to a different workspace → FULL refresh (branches reload)', () => {
  assert.equal(workspaceChanged(B, A), true);
});

test('workspaceChanged: same-workspace session change (new chat / switch chat) → light refresh', () => {
  assert.equal(workspaceChanged(A, A), false);
});

test('workspaceChanged: first event / boot (prev=null) → full refresh so git state loads', () => {
  assert.equal(workspaceChanged(A, null), true);
});

test('workspaceChanged: untagged event keeps the current tier', () => {
  assert.equal(workspaceChanged(undefined, A), false);
});

test('query generation: tag + parse round-trips, including ids with colons/slashes', () => {
  assert.equal(tagQueryId('q-git', 3), 'q-git#3');
  assert.deepEqual(parseQueryId('q-git#3'), { base: 'q-git', generation: 3 });
  assert.deepEqual(parseQueryId('q-wsess:/Users/x/proj#5'), { base: 'q-wsess:/Users/x/proj', generation: 5 });
});

test('query generation: an untagged (legacy) id parses with null generation', () => {
  assert.deepEqual(parseQueryId('q-git'), { base: 'q-git', generation: null });
});

test('isStaleQueryResult: a result from an OLDER generation is dropped', () => {
  assert.equal(isStaleQueryResult('q-git#2', 3), true);
});

test('isStaleQueryResult: a result from the CURRENT generation is kept', () => {
  assert.equal(isStaleQueryResult('q-git#3', 3), false);
});

test('isStaleQueryResult: an untagged id is never considered stale (no regression)', () => {
  assert.equal(isStaleQueryResult('q-git', 3), false);
});

test('running workspaces: turn-start adds the project, turn-complete removes it', () => {
  let s = new Set<string>();
  s = nextRunningWorkspaces(s, 'turn-start', A);
  assert.deepEqual([...s], [A]);
  s = nextRunningWorkspaces(s, 'turn-start', B);
  assert.deepEqual([...s].sort(), [A, B].sort());
  s = nextRunningWorkspaces(s, 'turn-complete', A);
  assert.deepEqual([...s], [B]);
});

test('running workspaces: turn-error clears a project too (failed background turn)', () => {
  let s = nextRunningWorkspaces(new Set<string>(), 'turn-start', A);
  s = nextRunningWorkspaces(s, 'turn-error', A);
  assert.equal(s.size, 0);
});

test('running workspaces: returns the SAME set reference on a no-op (cheap re-render guard)', () => {
  const s = new Set<string>([A]);
  assert.equal(nextRunningWorkspaces(s, 'turn-start', A), s, 'already-running → same ref');
  assert.equal(nextRunningWorkspaces(s, 'status', A), s, 'irrelevant kind → same ref');
  assert.equal(nextRunningWorkspaces(s, 'turn-complete', B), s, 'unknown ws complete → same ref');
  assert.equal(nextRunningWorkspaces(s, 'turn-start', undefined), s, 'untagged event → same ref');
});
