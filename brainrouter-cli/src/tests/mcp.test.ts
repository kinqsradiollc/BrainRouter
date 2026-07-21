import test from 'node:test';
import assert from 'node:assert/strict';
import { callMcpTool, childSessionKey, extractToolText, safeJsonParse } from '@kinqs/brainrouter-core/mcp';
import {
  createSession,
  getSession,
  listSessions,
  updateSession,
  executeOrchestrationTool,
} from '@kinqs/brainrouter-core/orchestration';
import { _resetCliKnobsCache, setCliKnobOverride } from '@kinqs/brainrouter-core/config';
import type { Config } from '@kinqs/brainrouter-core/config';
import { normalizeSkillsList } from '../cli/commands/workflow/index.js';
import { tryHandleMcpCommand } from '../cli/commands/mcp/index.js';
import {
  McpProfilePersistenceError,
  reconcileLiveMcpProfile,
  resolveEffectiveMcpProfile,
} from '../cli/mcpProfileLifecycle.js';
import type { CommandContext } from '../cli/commands/_context.js';
import { withTempWorkspace, withTempWorkspaceAsync } from './_helpers.js';

test('McpClientWrapper.isConnected is false before connect', async () => {
  const { McpClientWrapper } = await import('@kinqs/brainrouter-core/mcp');
  const wrapper = new McpClientWrapper();
  assert.equal(wrapper.isConnected(), false);
});

test('resolveIdentityFromConfig: explicit identity wins over heuristics (10a)', async () => {
  const { resolveIdentityFromConfig } = await import('@kinqs/brainrouter-core/mcp');
  assert.equal(
    resolveIdentityFromConfig(
      { type: 'http', url: 'https://example.com', identity: 'third-party' },
      'brainrouter-cloud',
    ),
    'third-party',
    'explicit `identity: third-party` beats a brainrouter-shaped name',
  );
  assert.equal(
    resolveIdentityFromConfig({ type: 'stdio', command: '/usr/bin/foo', identity: 'brainrouter' }),
    'brainrouter',
    'explicit `identity: brainrouter` beats a non-brainrouter command path',
  );
});

test('resolveIdentityFromConfig: name prefix and URL host detect BrainRouter (10a)', async () => {
  const { resolveIdentityFromConfig } = await import('@kinqs/brainrouter-core/mcp');
  // Name prefix.
  assert.equal(
    resolveIdentityFromConfig({ type: 'http', url: 'https://example.com' }, 'brainrouter-cloud'),
    'brainrouter',
  );
  assert.equal(
    resolveIdentityFromConfig({ type: 'http', url: 'https://example.com' }, 'BrainRouter'),
    'brainrouter',
    'case-insensitive name prefix',
  );
  assert.equal(
    resolveIdentityFromConfig({ type: 'http', url: 'https://example.com' }, 'github'),
    'unknown',
    'non-brainrouter name → unknown (let tool-signature decide)',
  );

  // URL host pattern.
  assert.equal(
    resolveIdentityFromConfig({ type: 'http', url: 'https://api.brainrouter.cloud' }, 'local-http'),
    'brainrouter',
  );
  assert.equal(
    resolveIdentityFromConfig({ type: 'http', url: 'https://example.brainrouter.dev/mcp' }, 'staging'),
    'brainrouter',
  );
  assert.equal(resolveIdentityFromConfig({ type: 'http', url: 'https://random.example.com' }, 'whatever'), 'unknown');

  // Stdio command basename.
  assert.equal(resolveIdentityFromConfig({ type: 'stdio', command: '/usr/local/bin/brainrouter-mcp' }), 'brainrouter');
  assert.equal(resolveIdentityFromConfig({ type: 'stdio', command: 'github-mcp' }), 'unknown');
});

test('McpClientWrapper.getIdentity returns "unknown" before listTools (10a)', async () => {
  const { McpClientWrapper } = await import('@kinqs/brainrouter-core/mcp');
  const wrapper = new McpClientWrapper();
  assert.equal(wrapper.getIdentity(), 'unknown');
});

test('McpClientWrapper.listTools returns empty list when disconnected (offline mode)', async () => {
  const { McpClientWrapper } = await import('@kinqs/brainrouter-core/mcp');
  const wrapper = new McpClientWrapper();
  const res = await wrapper.listTools();
  assert.deepEqual(res, { tools: [] });
});

test('McpClientWrapper.callTool returns an error envelope when disconnected (offline mode)', async () => {
  const { McpClientWrapper } = await import('@kinqs/brainrouter-core/mcp');
  const wrapper = new McpClientWrapper();
  const res = await wrapper.callTool('memory_recall', { query: 'anything' });
  const env = res as { isError: boolean; content: Array<{ type: string; text: string }> };
  assert.equal(env.isError, true);
  assert.match(env.content[0].text, /MCP server is not connected/);
  assert.match(env.content[0].text, /memory_recall/);
});

test('/mcp connect uses the effective profile and launch model for future reconnect state', async () => {
  const config: Config = {
    activeServer: 'github',
    servers: {
      github: { type: 'http', url: 'https://example.test/mcp', identity: 'third-party' },
    },
    llm: {
      provider: 'openai-compatible',
      apiKey: 'fresh-key',
      model: 'base-model',
      endpoint: 'https://base.example.test/v1',
      models: ['base-model', 'profile-model', 'command-model'],
    },
    cli: {
      activeLlmProfile: 'focused',
      llmProfiles: {
        focused: { model: 'profile-model', endpoint: 'https://profile.example.test/v1' },
      },
    },
  };
  let connectedWith: Config['llm'];
  let connected = false;
  let supervisorStarted = false;
  const context = {
    command: '/mcp',
    args: ['connect', 'github'],
    config,
    agent: { workspaceRoot: '/workspace' },
    repl: { launchPolicy: { modelOverride: 'command-model' } },
    mcpClient: {
      stopReconnectSupervisor: () => undefined,
      setReconnectLlmConfig: () => undefined,
      connectOne: async (_id: string, _profile: unknown, llm: Config['llm']) => {
        connectedWith = structuredClone(llm);
        connected = true;
      },
      getStatuses: () => [],
      getStatus: () => connected
        ? { serverId: 'github', identity: 'third-party', status: 'connected', toolCount: 1 }
        : undefined,
      startReconnectSupervisor: () => { supervisorStarted = true; },
    },
  } as unknown as CommandContext;
  const originalLog = console.log;
  console.log = () => undefined;
  try {
    assert.equal(await tryHandleMcpCommand(context), true);
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(connectedWith!, {
    provider: 'openai-compatible',
    apiKey: 'fresh-key',
    model: 'command-model',
    endpoint: 'https://profile.example.test/v1',
  });
  assert.equal(supervisorStarted, true, 'manual connect re-arms recovery after launch-only MCP Skip');
});

test('/mcp connect and reconnect reject inherited profile names before reading the live pool', async () => {
  const inheritedServers = Object.create({
    inherited: { type: 'stdio', command: 'must-not-run', identity: 'third-party' },
  }) as Config['servers'];
  let poolReads = 0;
  const context = {
    command: '/mcp',
    args: [],
    config: {
      activeServer: '',
      servers: inheritedServers,
      llm: { provider: 'openai', apiKey: 'key', model: 'model' },
    },
    agent: { workspaceRoot: '/workspace' },
    repl: { launchPolicy: {} },
    mcpClient: new Proxy({}, {
      get: () => {
        poolReads += 1;
        throw new Error('the pool must not be read for an inherited profile');
      },
    }),
  } as unknown as CommandContext;
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => { lines.push(values.map(String).join(' ')); };
  try {
    for (const subcommand of ['connect', 'reconnect']) {
      for (const profileName of ['inherited', '__proto__']) {
        context.args = [subcommand, profileName];
        assert.equal(await tryHandleMcpCommand(context), true);
      }
    }
  } finally {
    console.log = originalLog;
  }

  assert.equal(poolReads, 0, 'prototype-chain entries never reach MCP lifecycle code');
  assert.equal(lines.filter((line) => line.includes('No profile named')).length, 4);
});

test('/mcp connection failures redact credentials from legacy endpoint errors', async () => {
  const secretUrl = 'https://user:password@example.test/mcp/token%25252Fabc1234567890ABCDEF1234567890abcdef?sig=query-secret';
  const lines: string[] = [];
  let attempted = false;
  const context = {
    command: '/mcp',
    args: ['connect', 'legacy'],
    config: {
      activeServer: 'legacy',
      servers: { legacy: { type: 'http', url: secretUrl, identity: 'third-party' } },
      llm: { provider: 'openai', apiKey: 'key', model: 'model' },
    },
    agent: { workspaceRoot: '/workspace' },
    repl: { launchPolicy: {} },
    mcpClient: {
      stopReconnectSupervisor: () => undefined,
      setReconnectLlmConfig: () => undefined,
      connectOne: async () => { attempted = true; },
      getStatuses: () => [],
      getStatus: () => attempted
        ? {
            serverId: 'legacy',
            identity: 'third-party',
            status: 'failed',
            error: `fetch ${secretUrl} failed`,
          }
        : undefined,
      startReconnectSupervisor: () => undefined,
    },
  } as unknown as CommandContext;
  const originalLog = console.log;
  console.log = (...values: unknown[]) => { lines.push(values.map(String).join(' ')); };
  try {
    assert.equal(await tryHandleMcpCommand(context), true);
  } finally {
    console.log = originalLog;
  }

  const rendered = lines.join('\n');
  assert.doesNotMatch(rendered, /password|query-secret|abc1234567890/);
  assert.match(rendered, /\[redacted\]/);
});

test('/mcp reconnect reconciles the live pool to safe-mode targets before reconnecting', async () => {
  const removed: string[] = [];
  let connectedIds: string[] = [];
  let supervisorStarted = false;
  const context = {
    command: '/mcp',
    args: ['reconnect'],
    config: {
      activeServer: 'github',
      activeBrainrouterServer: 'brain',
      servers: {
        brain: { type: 'stdio', command: 'brainrouter-mcp', identity: 'brainrouter' },
        github: { type: 'http', url: 'https://github.example.test/mcp', identity: 'third-party' },
      },
      llm: { provider: 'openai', apiKey: 'key', model: 'model' },
    },
    agent: { workspaceRoot: '/workspace' },
    repl: { launchPolicy: { safeMode: true } },
    mcpClient: {
      stopReconnectSupervisor: () => undefined,
      startReconnectSupervisor: () => { supervisorStarted = true; },
      setReconnectLlmConfig: () => undefined,
      getServerIds: () => ['brain', 'github'],
      removeOne: async (id: string) => { removed.push(id); },
      connectAll: async (profiles: Record<string, unknown>) => {
        connectedIds = Object.keys(profiles);
        return [{ serverId: 'brain', identity: 'brainrouter', status: 'connected' }];
      },
    },
  } as unknown as CommandContext;
  const originalLog = console.log;
  console.log = () => undefined;
  try {
    assert.equal(await tryHandleMcpCommand(context), true);
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(removed, ['github']);
  assert.deepEqual(connectedIds, ['brain']);
  assert.equal(supervisorStarted, true);
  assert.equal(context.config.servers.brain.args, undefined, 'workspace projection remains outside durable config');
  assert.deepEqual(context.repl.runtimeMcp?.servers.brain.args, ['--root', '/workspace']);
});

test('/mcp exposes and reconnects a runtime-only BrainRouter profile without creating a durable selector', async () => {
  const config: Config = {
    activeServer: 'github',
    activeBrainrouterServer: undefined,
    servers: {
      github: { type: 'http', url: 'https://github.example.test/mcp', identity: 'third-party' },
    },
    llm: { provider: 'openai', apiKey: 'key', model: 'model' },
  };
  const durableSnapshot = structuredClone(config);
  const statuses = new Map<string, any>();
  let connectedProfile: unknown;
  const lines: string[] = [];
  const context = {
    command: '/mcp',
    args: ['list'],
    config,
    agent: {
      workspaceRoot: '/workspace',
      sessionKey: 'session:test',
      getModel: () => 'model',
    },
    repl: {
      launchPolicy: {},
      runtimeMcp: {
        servers: {
          brainrouter: {
            type: 'http',
            url: 'https://brain.example.test/mcp',
            identity: 'brainrouter',
          },
        },
        activeServer: 'github',
        activeBrainrouterServer: 'brainrouter',
      },
      replaceBanner: () => undefined,
    },
    mcpClient: {
      stopReconnectSupervisor: () => undefined,
      startReconnectSupervisor: () => undefined,
      setReconnectLlmConfig: () => undefined,
      getStatuses: () => [...statuses.values()],
      getStatus: (id: string) => statuses.get(id),
      getActiveBrainrouterServerId: () => statuses.get('brainrouter')?.status === 'connected'
        ? 'brainrouter'
        : undefined,
      isConnected: () => statuses.get('brainrouter')?.status === 'connected',
      connectOne: async (id: string, profile: unknown) => {
        connectedProfile = structuredClone(profile);
        statuses.set(id, {
          serverId: id,
          identity: 'brainrouter',
          status: 'connected',
          toolCount: 12,
        });
      },
      removeOne: async (id: string) => { statuses.delete(id); },
    },
  } as unknown as CommandContext;
  const originalLog = console.log;
  console.log = (...values: unknown[]) => { lines.push(values.map(String).join(' ')); };
  try {
    assert.equal(await tryHandleMcpCommand(context), true);
    const runtimeBeforeProbe = structuredClone(context.repl.runtimeMcp);
    assert.deepEqual(await resolveEffectiveMcpProfile(context, 'brainrouter'), {
      type: 'http',
      url: 'https://brain.example.test/mcp',
      identity: 'brainrouter',
    });
    assert.deepEqual(
      context.repl.runtimeMcp,
      runtimeBeforeProbe,
      'resolving a probe profile must not change the live session overlay',
    );
    context.args = ['reconnect', 'brainrouter'];
    assert.equal(await tryHandleMcpCommand(context), true);
  } finally {
    console.log = originalLog;
  }

  assert.match(lines.join('\n'), /brainrouter/, 'the session-only profile is visible in /mcp list');
  assert.match(lines.join('\n'), /this session only/);
  assert.doesNotMatch(lines.join('\n'), /for this and future sessions/);
  assert.deepEqual(connectedProfile, {
    type: 'http',
    url: 'https://brain.example.test/mcp',
    identity: 'brainrouter',
  });
  assert.deepEqual(config, durableSnapshot, 'runtime reconnect must not create a profile or dangling selectors');
  assert.equal(context.repl.runtimeMcp?.activeBrainrouterServer, 'brainrouter');
});

test('profile resolution prefers a newly edited durable transport over its stale runtime snapshot', async () => {
  const context = {
    config: {
      activeServer: 'github',
      servers: {
        github: { type: 'http', url: 'https://new.example.test/mcp', identity: 'third-party' },
      },
      llm: { provider: 'openai', apiKey: 'key', model: 'model' },
    },
    agent: { workspaceRoot: '/workspace' },
    repl: {
      launchPolicy: {},
      runtimeMcp: {
        servers: {
          github: { type: 'http', url: 'https://old.example.test/mcp', identity: 'third-party' },
        },
        activeServer: 'github',
      },
    },
    mcpClient: {},
  } as unknown as CommandContext;
  const runtimeBeforeProbe = structuredClone(context.repl.runtimeMcp);

  assert.deepEqual(await resolveEffectiveMcpProfile(context, 'github'), {
    type: 'http',
    url: 'https://new.example.test/mcp',
    identity: 'third-party',
  });
  assert.deepEqual(context.repl.runtimeMcp, runtimeBeforeProbe, 'resolution alone must not rewrite live state');
});

test('profile reconciliation retires failed, offline, idle, and pool-only BrainRouter profiles before reconnecting the target', async () => {
  const events: string[] = [];
  const statuses = new Map<string, any>([
    ['target', { serverId: 'target', identity: 'brainrouter', status: 'failed' }],
    ['failed-old', { serverId: 'failed-old', identity: 'brainrouter', status: 'failed' }],
    ['offline-old', { serverId: 'offline-old', identity: 'brainrouter', status: 'offline' }],
    ['pool-only', { serverId: 'pool-only', identity: 'brainrouter', status: 'offline' }],
    ['github', { serverId: 'github', identity: 'third-party', status: 'connected' }],
  ]);
  const context = {
    config: {
      activeServer: 'target',
      servers: {
        target: { type: 'stdio', command: 'brainrouter-mcp', identity: 'brainrouter' },
        'failed-old': { type: 'stdio', command: 'brainrouter-mcp', identity: 'brainrouter' },
        'offline-old': { type: 'stdio', command: 'brainrouter-mcp', identity: 'brainrouter' },
        'idle-old': { type: 'stdio', command: 'brainrouter-mcp', identity: 'brainrouter' },
        github: { type: 'http', url: 'https://example.test/mcp', identity: 'third-party' },
      },
      llm: { provider: 'openai', apiKey: 'key', model: 'model' },
    },
    agent: { workspaceRoot: '/workspace' },
    repl: { launchPolicy: {} },
    mcpClient: {
      stopReconnectSupervisor: () => { events.push('stop'); },
      startReconnectSupervisor: () => { events.push('start'); },
      setReconnectLlmConfig: () => undefined,
      getStatus: (id: string) => statuses.get(id),
      getStatuses: () => [...statuses.values()],
      removeOne: async (id: string) => {
        events.push(`remove:${id}`);
        statuses.delete(id);
      },
      connectOne: async (id: string, profile: any, _llm: unknown, _timeout: number, options: any) => {
        events.push(`connect:${id}:${profile.args?.at(-1)}`);
        for (const retiredId of options.retireBrainrouterServerIds) {
          events.push(`remove:${retiredId}`);
          statuses.delete(retiredId);
        }
        statuses.set(id, { serverId: id, identity: 'brainrouter', status: 'connected' });
      },
    },
  } as unknown as CommandContext;

  const status = await reconcileLiveMcpProfile(context, 'target', {
    forceReconnect: true,
    persistConfig: () => undefined,
  });

  assert.equal(status?.status, 'connected');
  assert.deepEqual(events, [
    'stop',
    'connect:target:/workspace',
    'remove:failed-old',
    'remove:offline-old',
    'remove:idle-old',
    'remove:pool-only',
    'start',
  ]);
  assert.equal(statuses.has('github'), true, 'third-party transports remain additive');
});

test('a failed explicit BrainRouter switch preserves the live selector for later reconnect-all', async () => {
  const statuses = new Map<string, any>([
    ['old-brain', { serverId: 'old-brain', identity: 'brainrouter', status: 'connected' }],
  ]);
  let reconnectTargets: string[] = [];
  let reconnectPreferred: string | undefined;
  const context = {
    command: '/mcp',
    args: ['connect', 'candidate'],
    config: {
      activeServer: 'old-brain',
      activeBrainrouterServer: 'old-brain',
      servers: {
        'old-brain': { type: 'stdio', command: 'brainrouter-mcp', identity: 'brainrouter' },
        candidate: { type: 'http', url: 'https://offline.example.test/mcp', identity: 'brainrouter' },
      },
      llm: { provider: 'openai', apiKey: 'key', model: 'model' },
    },
    agent: { workspaceRoot: '/workspace' },
    repl: {
      launchPolicy: {},
      runtimeMcp: {
        servers: {
          'old-brain': { type: 'stdio', command: 'brainrouter-mcp', identity: 'brainrouter' },
          candidate: { type: 'http', url: 'https://offline.example.test/mcp', identity: 'brainrouter' },
        },
        activeServer: 'old-brain',
        activeBrainrouterServer: 'old-brain',
      },
    },
    mcpClient: {
      stopReconnectSupervisor: () => undefined,
      startReconnectSupervisor: () => undefined,
      setReconnectLlmConfig: () => undefined,
      getStatus: (id: string) => statuses.get(id),
      getStatuses: () => [...statuses.values()],
      getServerIds: () => [...statuses.keys()],
      getActiveBrainrouterServerId: () => statuses.get('old-brain')?.status === 'connected'
        ? 'old-brain'
        : undefined,
      connectOne: async (id: string) => {
        statuses.set(id, {
          serverId: id,
          identity: 'brainrouter',
          status: 'failed',
          error: 'offline',
        });
      },
      removeOne: async (id: string) => { statuses.delete(id); },
      connectAll: async (profiles: Record<string, unknown>, _llm: unknown, options: any) => {
        reconnectTargets = Object.keys(profiles);
        reconnectPreferred = options.preferredBrainrouterServerId;
        statuses.set('old-brain', {
          serverId: 'old-brain',
          identity: 'brainrouter',
          status: 'connected',
        });
        return [...statuses.values()];
      },
    },
  } as unknown as CommandContext;

  const originalLog = console.log;
  console.log = () => undefined;
  try {
    assert.equal(await tryHandleMcpCommand(context), true);
    assert.equal(statuses.get('candidate')?.status, 'failed');
    assert.equal(statuses.get('old-brain')?.status, 'connected');
    assert.equal(context.repl.runtimeMcp?.activeBrainrouterServer, 'old-brain');

    context.args = ['reconnect'];
    assert.equal(await tryHandleMcpCommand(context), true);
  } finally {
    console.log = originalLog;
  }

  assert.equal(reconnectPreferred, 'old-brain');
  assert.deepEqual(reconnectTargets, ['old-brain']);
  assert.equal(context.config.activeBrainrouterServer, 'old-brain');
});

test('profile reconciliation retires the previous brain when an unknown profile is identified during connect', async () => {
  const events: string[] = [];
  const statuses = new Map<string, any>([
    ['old-brain', { serverId: 'old-brain', identity: 'brainrouter', status: 'connected' }],
  ]);
  const context = {
    config: {
      activeServer: 'candidate',
      servers: {
        candidate: { type: 'http', url: 'https://example.test/mcp' },
        'old-brain': { type: 'stdio', command: 'brainrouter-mcp', identity: 'brainrouter' },
      },
      llm: { provider: 'openai', apiKey: 'key', model: 'model' },
    },
    agent: { workspaceRoot: '/workspace' },
    repl: { launchPolicy: {} },
    mcpClient: {
      stopReconnectSupervisor: () => { events.push('stop'); },
      startReconnectSupervisor: () => { events.push('start'); },
      setReconnectLlmConfig: () => undefined,
      getStatus: (id: string) => statuses.get(id),
      getStatuses: () => [...statuses.values()],
      connectOne: async (id: string) => {
        events.push(`connect:${id}`);
        statuses.set(id, { serverId: id, identity: 'brainrouter', status: 'connected' });
      },
      removeOne: async (id: string) => {
        events.push(`remove:${id}`);
        statuses.delete(id);
      },
    },
  } as unknown as CommandContext;

  const persisted: string[] = [];
  const status = await reconcileLiveMcpProfile(context, 'candidate', {
    persistConfig: (next) => { persisted.push(next.activeBrainrouterServer ?? ''); },
  });

  assert.equal(status?.identity, 'brainrouter');
  assert.deepEqual(events, ['stop', 'connect:candidate', 'remove:old-brain', 'start']);
  assert.equal(statuses.has('candidate'), true);
  assert.equal(statuses.has('old-brain'), false);
  assert.deepEqual(persisted, ['candidate']);
});

test('profile reconciliation reports live success separately when durable selection persistence fails', async () => {
  const statuses = new Map<string, any>();
  const config: Config = {
    activeServer: 'github',
    servers: {
      candidate: { type: 'http', url: 'https://example.test/mcp' },
      github: { type: 'http', url: 'https://github.example.test/mcp', identity: 'third-party' },
    },
    llm: { provider: 'openai', apiKey: 'key', model: 'model' },
  };
  const context = {
    config,
    agent: { workspaceRoot: '/workspace' },
    repl: { launchPolicy: {} },
    mcpClient: {
      stopReconnectSupervisor: () => undefined,
      startReconnectSupervisor: () => undefined,
      setReconnectLlmConfig: () => undefined,
      getStatus: (id: string) => statuses.get(id),
      getStatuses: () => [...statuses.values()],
      connectOne: async (id: string) => {
        statuses.set(id, { serverId: id, identity: 'brainrouter', status: 'connected' });
      },
      removeOne: async (id: string) => { statuses.delete(id); },
    },
  } as unknown as CommandContext;

  await assert.rejects(
    reconcileLiveMcpProfile(context, 'candidate', {
      persistConfig: () => { throw new Error('disk full'); },
    }),
    (error: unknown) => {
      assert.ok(error instanceof McpProfilePersistenceError);
      assert.equal(error.liveStatus.status, 'connected');
      assert.match(error.message, /could not be saved/i);
      return true;
    },
  );
  assert.equal(statuses.get('candidate')?.status, 'connected');
  assert.equal(config.activeBrainrouterServer, undefined, 'failed persistence must roll back the durable selector');
  assert.equal(config.activeServer, 'github', 'banner highlight remains independent');
  assert.equal(context.repl.runtimeMcp?.activeBrainrouterServer, 'candidate', 'the live selection remains session-scoped');
});

test('mcpUtils: extractToolText handles content arrays, strings, and unknown shapes', () => {
  assert.equal(extractToolText({ content: [{ text: 'a' }, { text: 'b' }] }), 'a\nb');
  assert.equal(extractToolText({ content: [{ text: '' }, {}] }), '\n');
  assert.equal(extractToolText('plain string'), 'plain string');
  assert.equal(extractToolText({ foo: 1 }), '{"foo":1}');
  assert.equal(extractToolText(undefined), '""');
});

test('mcpUtils: safeJsonParse returns undefined/fallback on failure', () => {
  assert.deepEqual(safeJsonParse('{"a":1}'), { a: 1 });
  assert.equal(safeJsonParse('not json'), undefined);
  assert.equal(safeJsonParse('not json', 'fallback'), 'fallback');
  assert.equal(safeJsonParse(''), undefined);
});

test('mcpUtils: callMcpTool normalizes success, error flag, and thrown errors', async () => {
  const okClient: any = { callTool: async () => ({ content: [{ text: '{"x":1}' }] }) };
  const ok = await callMcpTool(okClient, 'whatever', {});
  assert.equal(ok.isError, false);
  assert.equal(ok.text, '{"x":1}');
  assert.deepEqual(ok.parsed, { x: 1 });

  const errClient: any = { callTool: async () => ({ isError: true, content: [{ text: 'boom' }] }) };
  const err = await callMcpTool(errClient, 'whatever', {});
  assert.equal(err.isError, true);
  assert.equal(err.text, 'boom');

  const throwClient: any = {
    callTool: async () => {
      throw new Error('network gone');
    },
  };
  const thrown = await callMcpTool(throwClient, 'whatever', {});
  assert.equal(thrown.isError, true);
  assert.equal(thrown.text, 'network gone');
});

test('normalizeSkillsList accepts array and wrapped skill-list payloads', () => {
  assert.deepEqual(normalizeSkillsList([{ name: 'adr-skill', scope: 'global', description: 'Records decisions' }]), [
    { name: 'adr-skill', scope: 'global', description: 'Records decisions' },
  ]);
  assert.deepEqual(normalizeSkillsList({ skills: [{ name: 'debugging-skill' }] }), [{ name: 'debugging-skill' }]);
  assert.equal(normalizeSkillsList({ ok: true }), undefined);
});

test('mcpUtils: childSessionKey applies the canonical naming scheme', () => {
  assert.equal(childSessionKey('br:main', 'agent-abc'), 'br:main:child:agent-abc');
});

test('orchestrator session registry persists lifecycle transitions', () => {
  withTempWorkspace((workspace) => {
    assert.deepEqual(listSessions(workspace), []);
    const created = createSession(workspace, {
      role: 'explorer',
      prompt: 'Map auth code',
      parentSessionKey: 'parent:x',
    });
    assert.equal(created.status, 'pending');
    assert.equal(created.access, 'read');
    const updated = updateSession(workspace, created.id, { status: 'running' });
    assert.equal(updated.status, 'running');
    const fetched = getSession(workspace, created.id);
    assert.equal(fetched?.status, 'running');
    assert.equal(listSessions(workspace).length, 1);
    assert.throws(() => updateSession(workspace, 'missing', { status: 'failed' }), /No child session/);
  });
});

test('orchestration: task_agent waits and returns child output', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    _resetCliKnobsCache();
    setCliKnobOverride({ providerRequestFormat: { openai: 'chat-completions' } });
    globalThis.fetch = (async (_url: any, opts: any) => {
      const body = JSON.parse(opts.body);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const lastUser = [...messages].reverse().find((m: any) => m.role === 'user')?.content ?? '';
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: `child completed: ${lastUser}` } }],
          usage: { prompt_tokens: 20, completion_tokens: 5 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as any;
    try {
      const stubMcp: any = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [{ text: '{}' }] }),
        close: async () => {},
      };
      const ctx = {
        workspaceRoot: workspace,
        parentSessionKey: 'session:test',
        parentAccessMode: 'shell' as const,
        mcpClient: stubMcp,
        llmConfig: { provider: 'openai' as const, apiKey: 'k', model: 'test-model' },
        launchCwd: workspace,
      };
      const raw = await executeOrchestrationTool('task_agent', { role: 'explorer', prompt: 'map auth' }, ctx);
      const result = JSON.parse(raw);
      assert.equal(result.role, 'explorer');
      assert.equal(result.status, 'completed');
      assert.match(result.finalOutput, /child completed: map auth/);
    } finally {
      globalThis.fetch = originalFetch;
      _resetCliKnobsCache();
    }
  });
});

test('orchestration: delegate_agent returns running child id with continue semantics', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    _resetCliKnobsCache();
    setCliKnobOverride({ providerRequestFormat: { openai: 'chat-completions' } });
    globalThis.fetch = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'background child complete' } }],
          usage: { prompt_tokens: 20, completion_tokens: 5 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as any;
    try {
      const stubMcp: any = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [{ text: '{}' }] }),
        close: async () => {},
      };
      const ctx = {
        workspaceRoot: workspace,
        parentSessionKey: 'session:test',
        parentAccessMode: 'shell' as const,
        mcpClient: stubMcp,
        llmConfig: { provider: 'openai' as const, apiKey: 'k', model: 'test-model' },
        launchCwd: workspace,
      };
      const raw = await executeOrchestrationTool('delegate_agent', { role: 'explorer', prompt: 'map auth' }, ctx);
      const result = JSON.parse(raw);
      assert.equal(result.role, 'explorer');
      assert.equal(result.status, 'running');
      assert.match(result.id, /^agent-/);
      assert.match(result.nextAction, /continue working/i);

      const record = getSession(workspace, result.id);
      assert.equal(record?.status, 'running');
      const waited = JSON.parse(await executeOrchestrationTool('wait_agent', { id: result.id, timeoutMs: 1000 }, ctx));
      assert.equal(waited.status, 'completed');
    } finally {
      globalThis.fetch = originalFetch;
      _resetCliKnobsCache();
    }
  });
});

test('orchestration: spawn_agent wait=true remains backward-compatible', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    _resetCliKnobsCache();
    setCliKnobOverride({ providerRequestFormat: { openai: 'chat-completions' } });
    globalThis.fetch = (async (_url: any, opts: any) => {
      const body = JSON.parse(opts.body);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const lastUser = [...messages].reverse().find((m: any) => m.role === 'user')?.content ?? '';
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: `legacy child completed: ${lastUser}` } }],
          usage: { prompt_tokens: 20, completion_tokens: 5 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as any;
    try {
      const stubMcp: any = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [{ text: '{}' }] }),
        close: async () => {},
      };
      const ctx = {
        workspaceRoot: workspace,
        parentSessionKey: 'session:test',
        parentAccessMode: 'shell' as const,
        mcpClient: stubMcp,
        llmConfig: { provider: 'openai' as const, apiKey: 'k', model: 'test-model' },
        launchCwd: workspace,
      };
      const raw = await executeOrchestrationTool(
        'spawn_agent',
        { role: 'explorer', prompt: 'map auth', wait: true },
        ctx,
      );
      const result = JSON.parse(raw);
      assert.equal(result.status, 'completed');
      assert.match(result.finalOutput, /legacy child completed: map auth/);
    } finally {
      globalThis.fetch = originalFetch;
      _resetCliKnobsCache();
    }
  });
});

test('orchestration: extractChildPreview prefers a Headline/Summary section over head-of-output', async () => {
  const { extractChildPreview } = await import('@kinqs/brainrouter-core/orchestration');
  // When the child wrote a Headline block, the preview returns THAT,
  // not the framing intro the head-slice would have captured.
  const withHeadline =
    'Long intro paragraph that explains what the child explored and why and ' +
    'how it set up its environment. '.repeat(10) +
    '\n\n## Headline\n' +
    'BLOCKER found in agent.ts:687 — captureTurn skipped on loop-limit.\n' +
    'Two HIGH issues in repl.ts.\n' +
    '\n## Details\n' +
    'long details follow…';
  const preview = extractChildPreview(withHeadline, 400);
  assert.match(preview, /## Headline/);
  assert.match(preview, /BLOCKER found in agent\.ts/);
  // Falls back to head + tail when no headline is present so the conclusion
  // at the end isn't silently dropped.
  const noHeadline = 'A'.repeat(1000) + 'CONCLUSION_MARKER_AT_END';
  const preview2 = extractChildPreview(noHeadline, 200);
  assert.match(preview2, /CONCLUSION_MARKER_AT_END/);
  assert.match(preview2, /…/); // contains the divider
});

test("orchestration: clampAccess prevents a child from exceeding the parent's access mode", async () => {
  const { clampAccess } = await import('@kinqs/brainrouter-core/orchestration');
  // Same level: no clamp.
  assert.equal(clampAccess('shell', 'shell'), 'shell');
  assert.equal(clampAccess('write', 'write'), 'write');
  assert.equal(clampAccess('read', 'read'), 'read');
  // Stepping down is fine.
  assert.equal(clampAccess('shell', 'read'), 'read');
  assert.equal(clampAccess('write', 'read'), 'read');
  // The security-critical cases: the child asked for MORE than the parent.
  // Without the clamp, spawn_agent({access:'shell'}) from a read-mode parent
  // would silently elevate. Clamped, the child is pinned to the parent's mode.
  assert.equal(clampAccess('read', 'write'), 'read');
  assert.equal(clampAccess('read', 'shell'), 'read');
  assert.equal(clampAccess('write', 'shell'), 'write');
});

test('breadthHint: realistic broad prompts trigger fan-out; narrow ones do not', async () => {
  const { shouldSuggestFanOut } = await import('@kinqs/brainrouter-core/prompt');
  // Prompts that obviously want fan-out — the original calibration missed
  // several of these (they all scored 1.5, just under the old 1.8 threshold).
  const broad = [
    'test all the MCP tools',
    'review every file in the repo',
    'audit the whole codebase for security issues',
    'manually review our brainrouter cli for everything every single line',
    'explore the codebase thoroughly',
    'check each tool definition',
  ];
  for (const p of broad) {
    const result = shouldSuggestFanOut(p);
    assert.ok(result.suggest, `expected fan-out for: "${p}" (got score=${result.intent.score})`);
  }
  // Narrow, surgical prompts should NOT trigger fan-out.
  const narrow = [
    'fix that single typo',
    'what is the recall pipeline?',
    'list the slash commands',
    'show me the goal store',
  ];
  for (const p of narrow) {
    const result = shouldSuggestFanOut(p);
    assert.ok(!result.suggest, `expected NO fan-out for: "${p}" (got score=${result.intent.score})`);
  }
});

test('breadthHint: multi-target comparisons trigger fan-out (the live "why no spawn?" miss)', async () => {
  const { shouldSuggestFanOut } = await import('@kinqs/brainrouter-core/prompt');
  // The exact prompt that scored 0 and never fanned out — an inherently
  // parallel "compare N codebases" task (one explorer per target).
  const comparisons = [
    'can you help me do a full compairison between our brainrouter-cli vs projectA, projectB and projectC?',
    'compare brainrouter-cli vs projectA',
    'benchmark our recall pipeline against the alternatives',
    'contrast the three approaches and tell me which is best',
    'review projectA, projectB and projectC', // enumerated ≥3 targets + verb
  ];
  for (const p of comparisons) {
    const r = shouldSuggestFanOut(p);
    assert.ok(
      r.suggest,
      `expected fan-out for comparison: "${p}" (score=${r.intent.score}, signals=${r.intent.signals.join(',')})`,
    );
  }
  // A trivial two-thing compare with an explicit self-veto must still NOT fan out.
  assert.ok(!shouldSuggestFanOut('compare these two lines yourself, no fan-out').suggest);
});

test('breadthHint: analytical "pros and cons / against those" comparisons fan out, without false-firing on "guard against"', async () => {
  const { shouldSuggestFanOut } = await import('@kinqs/brainrouter-core/prompt');
  // The exact live miss + relational-comparison shapes (one child per peer).
  for (const p of [
    'what are our pros and cons of brainrouter against those in the peer set',
    'how does our memory stack up against the others',
    'evaluate our approach versus the alternatives',
    'strengths and weaknesses of our recall vs the competition',
  ]) {
    assert.ok(shouldSuggestFanOut(p).suggest, `expected fan-out for: "${p}"`);
  }
  // "against" in a NON-comparison context must NOT trigger fan-out.
  for (const p of ['guard against errors in the parser', 'warn against using the deprecated API']) {
    assert.ok(!shouldSuggestFanOut(p).suggest, `expected NO fan-out for: "${p}"`);
  }
});

test('breadthHint: explicit no-fan-out hints in the prompt veto suggestion even at high score', async () => {
  const { shouldSuggestFanOut, detectFanOutVeto } = await import('@kinqs/brainrouter-core/prompt');
  // These prompts ALL score high on breadth (verb-object-broad, every,
  // etc.) but the user explicitly opted out. We must honor that.
  const vetoed = [
    'audit every file in src/ (no spawn_agent, no fan-out, files are small)',
    'review all the tools — do this in one turn',
    "test every config combination, don't fan out — directly with read_file",
    'check each module yourself, no children',
  ];
  for (const p of vetoed) {
    const r = shouldSuggestFanOut(p);
    assert.ok(
      !r.suggest,
      `expected veto on: "${p}" (got score=${r.intent.score}, signals=${r.intent.signals.join(',')})`,
    );
    assert.ok(r.veto, `expected r.veto string on: "${p}"`);
    assert.ok(
      r.intent.signals.some((s) => s.startsWith('vetoed:')),
      'expected a vetoed:<phrase> signal',
    );
  }
  // Direct unit test of the veto detector for clarity.
  assert.equal(detectFanOutVeto('audit everything (no fan-out)').vetoed, true);
  assert.equal(detectFanOutVeto('audit everything fast').vetoed, false);
  assert.equal(detectFanOutVeto('do not spawn children').vetoed, true);
  assert.equal(detectFanOutVeto('').vetoed, false);
});

test('detectBreadthIntent flags "do everything in 1 go" / "as much as I could" / parallel hints', async () => {
  const { detectBreadthIntent, shouldSuggestFanOut } = await import('@kinqs/brainrouter-core/prompt');

  const cases: Array<{ prompt: string; expectFanOut: boolean; expectSignal?: string }> = [
    { prompt: 'test all the MCP tools in 1 go, as much as you could', expectFanOut: true, expectSignal: 'one-shot' },
    { prompt: 'explore the entire codebase comprehensively', expectFanOut: true, expectSignal: 'coverage' },
    { prompt: 'investigate the auth middleware', expectFanOut: false },
    { prompt: 'fix this typo', expectFanOut: false },
    { prompt: 'spawn 3 agents in parallel covering every memory tool', expectFanOut: true, expectSignal: 'parallel' },
  ];
  for (const c of cases) {
    const { suggest, intent } = shouldSuggestFanOut(c.prompt);
    assert.equal(
      suggest,
      c.expectFanOut,
      `expected suggest=${c.expectFanOut} for "${c.prompt}", got ${suggest} (signals: ${intent.signals.join(',')}, score ${intent.score})`,
    );
    if (c.expectSignal) {
      assert.equal(
        intent.signals.includes(c.expectSignal),
        true,
        `expected signal "${c.expectSignal}" in ${JSON.stringify(intent.signals)}`,
      );
    }
  }

  // detectBreadthIntent returns a clean shape for empty prompts.
  assert.deepEqual(detectBreadthIntent(''), { score: 0, signals: [] });
});

test('inferRoleFromTask routes verbs to the right child role', async () => {
  const { inferRoleFromTask } = await import('@kinqs/brainrouter-core/orchestration');
  assert.equal(inferRoleFromTask('investigate the auth middleware'), 'explorer');
  assert.equal(inferRoleFromTask('Map the MCP package layout'), 'explorer');
  assert.equal(inferRoleFromTask('Design the data model for the chat feature'), 'architect');
  assert.equal(inferRoleFromTask('Review the diff for security issues'), 'reviewer');
  assert.equal(inferRoleFromTask('verify the build passes'), 'verifier');
  assert.equal(inferRoleFromTask('test the recall pipeline'), 'verifier');
  assert.equal(inferRoleFromTask('implement the new search filter'), 'worker');
  // Unmatched verbs fall through to worker.
  assert.equal(inferRoleFromTask('do the thing'), 'worker');
});

test('explainUnknownToolName: skill-shaped names get the skill correction; others get the generic hint', async () => {
  const { explainUnknownToolName } = await import('@kinqs/brainrouter-core/agent');
  assert.match(explainUnknownToolName('incremental-implementation'), /tried to invoke a SKILL/);
  assert.match(explainUnknownToolName('spec-driven-skill'), /load its instructions/);
  assert.match(explainUnknownToolName('code-structure-cleanup'), /tried to invoke a SKILL/);
  // Non-skill-shaped names fall to the generic guidance.
  assert.match(explainUnknownToolName('fetch_url_v2'), /Verify the tool name/);
});
