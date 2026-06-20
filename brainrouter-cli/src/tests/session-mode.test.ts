import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-home-')));
process.env.BRAINROUTER_HOME = HOME;
// Keep `cli.effort` config out of the picture so effort tests exercise the
// session/workspace layers, not a machine-global config override.
delete process.env.BRAINROUTER_EFFORT;

const {
  getSessionMode,
  setSessionMode,
  clearSessionMode,
  resolveSessionMode,
  resolveActiveMode,
} = await import('@kinqs/brainrouter-core/dist/session/sessionModeStore.js');
const { writePreferences } = await import('@kinqs/brainrouter-core/dist/session/preferencesStore.js');
const { resolveRunCommandApproval } = await import('@kinqs/brainrouter-core/dist/exec/dangerousCommand.js');

const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-ws-')));

// --- store-level read/write ------------------------------------------------

test('a fresh session has no mode override', () => {
  assert.deepEqual(getSessionMode(ws, 'sess:fresh'), {});
});

test('set persists + merges; reverting/empty fields are pruned', () => {
  setSessionMode(ws, 'sess:m', { executionMode: 'fast' });
  assert.deepEqual(getSessionMode(ws, 'sess:m'), { executionMode: 'fast' });
  // merge a second axis
  setSessionMode(ws, 'sess:m', { reviewPolicy: 'proceed' });
  assert.deepEqual(getSessionMode(ws, 'sess:m'), { executionMode: 'fast', reviewPolicy: 'proceed' });
  // prune one axis by setting it back to undefined → inherits cleanly
  setSessionMode(ws, 'sess:m', { executionMode: undefined });
  assert.deepEqual(getSessionMode(ws, 'sess:m'), { reviewPolicy: 'proceed' });
});

test('prune-on-revert: clearing all fields removes the entry entirely', () => {
  setSessionMode(ws, 'sess:empty', { effort: 'high' });
  setSessionMode(ws, 'sess:empty', { effort: undefined });
  assert.deepEqual(getSessionMode(ws, 'sess:empty'), {});
  clearSessionMode(ws, 'sess:empty');
  assert.deepEqual(getSessionMode(ws, 'sess:empty'), {});
});

// --- per-session isolation -------------------------------------------------

test('per-session isolation: setting mode on A leaves B at the workspace default', () => {
  // workspace default is planning/request/medium
  setSessionMode(ws, 'sess:A', { executionMode: 'fast' });
  assert.equal(resolveActiveMode(ws, 'sess:A').executionMode, 'fast', 'A overrides to fast');
  assert.equal(resolveActiveMode(ws, 'sess:B').executionMode, 'planning', 'B still inherits workspace default');
});

test('two sessions hold DIFFERENT modes concurrently', () => {
  setSessionMode(ws, 'sess:1', { executionMode: 'fast', effort: 'high' });
  setSessionMode(ws, 'sess:2', { reviewPolicy: 'proceed' });
  assert.equal(getSessionMode(ws, 'sess:1').executionMode, 'fast');
  assert.equal(getSessionMode(ws, 'sess:1').effort, 'high');
  assert.equal(getSessionMode(ws, 'sess:2').executionMode, undefined);
  assert.equal(getSessionMode(ws, 'sess:2').reviewPolicy, 'proceed');
});

// --- restore-per-session ---------------------------------------------------

test('restore: writing A then switching away and back resolves A again', () => {
  setSessionMode(ws, 'sess:restore', { executionMode: 'fast', reviewPolicy: 'proceed' });
  // simulate switching to another session...
  const other = resolveActiveMode(ws, 'sess:other');
  assert.equal(other.executionMode, 'planning');
  // ...and switching back restores A's stance from disk.
  const back = resolveActiveMode(ws, 'sess:restore');
  assert.equal(back.executionMode, 'fast');
  assert.equal(back.reviewPolicy, 'proceed');
});

// --- pure resolveSessionMode ----------------------------------------------

test('resolveSessionMode: session overrides win over workspace stance', () => {
  const r = resolveSessionMode(
    { executionMode: 'planning', reviewPolicy: 'request', effort: 'medium' },
    { executionMode: 'fast', effort: 'high' },
  );
  assert.equal(r.executionMode, 'fast', 'from session override');
  assert.equal(r.reviewPolicy, 'request', 'falls back to workspace (no session override)');
  assert.equal(r.effort, 'high', 'from session override');
});

test('resolveSessionMode: undefined session returns the workspace stance verbatim', () => {
  const wsStance = { executionMode: 'fast' as const, reviewPolicy: 'proceed' as const, effort: 'low' as const };
  assert.deepEqual(resolveSessionMode(wsStance, undefined), wsStance);
});

// --- resolveActiveMode (filesystem entry point) ---------------------------

test('resolveActiveMode: undefined sessionKey returns the workspace prefs exactly', () => {
  const isoWs = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-iso-')));
  writePreferences(isoWs, { executionMode: 'fast', reviewPolicy: 'proceed', effort: 'high' });
  const noSession = resolveActiveMode(isoWs);
  assert.equal(noSession.executionMode, 'fast');
  assert.equal(noSession.reviewPolicy, 'proceed');
  assert.equal(noSession.effort, 'high');
  // A session with no override resolves identically to the workspace prefs.
  assert.deepEqual(resolveActiveMode(isoWs, 'sess:none'), noSession);
});

test('resolveActiveMode: session override beats the workspace pref', () => {
  const isoWs = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-iso2-')));
  writePreferences(isoWs, { executionMode: 'planning', reviewPolicy: 'request', effort: 'medium' });
  setSessionMode(isoWs, 'sess:x', { executionMode: 'fast' });
  const active = resolveActiveMode(isoWs, 'sess:x');
  assert.equal(active.executionMode, 'fast', 'session wins');
  assert.equal(active.reviewPolicy, 'request', 'workspace pref for the unset axis');
  assert.equal(active.effort, 'medium');
});

// --- gating: a fast session skips the confirm a planning session requires --

test('gating: a fast session auto-approves a safe command that a planning session asks about', () => {
  const isoWs = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-gate-')));
  // workspace default is planning; only sess:fast overrides to fast.
  setSessionMode(isoWs, 'sess:fast', { executionMode: 'fast' });

  const fastDecision = resolveRunCommandApproval(
    resolveActiveMode(isoWs, 'sess:fast'),
    'ls -la',
    { silent: false },
  );
  const planningDecision = resolveRunCommandApproval(
    resolveActiveMode(isoWs, 'sess:planning'),
    'ls -la',
    { silent: false },
  );
  assert.equal(fastDecision, 'auto-approve', 'fast session skips the confirm');
  assert.equal(planningDecision, 'ask', 'planning session still confirms');
});

test('gating: a fast session still asks for a DANGEROUS command (safety floor holds)', () => {
  const isoWs = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-gate2-')));
  setSessionMode(isoWs, 'sess:fast', { executionMode: 'fast' });
  const decision = resolveRunCommandApproval(
    resolveActiveMode(isoWs, 'sess:fast'),
    'rm -rf /tmp/x',
    { silent: false },
  );
  assert.equal(decision, 'ask', 'dangerous command prompts even in a fast session');
});
