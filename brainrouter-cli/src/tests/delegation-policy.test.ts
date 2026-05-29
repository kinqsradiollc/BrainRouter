import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveDelegationPolicy,
  evaluateDelegationGate,
  isDelegationPolicy,
} from '../orchestration/delegationPolicy.js';
import { tryHandleOrchestrationCommand } from '../cli/commands/orchestration.js';
import { readPreferences } from '../state/preferencesStore.js';

test('isDelegationPolicy validates the enum', () => {
  for (const p of ['auto', 'ask-before-spawn', 'ask-before-write-child', 'no-children']) {
    assert.equal(isDelegationPolicy(p), true);
  }
  for (const p of ['ask', '', 'none', 5]) assert.equal(isDelegationPolicy(p as any), false);
});

test('resolveDelegationPolicy defaults to auto', () => {
  assert.equal(resolveDelegationPolicy({}), 'auto');
  assert.equal(resolveDelegationPolicy({ delegationPolicy: 'no-children' }), 'no-children');
});

test('auto allows everything', () => {
  for (const access of ['read', 'write', 'shell'] as const) {
    assert.equal(evaluateDelegationGate({ policy: 'auto', childAccess: access, depth: 0 }), 'allow');
  }
});

test('no-children denies at every depth', () => {
  assert.equal(evaluateDelegationGate({ policy: 'no-children', childAccess: 'read', depth: 0 }), 'deny');
  assert.equal(evaluateDelegationGate({ policy: 'no-children', childAccess: 'shell', depth: 3 }), 'deny');
});

test('ask-before-spawn asks at depth 0, allows nested', () => {
  assert.equal(evaluateDelegationGate({ policy: 'ask-before-spawn', childAccess: 'read', depth: 0 }), 'ask');
  assert.equal(evaluateDelegationGate({ policy: 'ask-before-spawn', childAccess: 'write', depth: 0 }), 'ask');
  // Nested spawns inside an approved op run freely.
  assert.equal(evaluateDelegationGate({ policy: 'ask-before-spawn', childAccess: 'write', depth: 1 }), 'allow');
});

test('ask-before-write-child asks only for write/shell at depth 0', () => {
  assert.equal(evaluateDelegationGate({ policy: 'ask-before-write-child', childAccess: 'read', depth: 0 }), 'allow');
  assert.equal(evaluateDelegationGate({ policy: 'ask-before-write-child', childAccess: 'write', depth: 0 }), 'ask');
  assert.equal(evaluateDelegationGate({ policy: 'ask-before-write-child', childAccess: 'shell', depth: 0 }), 'ask');
  assert.equal(evaluateDelegationGate({ policy: 'ask-before-write-child', childAccess: 'write', depth: 2 }), 'allow');
});

// ── /delegation-policy command ────────────────────────────────────────────

async function withTempHome(fn: (ws: string) => Promise<void>): Promise<void> {
  const prevHome = process.env.BRAINROUTER_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-delpolicy-home-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-delpolicy-ws-'));
  const origLog = console.log;
  console.log = () => {};
  process.env.BRAINROUTER_HOME = home;
  try {
    await fn(ws);
  } finally {
    console.log = origLog;
    if (prevHome === undefined) delete process.env.BRAINROUTER_HOME;
    else process.env.BRAINROUTER_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

function ctxFor(ws: string, args: string[]) {
  return {
    command: '/delegation-policy',
    args,
    agent: { workspaceRoot: ws, sessionKey: 'chat' },
    mcpClient: {},
    config: {},
    rl: {},
    repl: {},
  } as any;
}

test('/delegation-policy persists a valid policy', async () => {
  await withTempHome(async (ws) => {
    const handled = await tryHandleOrchestrationCommand(ctxFor(ws, ['no-children']));
    assert.equal(handled, true);
    assert.equal(readPreferences(ws).delegationPolicy, 'no-children');
  });
});

test('/delegation-policy rejects an unknown policy', async () => {
  await withTempHome(async (ws) => {
    await tryHandleOrchestrationCommand(ctxFor(ws, ['paranoid']));
    assert.equal(readPreferences(ws).delegationPolicy, undefined);
  });
});
