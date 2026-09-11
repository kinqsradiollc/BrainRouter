/**
 * ADR-057 D2 — the split view's pure helpers: which events trigger a transcript
 * reload, how a session reads as a title, and which session a fresh split opens.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldReloadOnEvent, RELOAD_EVENT_KINDS, splitSessionTitle, defaultSplitSession } from './splitSession.js';
import type { SessionRow } from '../../types.js';

const SESSIONS: SessionRow[] = [
  { sessionKey: 'a', firstUserMessage: 'fix the reranker blend regression that has been bothering the recall scores for a while now' },
  { sessionKey: 'b', firstUserMessage: 'make the sidebar live' },
  { sessionKey: 'c' },
];

test('D2 shouldReloadOnEvent fires on committed-state events, not on pure streaming', () => {
  for (const k of ['assistant-turn-end', 'turn-complete', 'turn-error', 'tool-end', 'child-complete', 'artifact', 'changeset']) assert.equal(shouldReloadOnEvent(k), true, k);
  for (const k of ['assistant-delta', 'reasoning-delta', 'turn-start', 'status', 'tokens-updated', undefined]) assert.equal(shouldReloadOnEvent(k as string), false, String(k));
  assert.ok(RELOAD_EVENT_KINDS.has('turn-complete'));
});

test('D2 splitSessionTitle uses the first message, bounds it, and falls back', () => {
  assert.equal(splitSessionTitle(SESSIONS, 'b'), 'make the sidebar live');
  assert.equal(splitSessionTitle(SESSIONS, 'a').length, 61); // 60 chars + ellipsis
  assert.ok(splitSessionTitle(SESSIONS, 'a').endsWith('…'));
  assert.equal(splitSessionTitle(SESSIONS, 'c'), 'New session');
  assert.equal(splitSessionTitle(SESSIONS, 'missing'), 'New session');
});

test('D2 defaultSplitSession picks a session other than the active one', () => {
  assert.equal(defaultSplitSession(SESSIONS, 'a'), 'b');
  assert.equal(defaultSplitSession(SESSIONS, 'b'), 'a');
  assert.equal(defaultSplitSession(SESSIONS, undefined), 'a');
  assert.equal(defaultSplitSession([], 'a'), null);
});
