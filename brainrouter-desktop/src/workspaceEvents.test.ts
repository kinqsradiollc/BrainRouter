import test from 'node:test';
import assert from 'node:assert/strict';
import { isStaleWorkspaceEvent, nextActiveWorkspace } from './workspaceEvents.js';

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
