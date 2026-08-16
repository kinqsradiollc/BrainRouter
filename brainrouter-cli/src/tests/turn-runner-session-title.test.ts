/**
 * ADR-034 CLI first-title publication regression. It drives the production
 * turn runner, then completes the asynchronous title callback after the first
 * turn has already settled to prove no second prompt is needed and stale
 * callbacks cannot rename a rebound participant.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installTurnRunner } from '../cli/ink/runChat/turnRunner.js';

test('first-turn async title publishes immediately only to its still-current federation generation', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'br-cli-title-publish-'));
  let sessionKey = 'cli:title-a';
  let onSessionTitle: ((event: { title: string; source: 'agent' }) => void) | undefined;
  let onSteerExpired: ((input: {
    id: string;
    text: string;
    source: 'peer-session';
    createdAt: number;
    sender: { sessionKey: string; deviceId: string };
  }) => void) | undefined;
  const registrationUpdates: Array<Record<string, unknown>> = [];
  const transitions: Array<{ id: string; status: string; reason?: string }> = [];
  const agent = {
    workspaceRoot,
    sessionKey,
    getFederationSessionKey: () => sessionKey,
    runTurn: async (_input: string, callbacks: {
      onSessionTitle?: typeof onSessionTitle;
      onSteerExpired?: typeof onSteerExpired;
    }) => {
      onSessionTitle = callbacks.onSessionTitle;
      onSteerExpired = callbacks.onSteerExpired;
      return 'First answer';
    },
    lastTurnUsage: { calls: 0, promptTokens: 0, completionTokens: 0 },
    sessionUsage: { calls: 0, promptTokens: 0, completionTokens: 0 },
    takeContradictionWarning: () => null,
    activeSkill: undefined,
    activeSkills: [],
    activeSkillDisallowedTools: [],
    activeSkillAllowedTools: undefined,
    refreshSystemPrompt: () => undefined,
  };
  const noOp = () => undefined;
  const push = new Proxy({}, { get: () => noOp });
  const federation = {
    get sessionKey() { return sessionKey; },
    updateRegistration: async (patch: Record<string, unknown>) => {
      registrationUpdates.push({ ...patch });
      return {};
    },
    transitionInbound: async (id: string, status: string, reason?: string) => {
      transitions.push({ id, status, reason });
      return true;
    },
  };
  const ctx: any = {
    agent,
    mcpClient: {},
    config: {},
    inputQueue: {},
    controller: { push },
    federation,
    isProcessing: false,
    isQuiet: () => false,
    cancelChildResume: noOp,
    clearIdleHint: noOp,
    scheduleGoalContinuation: noOp,
    scheduleChildResume: noOp,
    refreshFooter: noOp,
    refreshBackgroundTasks: noOp,
    ensureChildRefreshTimer: noOp,
    notifyIdleCompletions: noOp,
    armIdleHint: noOp,
    drainInputQueue: noOp,
  };
  try {
    installTurnRunner(ctx);
    await ctx.runChatTurn('Name this first turn');
    assert.ok(onSessionTitle, 'production runTurn callbacks include onSessionTitle');
    assert.equal(registrationUpdates.some((patch) => patch.title === 'Release readiness'), false);

    onSessionTitle!({ title: 'Release readiness', source: 'agent' });
    await Promise.resolve();
    assert.equal(registrationUpdates.some((patch) =>
      patch.title === 'Release readiness' && patch.titleSource === 'agent'), true);

    assert.ok(onSteerExpired, 'production runTurn callbacks include safe-boundary expiry');
    onSteerExpired!({
      id: 'expired-peer-input',
      text: 'Too old to apply.',
      source: 'peer-session',
      createdAt: Date.now() - 24 * 60 * 60 * 1_000 - 1,
      sender: { sessionKey: 'cli:sender', deviceId: '11111111-1111-4111-8111-111111111111' },
    });
    await Promise.resolve();
    assert.deepEqual(transitions, [{
      id: 'expired-peer-input',
      status: 'expired',
      reason: 'Message expired before recipient safe-boundary application.',
    }]);

    sessionKey = 'cli:title-b';
    agent.sessionKey = sessionKey;
    onSessionTitle!({ title: 'Stale title', source: 'agent' });
    await Promise.resolve();
    assert.equal(registrationUpdates.some((patch) => patch.title === 'Stale title'), false);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
