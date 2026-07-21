/**
 * Ordering tests for the CLI's global and workspace onboarding
 * lifecycles. Dependencies are explicit so no test can read the developer's
 * real config, mount Ink, or create an Agent while proving the startup gate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runCliOnboardingSequence,
  type CliOnboardingDependencies,
} from '../cli/commands/init/onboardingSequence.js';

interface HarnessOptions {
  globalReady?: boolean;
  workspaceReady?: boolean;
  globalCommitted?: boolean;
  workspaceStatus?: 'committed' | 'skipped' | 'cancelled';
  skipMcpForLaunch?: boolean;
  workspaceError?: string;
}

function harness(options: HarnessOptions = {}): { events: string[]; dependencies: CliOnboardingDependencies } {
  const events: string[] = [];
  const dependencies: CliOnboardingDependencies = {
    recoverGlobalSetup: () => { events.push('recover-global'); },
    hasGlobalSetup: () => options.globalReady ?? false,
    hasWorkspaceSetup: () => options.workspaceReady ?? false,
    runGlobalSetup: async () => {
      events.push('global');
      const committed = options.globalCommitted ?? true;
      return {
        state: { committed, aborted: !committed },
        skipMcpForLaunch: committed && options.skipMcpForLaunch === true,
        ...(committed ? { config: { activeServer: '', servers: {} } } : {}),
      };
    },
    runWorkspaceSetup: async () => {
      events.push('workspace');
      if (options.workspaceError) throw new Error(options.workspaceError);
      const status = options.workspaceStatus ?? 'committed';
      if (status === 'committed') {
        return {
          status,
          manifestPath: '/workspace/.brainrouter/workspace.json',
          manifest: {} as never,
        };
      }
      return { status };
    },
  };
  return { events, dependencies };
}

test('fresh startup commits global setup before workspace setup and session construction', async () => {
  const { events, dependencies } = harness();
  const result = await runCliOnboardingSequence({ workspaceRoot: '/workspace', global: 'if-needed' }, dependencies);
  events.push('agent');

  assert.equal(result.status, 'ready');
  assert.equal(result.global, 'committed');
  assert.equal(result.workspace, 'committed');
  assert.equal(result.skipMcpForLaunch, false);
  assert.deepEqual(events, ['recover-global', 'global', 'workspace', 'agent']);
});

test('startup recovery runs before the first global readiness predicate', async () => {
  let recovered = false;
  const { dependencies } = harness({ globalReady: true, workspaceReady: true });
  dependencies.recoverGlobalSetup = () => { recovered = true; };
  dependencies.hasGlobalSetup = () => {
    assert.equal(recovered, true, 'a hidden config claim must be restored before existence is checked');
    return true;
  };

  const result = await runCliOnboardingSequence(
    { workspaceRoot: '/workspace', global: 'if-needed' },
    dependencies,
  );
  assert.equal(result.status, 'ready');
  assert.equal(result.global, 'not-needed');
});

test('a configured user on a new workspace is prompted before session construction', async () => {
  const { events, dependencies } = harness({ globalReady: true });
  const result = await runCliOnboardingSequence({ workspaceRoot: '/workspace', global: 'if-needed' }, dependencies);
  events.push('agent');

  assert.equal(result.global, 'not-needed');
  assert.deepEqual(events, ['recover-global', 'workspace', 'agent']);
});

test('global abort prevents workspace onboarding and session construction', async () => {
  const { events, dependencies } = harness({ globalCommitted: false });
  const result = await runCliOnboardingSequence({ workspaceRoot: '/workspace', global: 'if-needed' }, dependencies);

  assert.equal(result.status, 'global-aborted');
  assert.equal(result.workspace, 'not-needed');
  assert.deepEqual(events, ['recover-global', 'global']);
});

test('an existing manifest suppresses automatic workspace prompting', async () => {
  const { events, dependencies } = harness({ globalReady: true, workspaceReady: true });
  const result = await runCliOnboardingSequence({ workspaceRoot: '/workspace', global: 'if-needed' }, dependencies);
  events.push('agent');

  assert.equal(result.workspace, 'not-needed');
  assert.deepEqual(events, ['recover-global', 'agent']);
});

test('workspace Skip still permits session construction', async () => {
  const { events, dependencies } = harness({ globalReady: true, workspaceStatus: 'skipped' });
  const result = await runCliOnboardingSequence({ workspaceRoot: '/workspace', global: 'if-needed' }, dependencies);
  events.push('agent');

  assert.equal(result.status, 'ready');
  assert.equal(result.workspace, 'skipped');
  assert.deepEqual(events, ['recover-global', 'workspace', 'agent']);
});

test('global MCP Skip propagates only for the current launch', async () => {
  const skipped = harness({ skipMcpForLaunch: true });
  const skippedResult = await runCliOnboardingSequence(
    { workspaceRoot: '/workspace', global: 'if-needed' },
    skipped.dependencies,
  );
  assert.equal(skippedResult.status, 'ready');
  assert.equal(skippedResult.skipMcpForLaunch, true);

  const notNeeded = harness({ globalReady: true, workspaceReady: true, skipMcpForLaunch: true });
  const nextLaunch = await runCliOnboardingSequence(
    { workspaceRoot: '/workspace', global: 'if-needed' },
    notNeeded.dependencies,
  );
  assert.equal(nextLaunch.skipMcpForLaunch, false, 'a prior Skip must not become durable');
});

test('workspace failure preserves a committed global config and launch-only MCP choice', async () => {
  const { events, dependencies } = harness({
    workspaceError: 'workspace directory became read-only',
    skipMcpForLaunch: true,
  });
  const result = await runCliOnboardingSequence(
    { workspaceRoot: '/workspace', global: 'if-needed' },
    dependencies,
  );
  events.push('agent');

  assert.equal(result.status, 'ready', 'durable global setup must remain usable');
  assert.equal(result.global, 'committed');
  assert.equal(result.workspace, 'failed');
  assert.equal(result.workspaceError, 'workspace directory became read-only');
  assert.equal(result.skipMcpForLaunch, true);
  assert.deepEqual(result.config, { activeServer: '', servers: {} });
  assert.deepEqual(events, ['recover-global', 'global', 'workspace', 'agent']);
});

test('forced global setup chains workspace setup only after a committed result', async () => {
  const committed = harness({ globalReady: true });
  const committedResult = await runCliOnboardingSequence(
    { workspaceRoot: '/workspace', global: 'always' },
    committed.dependencies,
  );
  assert.equal(committedResult.status, 'ready');
  assert.deepEqual(committed.events, ['recover-global', 'global', 'workspace']);

  const aborted = harness({ globalReady: true, globalCommitted: false });
  const abortedResult = await runCliOnboardingSequence(
    { workspaceRoot: '/workspace', global: 'always' },
    aborted.dependencies,
  );
  assert.equal(abortedResult.status, 'global-aborted');
  assert.equal(abortedResult.skipMcpForLaunch, false);
  assert.deepEqual(aborted.events, ['recover-global', 'global']);
});
