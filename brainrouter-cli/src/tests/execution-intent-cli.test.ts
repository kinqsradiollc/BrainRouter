/**
 * ADR-040 A40-2 — CLI explicit-launch authority regression tests. The slash-command
 * host must mint an opaque intent from exact tool arguments, carry only the
 * handle beside the prompt, and refuse to start a turn when issuance fails.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { pauseGoal, readGoal, setGoal } from '@kinqs/brainrouter-core/goal';
import { createWorkflow, getCurrentWorkflow } from '@kinqs/brainrouter-core/workflow';
import { handleBuild } from '../cli/commands/orchestration/spawn.js';
import { tryHandleWorkflowCommand } from '../cli/commands/workflow/handlers.js';
import { installDispatch } from '../cli/ink/runChat/dispatch.js';
import { installTurnRunner } from '../cli/ink/runChat/turnRunner.js';
import { withTempWorkspaceAsync } from './_helpers.js';

interface TurnLaunch {
  prompt: string;
  options?: { executionIntent?: unknown };
}

function captureLogs<T>(run: () => Promise<T>): Promise<{ result: T; output: string }> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  return run()
    .then((result) => ({ result, output: lines.join('\n') }))
    .finally(() => { console.log = original; });
}

function commandContext(input: {
  command: string;
  args: string[];
  issue: (request: unknown) => Promise<unknown>;
  launches: TurnLaunch[];
}): any {
  return {
    command: input.command,
    args: input.args,
    agent: {
      issueExecutionIntent: input.issue,
    },
    mcpClient: {},
    config: {},
    rl: {},
    repl: {
      refreshPromptForMode: () => undefined,
      isProcessing: () => false,
      runAgentTurn: (prompt: string, options?: TurnLaunch['options']) => {
        input.launches.push({ prompt, options });
      },
      runAgentTurnAsync: async () => undefined,
    },
  };
}

test('ADR-040 A40-2: /workflow run mints a unique exact slug and carries its opaque handle', async () => {
  const handle = Object.freeze({ opaque: 'workflow-intent' });
  const requests: unknown[] = [];
  const launches: TurnLaunch[] = [];
  const ctx = commandContext({
    command: '/workflow',
    args: ['run', 'compare', '{"targets":["A","B"]}'],
    issue: async (request) => {
      requests.push(request);
      return handle;
    },
    launches,
  });

  const { result } = await captureLogs(() => tryHandleWorkflowCommand(ctx));

  assert.equal(result, true);
  assert.equal(requests.length, 1);
  const request = requests[0] as { source: string; toolName: string; args: { template: string; templateArgs: unknown; slug: string } };
  assert.equal(request.source, 'user-command');
  assert.equal(request.toolName, 'run_workflow');
  assert.equal(request.args.template, 'compare');
  assert.deepEqual(request.args.templateArgs, { targets: ['A', 'B'] });
  assert.match(request.args.slug, /^run-[a-f0-9]{20}$/);
  assert.equal(launches.length, 1);
  assert.equal(launches[0]?.options?.executionIntent, handle);
  assert.doesNotMatch(launches[0]?.prompt ?? '', /workflow-intent/);
  assert.match(launches[0]?.prompt ?? '', new RegExp(`slug="${request.args.slug}"`));
});

test('ADR-040 A40-2: /workflow run mints a distinct bounded slug for each launch', async () => {
  const requests: Array<{ args: { slug: string } }> = [];
  const launches: TurnLaunch[] = [];
  const ctx = commandContext({
    command: '/workflow',
    args: ['run', 'compare', '{"targets":["A","B"]}'],
    issue: async (request) => {
      requests.push(request as { args: { slug: string } });
      return Object.freeze({});
    },
    launches,
  });

  await captureLogs(() => tryHandleWorkflowCommand(ctx));
  await captureLogs(() => tryHandleWorkflowCommand(ctx));

  assert.equal(new Set(requests.map((request) => request.args.slug)).size, 2);
  assert.ok(requests.every((request) => request.args.slug.length <= 48));
});

test('ADR-040 A40-2: /workflow resume retains artifact-switch and paused-goal semantics', async () => {
  await withTempWorkspaceAsync(async (workspaceRoot) => {
    const sessionKey = 'cli:goal-resume';
    const workflow = createWorkflow(workspaceRoot, {
      title: 'Goal Artifacts',
      kind: 'feature-dev',
      sessionKey,
    });
    setGoal(workspaceRoot, 'Finish the artifact-scoped work', sessionKey);
    pauseGoal(workspaceRoot, sessionKey);
    const requests: unknown[] = [];
    const launches: TurnLaunch[] = [];
    const ctx = commandContext({
      command: '/workflow',
      args: ['resume', workflow.slug],
      issue: async (request) => {
        requests.push(request);
        return Object.freeze({ opaque: 'must-not-issue' });
      },
      launches,
    });
    Object.assign(ctx.agent, {
      workspaceRoot,
      sessionKey,
      refreshSystemPrompt: () => undefined,
    });

    const { result } = await captureLogs(() => tryHandleWorkflowCommand(ctx));

    assert.equal(result, true);
    assert.deepEqual(requests, [], 'goal resume is not a phase-run execution launch');
    assert.equal(getCurrentWorkflow(workspaceRoot, sessionKey), workflow.slug);
    assert.equal(readGoal(workspaceRoot, sessionKey)?.status, 'active');
    assert.equal(launches.length, 1, 'resumed goal still starts its next iteration');
    assert.equal(launches[0]?.options?.executionIntent, undefined);
    assert.match(launches[0]?.prompt ?? '', /Finish the artifact-scoped work/);
  });
});

test('ADR-040 A40-2: Ink slash dispatch preserves the host-only intent turn option', async () => {
  const handle = Object.freeze({ opaque: 'dispatch-intent' });
  const launches: TurnLaunch[] = [];
  const noOp = () => undefined;
  const ctx: any = {
    agent: {
      issueExecutionIntent: async () => handle,
    },
    mcpClient: {},
    config: {},
    shim: {},
    federation: null,
    controller: { push: { raw: noOp, notice: noOp } },
    runChatTurn: async (prompt: string, options?: TurnLaunch['options']) => {
      launches.push({ prompt, options });
    },
    refreshFooter: noOp,
    ensureChildRefreshTimer: noOp,
    refreshBackgroundTasks: noOp,
  };

  installDispatch(ctx);
  await ctx.dispatchSlash('/workflow', ['run', 'compare', '{"targets":["A","B"]}'], {});

  assert.equal(launches.length, 1);
  assert.equal(launches[0]?.options?.executionIntent, handle);
});

test('ADR-040 A40-2: /build binds one unique exact slug to the intent and kickoff prompt', async () => {
  const handle = Object.freeze({ opaque: 'build-intent' });
  const requests: unknown[] = [];
  const launches: TurnLaunch[] = [];
  const ctx = commandContext({
    command: '/build',
    args: ['repair', 'the', 'release', 'gate'],
    issue: async (request) => {
      requests.push(request);
      return handle;
    },
    launches,
  });

  const { result } = await captureLogs(() => handleBuild(ctx));

  assert.equal(result, true);
  assert.equal(requests.length, 1);
  const request = requests[0] as { source: string; toolName: string; args: { template: string; templateArgs: unknown; slug: string } };
  assert.equal(request.source, 'user-command');
  assert.equal(request.toolName, 'run_workflow');
  assert.equal(request.args.template, 'build');
  assert.deepEqual(request.args.templateArgs, { task: 'repair the release gate' });
  assert.match(request.args.slug, /^build-[a-f0-9]{20}$/);
  assert.equal(launches.length, 1);
  assert.equal(launches[0]?.options?.executionIntent, handle);
  assert.doesNotMatch(launches[0]?.prompt ?? '', /build-intent/);
  assert.match(launches[0]?.prompt ?? '', new RegExp(`slug "${request.args.slug}"`));
});

test('ADR-040 A40-2: explicit workflow commands do not start a turn when intent issuance fails', async () => {
  for (const command of ['/workflow', '/build'] as const) {
    const launches: TurnLaunch[] = [];
    const ctx = commandContext({
      command,
      args: command === '/workflow'
        ? ['run', 'compare', '{"targets":["A","B"]}']
        : ['repair', 'the', 'release', 'gate'],
      issue: async () => { throw new Error('Session binding changed.'); },
      launches,
    });

    const { result, output } = await captureLogs(() => command === '/workflow'
      ? tryHandleWorkflowCommand(ctx)
      : handleBuild(ctx));

    assert.equal(result, true);
    assert.equal(launches.length, 0, `${command} must fail before starting a model turn`);
    assert.match(output, /Could not authorize/);
    assert.match(output, /Session binding changed/);
  }
});

test('ADR-040 A40-2: Ink turn runner forwards only an explicitly supplied intent beside the prompt', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'br-cli-intent-turn-'));
  const handle = Object.freeze({ opaque: 'turn-intent' });
  const turnOptions: unknown[] = [];
  const noOp = () => undefined;
  const push = new Proxy({}, { get: () => noOp });
  const agent = {
    workspaceRoot,
    sessionKey: 'cli:intent-turn',
    runTurn: async (_prompt: string, _callbacks: unknown, options?: unknown) => {
      turnOptions.push(options);
      return 'Done';
    },
    lastTurnUsage: { calls: 0, promptTokens: 0, completionTokens: 0 },
    takeContradictionWarning: () => null,
    activeSkill: undefined,
    activeSkills: [],
    activeSkillDisallowedTools: [],
    activeSkillAllowedTools: undefined,
    refreshSystemPrompt: noOp,
  };
  const ctx: any = {
    agent,
    mcpClient: {},
    controller: { push },
    federation: null,
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
    await ctx.runChatTurn('Launch it.', { executionIntent: handle, ephemeral: true });
    await ctx.runChatTurn('Ordinary follow-up.', { ephemeral: true });

    assert.deepEqual(turnOptions, [{ executionIntent: handle }, undefined]);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
