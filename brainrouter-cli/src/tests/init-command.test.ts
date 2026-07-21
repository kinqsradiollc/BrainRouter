/**
 * `/init` subcommand routing. The handler exposes explicit test
 * seams so these tests verify command identity and chaining without mounting
 * terminal UI or mutating a workspace.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reconcileMcpAfterGlobalSetup,
  synchronizeConfigInPlace,
  tryHandleInitCommand,
  type InitCommandDependencies,
} from '../cli/commands/init/index.js';
import type { CommandContext } from '../cli/commands/_context.js';
import type { Config } from '@kinqs/brainrouter-core/config';
import { stripMcpPrefix } from '../cli/ink/text/toolFormat.js';
import type { RuntimeLaunchPolicy } from '../entry/mcpStartup.js';

function mcpHarness(events: string[]): CommandContext['mcpClient'] {
  let serverIds: string[] = [];
  return {
    setReconnectLlmConfig: (llm: Config['llm']) => events.push(
      `reconnect-llm:${llm?.provider}:${llm?.apiKey}:${llm?.model}:${llm?.endpoint ?? ''}`,
    ),
    stopReconnectSupervisor: () => events.push('stop-reconnect'),
    startReconnectSupervisor: () => events.push('start-reconnect'),
    getServerIds: () => [...serverIds],
    removeOne: async (serverId: string) => {
      events.push(`remove:${serverId}`);
      serverIds = serverIds.filter((id) => id !== serverId);
    },
    connectAll: async (servers: Config['servers']) => {
      serverIds = Object.keys(servers);
      events.push(`connect:${serverIds.join(',')}`);
      return serverIds.map((serverId) => ({ serverId, identity: 'unknown' as const, status: 'connected' as const }));
    },
  } as unknown as CommandContext['mcpClient'];
}

function context(
  args: string[],
  events: string[],
  mcpClient: object = mcpHarness(events),
  config: Config = { activeServer: '', servers: {} },
  launchPolicy: RuntimeLaunchPolicy = {},
): CommandContext {
  return {
    command: '/init',
    args,
    agent: {
      workspaceRoot: '/workspace',
      replaceLLMConfig: (llm: Config['llm']) => events.push(
        `llm:${llm?.provider}:${llm?.apiKey}:${llm?.model}:${llm?.endpoint ?? ''}`,
      ),
    },
    repl: {
      launchPolicy,
      refreshPromptForMode: () => events.push('refresh'),
      isProcessing: () => false,
      runAgentTurn: () => undefined,
      runAgentTurnAsync: async () => undefined,
    },
    config,
    mcpClient,
    rl: {},
  } as unknown as CommandContext;
}

async function withoutConsole<T>(body: () => Promise<T>): Promise<T> {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    return await body();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

async function captureConsole<T>(body: () => Promise<T>): Promise<{ result: T; output: string }> {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...values: unknown[]) => { lines.push(values.map(String).join(' ')); };
  console.error = (...values: unknown[]) => { lines.push(values.map(String).join(' ')); };
  try {
    return { result: await body(), output: lines.join('\n') };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

test('`/init agentmd` and `/init agent` are distinct commands', async () => {
  const events: string[] = [];
  const dependencies: Partial<InitCommandDependencies> = {
    initInstructions: () => {
      events.push('agentmd');
      return { status: 'created', path: '/workspace/AGENT.md' };
    },
    runAssistedSetup: async () => { events.push('assisted'); },
  };

  await withoutConsole(() => tryHandleInitCommand(context(['agentmd'], events), dependencies));
  assert.deepEqual(events, ['agentmd']);

  events.length = 0;
  await withoutConsole(() => tryHandleInitCommand(context(['agent'], events), dependencies));
  assert.deepEqual(events, ['assisted']);
});

test('`/init --edit` reloads the project flow in edit mode', async () => {
  const events: string[] = [];
  await withoutConsole(() => tryHandleInitCommand(context(['--edit'], events), {
    runProjectSetup: async (root, options) => {
      events.push(`${root}:${options?.edit === true ? 'edit' : 'create'}`);
      return { status: 'cancelled' };
    },
  }));
  assert.deepEqual(events, ['/workspace:edit']);
});

test('`/init config` applies the full committed LLM config and synchronizes shared config in place', async () => {
  const events: string[] = [];
  const sharedConfig: Config = {
    activeServer: '',
    servers: {},
    providers: {
      stale: { provider: 'openai', apiKey: 'old', model: 'old' },
    },
  };
  const originalReference = sharedConfig;
  await withoutConsole(() => tryHandleInitCommand(context(['config'], events, mcpHarness(events), sharedConfig), {
    runSequence: async (options) => {
      events.push(`${options.global}:${options.workspaceRoot}`);
      return {
        status: 'ready',
        global: 'committed',
        workspace: 'skipped',
        skipMcpForLaunch: false,
        config: {
          activeServer: '',
          servers: {},
          llm: {
            provider: 'openai-compatible',
            apiKey: 'fresh-key',
            model: 'next-model',
            endpoint: 'https://llm.example/v1',
          },
        },
      };
    },
  }));

  assert.equal(sharedConfig, originalReference, 'the REPL keeps one shared config object');
  assert.equal(sharedConfig.providers, undefined, 'optional fields absent from the committed snapshot are removed');
  assert.deepEqual(sharedConfig.llm, {
    provider: 'openai-compatible',
    apiKey: 'fresh-key',
    model: 'next-model',
    endpoint: 'https://llm.example/v1',
  });
  assert.deepEqual(events, [
    'always:/workspace',
    'llm:openai-compatible:fresh-key:next-model:https://llm.example/v1',
    'reconnect-llm:openai-compatible:fresh-key:next-model:https://llm.example/v1',
    'stop-reconnect',
    'connect:',
    'start-reconnect',
    'refresh',
  ]);
});

test('config synchronization treats __proto__ as data without polluting shared state', () => {
  const target = { activeServer: 'old', servers: {} } as Config & Record<string, unknown>;
  const committed = JSON.parse(
    '{"activeServer":"","servers":{},"__proto__":{"polluted":true}}',
  ) as Config;

  synchronizeConfigInPlace(target, committed);

  assert.equal(Object.getPrototypeOf(target), Object.prototype);
  assert.equal((target as { polluted?: boolean }).polluted, undefined);
  assert.equal(Object.hasOwn(target, '__proto__'), true, 'forward fields remain own data properties');
  assert.deepEqual(target.__proto__, { polluted: true });

  synchronizeConfigInPlace(target, { activeServer: '', servers: {} });
  assert.equal(Object.hasOwn(target, '__proto__'), false, 'later snapshots can remove the forward field');
  assert.equal(Object.getPrototypeOf(target), Object.prototype);
});

test('`/init config` replaces the Agent with active-profile and explicit-model precedence', async () => {
  const events: string[] = [];
  const sharedConfig: Config = { activeServer: '', servers: {} };
  const launchPolicy: RuntimeLaunchPolicy = { modelOverride: 'command-line-model' };
  const ctx = context(['config'], events, mcpHarness(events), sharedConfig, launchPolicy);
  let replacedLlm: Config['llm'];
  (ctx.agent as any).setLLMConfig = () => { throw new Error('merge-only API must not be used'); };
  (ctx.agent as any).replaceLLMConfig = (llm: Config['llm']) => { replacedLlm = structuredClone(llm); };

  await withoutConsole(() => tryHandleInitCommand(ctx, {
    runSequence: async () => ({
      status: 'ready',
      global: 'committed',
      workspace: 'skipped',
      skipMcpForLaunch: false,
      config: {
        activeServer: '',
        servers: {},
        llm: {
          provider: 'openai-compatible',
          apiKey: 'fresh-key',
          model: 'base-model',
          endpoint: 'https://base.example.test/v1',
          models: ['base-model', 'profile-model', 'command-line-model'],
        },
        cli: {
          activeLlmProfile: 'focused',
          llmProfiles: {
            focused: { model: 'profile-model', endpoint: 'https://profile.example.test/v1' },
          },
        },
      },
    }),
  }));

  assert.deepEqual(replacedLlm, {
    provider: 'openai-compatible',
    apiKey: 'fresh-key',
    model: 'command-line-model',
    endpoint: 'https://profile.example.test/v1',
  });
});

test('`/init config` abort does not apply model changes or refresh the prompt', async () => {
  const events: string[] = [];
  await withoutConsole(() => tryHandleInitCommand(context(['config'], events), {
    runSequence: async () => {
      events.push('global');
      return {
        status: 'global-aborted',
        global: 'aborted',
        workspace: 'not-needed',
        skipMcpForLaunch: false,
      };
    },
  }));

  assert.deepEqual(events, ['global']);
});

test('`/init config` MCP Skip disconnects the live pool and stops reconnects', async () => {
  const events: string[] = [];
  const mcpClient = {
    setReconnectLlmConfig: (llm: Config['llm']) => events.push(
      `reconnect-llm:${llm?.provider}:${llm?.apiKey}:${llm?.model}:${llm?.endpoint ?? ''}`,
    ),
    stopReconnectSupervisor: () => events.push('stop-reconnect'),
    getServerIds: () => {
      events.push('server-ids');
      return ['brain', 'github'];
    },
    removeOne: async (serverId: string) => { events.push(`remove:${serverId}`); },
  };

  await withoutConsole(() => tryHandleInitCommand(context(['config'], events, mcpClient), {
    runSequence: async () => {
      events.push('global');
      return {
        status: 'ready',
        global: 'committed',
        workspace: 'not-needed',
        skipMcpForLaunch: true,
        config: {
          activeServer: 'brain',
          servers: {
            brain: { type: 'stdio', command: 'brainrouter-mcp' },
            github: { type: 'http', url: 'https://example.test/mcp' },
          },
          llm: { provider: 'openai', apiKey: 'test', model: 'next-model' },
        },
      };
    },
  }));

  assert.deepEqual(events, [
    'global',
    'llm:openai:test:next-model:',
    'reconnect-llm:openai:test:next-model:',
    'stop-reconnect',
    'server-ids',
    'remove:brain',
    'remove:github',
    'refresh',
  ]);
});

test('live MCP reconcile selects one active brain, keeps third-party profiles, and injects workspace root', async () => {
  const events: string[] = [];
  let serverIds = ['old_brain', 'github_tools'];
  let connectedServers: Config['servers'] = {};
  const pool = {
    setReconnectLlmConfig: (llm: Config['llm']) => events.push(`reconnect-llm:${llm?.model}`),
    stopReconnectSupervisor: () => events.push('stop'),
    startReconnectSupervisor: () => events.push('start'),
    getServerIds: () => [...serverIds],
    removeOne: async (serverId: string) => {
      events.push(`remove:${serverId}`);
      serverIds = serverIds.filter((id) => id !== serverId);
    },
    connectAll: async (servers: Config['servers']) => {
      connectedServers = servers;
      serverIds = Object.keys(servers);
      events.push(`connect:${serverIds.sort().join(',')}`);
      return serverIds.map((serverId) => ({ serverId, identity: 'unknown' as const, status: 'connected' as const }));
    },
  } as unknown as CommandContext['mcpClient'];
  const config: Config = {
    activeServer: 'new_brain',
    servers: {
      old_brain: { type: 'stdio', command: 'brainrouter-mcp', identity: 'brainrouter' },
      new_brain: {
        type: 'stdio',
        command: 'brainrouter-mcp',
        args: ['--mode', 'dev', '--root', '/stale-root'],
        identity: 'brainrouter',
      },
      github_tools: { type: 'http', url: 'https://example.test/mcp', identity: 'third-party' },
    },
    llm: { provider: 'openai', apiKey: 'fresh', model: 'next-model' },
  };

  const result = await reconcileMcpAfterGlobalSetup(pool, config, '/workspace');

  assert.deepEqual(result.targetIds.sort(), ['github_tools', 'new_brain']);
  assert.deepEqual(Object.keys(connectedServers).sort(), ['github_tools', 'new_brain']);
  assert.deepEqual(connectedServers.new_brain.args, ['--mode', 'dev', '--root', '/workspace']);
  assert.deepEqual(
    config.servers.new_brain.args,
    ['--mode', 'dev', '--root', '/stale-root'],
    'launch-only workspace projection never mutates the durable config',
  );
  assert.deepEqual(result.runtimeMcp.servers.new_brain.args, ['--mode', 'dev', '--root', '/workspace']);
  assert.deepEqual(events, ['reconnect-llm:next-model', 'stop', 'remove:old_brain', 'connect:github_tools,new_brain', 'start']);
  assert.equal(stripMcpPrefix('mcp_github_tools_list_issues'), 'list_issues', 'tool formatting sees the reconciled ids');
});

test('live MCP reconcile exposes a healthy synthesized remote brain to later commands', async () => {
  const events: string[] = [];
  const config: Config = {
    activeServer: '',
    servers: {},
    cli: { brainUrl: 'https://brain.example.test/mcp' },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;
  try {
    const result = await reconcileMcpAfterGlobalSetup(mcpHarness(events), config, '/workspace');
    assert.deepEqual(result.targetIds, ['brainrouter']);
    assert.equal(config.activeBrainrouterServer, undefined);
    assert.equal(config.servers.brainrouter, undefined);
    assert.equal(result.runtimeMcp.activeBrainrouterServer, 'brainrouter');
    assert.equal(result.runtimeMcp.servers.brainrouter.type, 'http');
    assert.equal(result.runtimeMcp.servers.brainrouter.url, 'https://brain.example.test/mcp');
    assert.deepEqual(events, [
      'reconnect-llm:openai::gpt-4o-mini:',
      'stop-reconnect',
      'connect:brainrouter',
      'start-reconnect',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('live MCP reconcile preserves requested-profile and safe-mode launch constraints', async () => {
  const config: Config = {
    activeServer: 'brainrouter',
    servers: {
      brainrouter: { type: 'stdio', command: 'brainrouter-mcp', identity: 'brainrouter' },
      github: { type: 'http', url: 'https://example.test/mcp', identity: 'third-party' },
    },
    llm: { provider: 'openai', apiKey: 'fresh', model: 'next-model' },
  };

  const requestedEvents: string[] = [];
  const requested = await reconcileMcpAfterGlobalSetup(
    mcpHarness(requestedEvents),
    config,
    '/workspace',
    { requestedProfile: 'github' },
  );
  assert.deepEqual(requested.targetIds, ['github']);
  assert.deepEqual(requestedEvents, [
    'reconnect-llm:openai:fresh:next-model:',
    'stop-reconnect',
    'connect:github',
    'start-reconnect',
  ]);

  const safeEvents: string[] = [];
  const safe = await reconcileMcpAfterGlobalSetup(
    mcpHarness(safeEvents),
    config,
    '/workspace',
    { safeMode: true },
  );
  assert.deepEqual(safe.targetIds, ['brainrouter']);
  assert.deepEqual(safe.safeModeSkippedIds, ['github']);
  assert.deepEqual(safeEvents, [
    'reconnect-llm:openai:fresh:next-model:',
    'stop-reconnect',
    'connect:brainrouter',
    'start-reconnect',
  ]);
});

test('live MCP reconcile restarts the supervisor after an unexpected refresh failure', async () => {
  const events: string[] = [];
  const pool = {
    setReconnectLlmConfig: (llm: Config['llm']) => events.push(`reconnect-llm:${llm?.model}`),
    stopReconnectSupervisor: () => events.push('stop'),
    startReconnectSupervisor: () => events.push('start'),
    getServerIds: () => [],
    removeOne: async () => undefined,
    connectAll: async () => { throw new Error('tool index refresh failed'); },
  } as unknown as CommandContext['mcpClient'];

  await assert.rejects(
    reconcileMcpAfterGlobalSetup(pool, { activeServer: '', servers: {} }, '/workspace'),
    /tool index refresh failed/,
  );
  assert.deepEqual(events, ['reconnect-llm:gpt-4o-mini', 'stop', 'start']);
});

test('`/init config` applies global runtime effects even when project setup reports failure', async () => {
  const events: string[] = [];
  const sharedConfig: Config = { activeServer: 'stale', servers: {} };
  await withoutConsole(() => tryHandleInitCommand(context(['config'], events, mcpHarness(events), sharedConfig), {
    runSequence: async () => ({
      status: 'ready',
      global: 'committed',
      workspace: 'failed',
      workspaceError: 'workspace is read-only',
      skipMcpForLaunch: false,
      config: {
        activeServer: '',
        servers: {},
        llm: { provider: 'openai', apiKey: 'fresh', model: 'next-model' },
      },
    }),
  }));

  assert.equal(sharedConfig.activeServer, '');
  assert.deepEqual(events, [
    'llm:openai:fresh:next-model:',
    'reconnect-llm:openai:fresh:next-model:',
    'stop-reconnect',
    'connect:',
    'start-reconnect',
    'refresh',
  ]);
});

test('unknown `/init` options neither echo untrusted text nor fall through to project setup', async () => {
  const events: string[] = [];
  const hostileOption = 'mystery\u001b]0;forged-title\u0007\ninternal-secret';
  const { result: handled, output } = await captureConsole(() => tryHandleInitCommand(context([hostileOption], events), {
    runProjectSetup: async () => {
      events.push('project');
      return { status: 'cancelled' };
    },
  }));

  assert.equal(handled, true);
  assert.deepEqual(events, []);
  assert.match(output, /Unknown \/init option\./);
  assert.doesNotMatch(output, /mystery|forged-title|internal-secret/);
  assert.doesNotMatch(output, /\u001b\]|\u0007/, 'untrusted OSC/BEL controls are never replayed');
});

test('`/init` failure surfaces never disclose or control-inject raw errors', async () => {
  const hostileError = 'internal-secret at /Users/private/config.json \u001b]0;forged-title\u0007';
  const events: string[] = [];
  const { output } = await captureConsole(async () => {
    await tryHandleInitCommand(context(['agentmd'], events), {
      initInstructions: () => { throw new Error(hostileError); },
    });
    await tryHandleInitCommand(context(['agent'], events), {
      runAssistedSetup: async () => { throw new Error(hostileError); },
    });
    await tryHandleInitCommand(context(['scan'], events), {
      suggestProfile: () => { throw new Error(hostileError); },
    });
    await tryHandleInitCommand(context(['--edit'], events), {
      runProjectSetup: async () => { throw new Error(hostileError); },
    });
    await tryHandleInitCommand(context([], events), {
      runProjectSetup: async () => { throw new Error(hostileError); },
    });
    await tryHandleInitCommand(context(['config'], events), {
      runSequence: async () => { throw new Error(hostileError); },
    });

    const failingPool = {
      setReconnectLlmConfig: () => undefined,
      stopReconnectSupervisor: () => undefined,
      startReconnectSupervisor: () => undefined,
      getServerIds: () => [],
      removeOne: async () => undefined,
      connectAll: async () => { throw new Error(hostileError); },
    } as unknown as CommandContext['mcpClient'];
    await tryHandleInitCommand(context(['config'], events, failingPool), {
      runSequence: async () => ({
        status: 'ready',
        global: 'committed',
        workspace: 'failed',
        workspaceError: hostileError,
        skipMcpForLaunch: false,
        config: { activeServer: '', servers: {} },
      }),
    });
  });

  assert.doesNotMatch(output, /internal-secret|Users\/private|forged-title/);
  assert.doesNotMatch(output, /\u001b\]|\u0007/, 'raw error controls are never replayed');
  for (const safeMessage of [
    '/init agentmd could not finish',
    '/init agent could not finish',
    '/init scan could not finish',
    '/init --edit could not finish',
    '/init could not finish',
    '/init config could not finish',
    'live MCP refresh failed',
    'Workspace setup could not finish',
  ]) {
    assert.ok(output.includes(safeMessage), `missing safe failure message: ${safeMessage}`);
  }
});
