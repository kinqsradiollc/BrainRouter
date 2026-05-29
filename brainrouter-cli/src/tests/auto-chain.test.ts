import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveAutoChainMode,
  autoChainRoles,
  isAutoChainMode,
} from '../orchestration/autoChain.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tryHandleOrchestrationCommand } from '../cli/commands/orchestration.js';
import { readPreferences } from '../state/preferencesStore.js';

test('isAutoChainMode validates the enum', () => {
  for (const m of ['off', 'review', 'verify', 'both']) assert.equal(isAutoChainMode(m), true);
  for (const m of ['on', 'reviewer', '', 7, null]) assert.equal(isAutoChainMode(m as any), false);
});

test('resolveAutoChainMode prefers autoChain, falls back to legacy autoReview', () => {
  assert.equal(resolveAutoChainMode({ autoChain: 'both' }), 'both');
  assert.equal(resolveAutoChainMode({ autoChain: 'verify', autoReview: false }), 'verify');
  // No autoChain → derive from legacy boolean.
  assert.equal(resolveAutoChainMode({ autoReview: true }), 'review');
  assert.equal(resolveAutoChainMode({ autoReview: false }), 'off');
  assert.equal(resolveAutoChainMode({}), 'off');
});

test('autoChainRoles maps modes and respects the cap', () => {
  assert.deepEqual(autoChainRoles('off'), []);
  assert.deepEqual(autoChainRoles('review'), ['reviewer']);
  assert.deepEqual(autoChainRoles('verify'), ['verifier']);
  assert.deepEqual(autoChainRoles('both'), ['reviewer', 'verifier']);
  // Cap trims the list.
  assert.deepEqual(autoChainRoles('both', 1), ['reviewer']);
  assert.deepEqual(autoChainRoles('both', 0), []);
});

function ctxFor(workspace: string, command: string, args: string[]) {
  return {
    command,
    args,
    agent: { workspaceRoot: workspace, sessionKey: 'chat' },
    mcpClient: {},
    config: {},
    rl: {},
    repl: {},
  } as any;
}

/**
 * Async-safe temp harness (the shared `withTempWorkspace` is sync-only
 * and would clean up before an awaited command body finished). Sets
 * BRAINROUTER_HOME so preferences write to a throwaway location.
 */
async function withTempHome(fn: (ws: string) => Promise<void>): Promise<void> {
  const prevHome = process.env.BRAINROUTER_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-autochain-home-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-autochain-ws-'));
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

test('/auto-chain persists the mode (and syncs the legacy boolean)', async () => {
  await withTempHome(async (ws) => {
    const handled = await tryHandleOrchestrationCommand(ctxFor(ws, '/auto-chain', ['both']));
    assert.equal(handled, true);
    assert.equal(readPreferences(ws).autoChain, 'both');
    assert.equal(readPreferences(ws).autoReview, true);
  });
});

test('/auto-chain rejects an unknown mode without persisting', async () => {
  await withTempHome(async (ws) => {
    await tryHandleOrchestrationCommand(ctxFor(ws, '/auto-chain', ['sometimes']));
    assert.equal(readPreferences(ws).autoChain, undefined);
  });
});

test('/auto-review is a thin alias that sets autoChain review|off', async () => {
  await withTempHome(async (ws) => {
    await tryHandleOrchestrationCommand(ctxFor(ws, '/auto-review', ['on']));
    assert.equal(readPreferences(ws).autoChain, 'review');
    await tryHandleOrchestrationCommand(ctxFor(ws, '/auto-review', ['off']));
    assert.equal(readPreferences(ws).autoChain, 'off');
  });
});
