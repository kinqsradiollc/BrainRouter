import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runCliOnboardingSequence,
  type CliOnboardingDependencies,
  type GlobalOnboardingResult,
} from '../cli/commands/init/onboardingSequence.js';
import type { ProjectOnboardingResult } from '../cli/commands/init/projectOnboard.js';

function dependencies(options: {
  globalReady?: boolean;
  workspaceReady?: boolean;
  globalResult?: GlobalOnboardingResult;
  workspaceResult?: ProjectOnboardingResult;
  workspaceError?: Error;
} = {}): { deps: CliOnboardingDependencies; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      hasGlobalSetup: () => {
        calls.push('has-global');
        return options.globalReady ?? false;
      },
      hasWorkspaceSetup: () => {
        calls.push('has-workspace');
        return options.workspaceReady ?? false;
      },
      runGlobalSetup: async () => {
        calls.push('run-global');
        return options.globalResult ?? { state: { committed: true, aborted: false } };
      },
      runWorkspaceSetup: async () => {
        calls.push('run-workspace');
        if (options.workspaceError) throw options.workspaceError;
        return options.workspaceResult ?? { status: 'skipped' };
      },
    },
  };
}

test('fresh startup runs global setup before workspace setup', async () => {
  const { deps, calls } = dependencies({
    globalResult: { state: { committed: true, aborted: false }, mcpSkipped: true },
    workspaceResult: { status: 'committed', manifest: {} as never, manifestPath: '/workspace/.brainrouter/workspace.json' },
  });
  const result = await runCliOnboardingSequence({ workspaceRoot: '/workspace', global: 'if-needed' }, deps);
  assert.deepEqual(calls, ['has-global', 'run-global', 'has-workspace', 'run-workspace']);
  assert.equal(result.status, 'ready');
  assert.equal(result.global, 'committed');
  assert.equal(result.workspace, 'committed');
  assert.equal(result.mcpSkipped, true);
});

test('aborting global setup prevents workspace setup and session readiness', async () => {
  const { deps, calls } = dependencies({
    globalResult: { state: { committed: false, aborted: true } },
  });
  const result = await runCliOnboardingSequence({ workspaceRoot: '/workspace', global: 'if-needed' }, deps);
  assert.deepEqual(calls, ['has-global', 'run-global']);
  assert.deepEqual(result, {
    status: 'global-aborted',
    global: 'aborted',
    workspace: 'not-needed',
    mcpSkipped: false,
  });
});

test('configured users run only missing workspace setup', async () => {
  const { deps, calls } = dependencies({ globalReady: true, workspaceResult: { status: 'skipped' } });
  const result = await runCliOnboardingSequence({ workspaceRoot: '/workspace', global: 'if-needed' }, deps);
  assert.deepEqual(calls, ['has-global', 'has-workspace', 'run-workspace']);
  assert.equal(result.global, 'not-needed');
  assert.equal(result.workspace, 'skipped');
});

test('fully configured users do not mount either setup flow', async () => {
  const { deps, calls } = dependencies({ globalReady: true, workspaceReady: true });
  const result = await runCliOnboardingSequence({ workspaceRoot: '/workspace', global: 'if-needed' }, deps);
  assert.deepEqual(calls, ['has-global', 'has-workspace']);
  assert.equal(result.workspace, 'not-needed');
});

test('forced global setup still runs before any missing workspace setup', async () => {
  const { deps, calls } = dependencies({ globalReady: true });
  const result = await runCliOnboardingSequence({ workspaceRoot: '/workspace', global: 'always' }, deps);
  assert.deepEqual(calls, ['run-global', 'has-workspace', 'run-workspace']);
  assert.equal(result.global, 'committed');
});

test('workspace failure is reported without undoing committed global setup', async () => {
  const { deps } = dependencies({
    workspaceError: new Error('workspace unavailable: OPENAI_API_KEY=sk-do-not-print'),
  });
  const result = await runCliOnboardingSequence({ workspaceRoot: '/workspace', global: 'if-needed' }, deps);
  assert.equal(result.status, 'ready');
  assert.equal(result.global, 'committed');
  assert.equal(result.workspace, 'failed');
  assert.equal(result.workspaceError, 'workspace unavailable: OPENAI_API_KEY=[REDACTED]');
});
