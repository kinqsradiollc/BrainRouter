import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allMcpConnectionsFailed,
  configForRuntimeMcpResolution,
  configWithRuntimeMcpState,
  createRuntimeMcpState,
  persistSelectedBrainrouterProfile,
  resolveEffectiveLlmConfig,
  resolveEffectiveMcpLaunch,
  resolveMcpStartupSelection,
  runtimeMcpStateWithSelectedBrainrouter,
} from '../entry/mcpStartup.js';
import type { Config } from '@kinqs/brainrouter-core/config';

const servers = {
  localBrain: {
    type: 'stdio' as const,
    command: 'brainrouter-mcp',
    identity: 'brainrouter' as const,
  },
  github: {
    type: 'http' as const,
    url: 'https://example.test/mcp',
    identity: 'third-party' as const,
  },
};

test('MCP startup: explicit wizard Skip wins for one launch without deleting profiles', () => {
  const skipped = resolveMcpStartupSelection({
    servers,
    activeServer: 'localBrain',
    requestedProfile: 'localBrain',
    strictMcp: true,
    skipMcpForLaunch: true,
  });
  assert.deepEqual(skipped, {
    status: 'ready',
    targetIds: [],
    intentionallySkipped: true,
    ignoredRequestedProfile: 'localBrain',
  });

  const nextLaunch = resolveMcpStartupSelection({
    servers,
    activeServer: 'localBrain',
  });
  assert.equal(nextLaunch.status, 'ready');
  if (nextLaunch.status === 'ready') {
    assert.deepEqual(nextLaunch.targetIds.sort(), ['github', 'localBrain']);
    assert.equal(nextLaunch.intentionallySkipped, false);
  }
});

test('MCP startup: zero profiles starts local-only unless strict mode was requested', () => {
  assert.deepEqual(resolveMcpStartupSelection({ servers: {} }), {
    status: 'ready',
    targetIds: [],
    intentionallySkipped: false,
  });
  assert.deepEqual(resolveMcpStartupSelection({ servers: {}, strictMcp: true }), {
    status: 'strict-no-profiles',
  });
});

test('MCP startup: a requested missing profile remains an actionable error', () => {
  assert.deepEqual(resolveMcpStartupSelection({
    servers,
    requestedProfile: 'missing',
  }), {
    status: 'missing-profile',
    requestedProfile: 'missing',
    availableIds: ['localBrain', 'github'],
  });
});

test('MCP startup: inherited profile names remain actionable missing-profile errors', () => {
  for (const inheritedName of ['__proto__', 'constructor', 'toString']) {
    assert.deepEqual(resolveMcpStartupSelection({
      servers: {},
      requestedProfile: inheritedName,
    }), {
      status: 'missing-profile',
      requestedProfile: inheritedName,
      availableIds: [],
    });
  }

  const ownServers = JSON.parse(
    '{"__proto__":{"type":"http","url":"https://brain.example/mcp","identity":"brainrouter"}}',
  );
  assert.deepEqual(resolveMcpStartupSelection({
    servers: ownServers,
    requestedProfile: '__proto__',
  }), {
    status: 'ready',
    targetIds: ['__proto__'],
    intentionallySkipped: false,
  });
});

test('MCP startup: safe mode removes every third-party target, including third-party-only catalogs', () => {
  const mixed = resolveMcpStartupSelection({
    servers,
    activeServer: 'localBrain',
    safeMode: true,
  });
  assert.equal(mixed.status, 'ready');
  if (mixed.status === 'ready') {
    assert.deepEqual(mixed.targetIds, ['localBrain']);
    assert.deepEqual(mixed.safeModeSkippedIds, ['github']);
  }

  const thirdPartyOnly = resolveMcpStartupSelection({
    servers: { github: servers.github },
    safeMode: true,
  });
  assert.equal(thirdPartyOnly.status, 'ready');
  if (thirdPartyOnly.status === 'ready') {
    assert.deepEqual(thirdPartyOnly.targetIds, []);
    assert.deepEqual(thirdPartyOnly.safeModeSkippedIds, ['github']);
  }
});

test('MCP startup: banner highlight stays independent from the persisted active brain', () => {
  const selection = resolveMcpStartupSelection({
    servers: {
      localBrain: servers.localBrain,
      remoteBrain: {
        type: 'http',
        url: 'https://api.brainrouter.cloud/mcp',
        identity: 'brainrouter',
      },
      github: servers.github,
    },
    activeServer: 'github',
    activeBrainrouterServer: 'remoteBrain',
  });

  assert.equal(selection.status, 'ready');
  if (selection.status === 'ready') {
    assert.deepEqual(selection.targetIds.sort(), ['github', 'remoteBrain']);
  }
});

test('MCP startup: safe mode retains a persisted dynamically identified active brain', () => {
  const selection = resolveMcpStartupSelection({
    servers: {
      learnedBrain: { type: 'http', url: 'https://example.test/mcp' },
      github: servers.github,
    },
    activeServer: 'github',
    activeBrainrouterServer: 'learnedBrain',
    safeMode: true,
  });

  assert.equal(selection.status, 'ready');
  if (selection.status === 'ready') {
    assert.deepEqual(selection.targetIds, ['learnedBrain']);
    assert.deepEqual(selection.safeModeSkippedIds, ['github']);
  }
});

test('MCP startup: effective launch applies remote brain policy and workspace root without mutating saved config', async () => {
  const config: Config = {
    activeServer: 'localBrain',
    servers: structuredClone(servers),
    cli: { brainUrl: 'https://brain.example.test/mcp' },
  };
  const effective = await resolveEffectiveMcpLaunch({
    config,
    workspaceRoot: '/workspace',
    probeRemoteBrain: async () => ({ ok: true, status: 200 }),
  });

  assert.equal(effective.status, 'ready');
  if (effective.status !== 'ready') return;
  assert.equal(effective.remoteBrain?.outcome, 'remote');
  assert.equal(effective.targetServers.localBrain.type, 'http');
  assert.equal(effective.targetServers.localBrain.url, 'https://brain.example.test/mcp');
  assert.equal(config.servers.localBrain.type, 'stdio', 'launch-only transport changes do not rewrite saved config');
});

test('MCP startup: runtime projection stays isolated from durable config and its banner highlight', async () => {
  const config: Config = {
    activeServer: 'github',
    activeBrainrouterServer: 'localBrain',
    servers: structuredClone(servers),
    cli: { brainUrl: 'https://brain.example.test/mcp' },
  };
  const durableSnapshot = structuredClone(config);
  const launch = await resolveEffectiveMcpLaunch({
    config,
    workspaceRoot: '/workspace',
    probeRemoteBrain: async () => ({ ok: true, status: 200 }),
  });

  assert.equal(launch.status, 'ready');
  if (launch.status !== 'ready') return;
  const runtime = createRuntimeMcpState(launch);
  const runtimeView = configWithRuntimeMcpState(config, runtime);

  assert.deepEqual(config, durableSnapshot, 'resolving and overlaying launch state must not mutate durable config');
  assert.equal(runtimeView.activeServer, 'github', 'banner highlight remains the durable selection');
  assert.equal(runtimeView.activeBrainrouterServer, 'localBrain');
  assert.equal(runtimeView.servers.localBrain.type, 'http');
  assert.equal(runtimeView.servers.localBrain.url, 'https://brain.example.test/mcp');
  assert.equal(config.servers.localBrain.type, 'stdio');
});

test('MCP startup: fresh resolution keeps durable embedded fallback beneath a remote runtime projection', async () => {
  const config: Config = {
    activeServer: 'github',
    activeBrainrouterServer: 'localBrain',
    servers: structuredClone(servers),
    cli: { brainUrl: 'https://brain.example.test/mcp' },
  };
  const remoteLaunch = await resolveEffectiveMcpLaunch({
    config,
    workspaceRoot: '/workspace',
    probeRemoteBrain: async () => ({ ok: true, status: 200 }),
  });
  assert.equal(remoteLaunch.status, 'ready');
  if (remoteLaunch.status !== 'ready') return;

  const nextInput = configForRuntimeMcpResolution(config, createRuntimeMcpState(remoteLaunch));
  assert.equal(nextInput.servers.localBrain.type, 'stdio', 'a projected HTTP copy must not shadow durable fallback');
  assert.equal(nextInput.activeServer, 'github');
  assert.equal(nextInput.activeBrainrouterServer, 'localBrain');

  const fallbackLaunch = await resolveEffectiveMcpLaunch({
    config: nextInput,
    workspaceRoot: '/workspace',
    probeRemoteBrain: async () => ({ ok: false, error: 'offline' }),
  });
  assert.equal(fallbackLaunch.status, 'ready');
  if (fallbackLaunch.status !== 'ready') return;
  assert.equal(fallbackLaunch.remoteBrain?.outcome, 'embedded-fallback');
  assert.equal(fallbackLaunch.targetServers.localBrain.type, 'stdio');
  assert.deepEqual(fallbackLaunch.targetServers.localBrain.args, ['--root', '/workspace']);
  assert.deepEqual(config.servers, servers, 'fresh resolution must leave the durable catalog unchanged');
});

test('MCP startup: unreachable remote falls back to embedded and Skip avoids the health probe entirely', async () => {
  const config: Config = {
    activeServer: 'localBrain',
    servers: structuredClone(servers),
    cli: { brainUrl: 'https://offline.example.test/mcp' },
  };
  const fallback = await resolveEffectiveMcpLaunch({
    config,
    workspaceRoot: '/workspace',
    probeRemoteBrain: async () => ({ ok: false, error: 'offline' }),
  });
  assert.equal(fallback.status, 'ready');
  if (fallback.status === 'ready') {
    assert.equal(fallback.remoteBrain?.outcome, 'embedded-fallback');
    assert.deepEqual(fallback.targetServers.localBrain.args, ['--root', '/workspace']);
  }

  let probes = 0;
  const skipped = await resolveEffectiveMcpLaunch({
    config,
    workspaceRoot: '/workspace',
    policy: { skipMcpForLaunch: true, requestedProfile: 'localBrain', strictMcp: true },
    probeRemoteBrain: async () => {
      probes += 1;
      return { ok: true, status: 200 };
    },
  });
  assert.equal(skipped.status, 'ready');
  if (skipped.status === 'ready') {
    assert.deepEqual(skipped.targetIds, []);
    assert.equal(skipped.ignoredRequestedProfile, 'localBrain');
  }
  assert.equal(probes, 0);
});

test('MCP startup: unreachable selected remote switches runtime selection to embedded', async () => {
  const config: Config = {
    activeServer: 'github',
    activeBrainrouterServer: 'remoteBrain',
    servers: {
      remoteBrain: {
        type: 'http',
        url: 'https://saved-remote.example.test/mcp',
        identity: 'brainrouter',
      },
      localBrain: servers.localBrain,
      github: servers.github,
    },
    cli: { brainUrl: 'https://offline.example.test/mcp' },
  };
  const fallback = await resolveEffectiveMcpLaunch({
    config,
    workspaceRoot: '/workspace',
    probeRemoteBrain: async () => ({ ok: false, error: 'offline' }),
  });

  assert.equal(fallback.status, 'ready');
  if (fallback.status !== 'ready') return;
  assert.equal(fallback.runtimeActiveBrainrouterServer, 'localBrain');
  assert.deepEqual(fallback.targetIds.sort(), ['github', 'localBrain']);
  assert.equal(fallback.targetServers.remoteBrain, undefined);
});

test('BrainRouter login persistence updates both selectors and rolls back a failed write', () => {
  const config: Config = {
    activeServer: 'github',
    activeBrainrouterServer: 'oldBrain',
    servers: {
      github: servers.github,
      oldBrain: servers.localBrain,
    },
  };
  assert.throws(() => persistSelectedBrainrouterProfile(
    config,
    'cloud',
    { type: 'http', url: 'https://brain.example.test/mcp' },
    () => { throw new Error('disk full'); },
  ), /disk full/);
  assert.equal(config.activeServer, 'github');
  assert.equal(config.activeBrainrouterServer, 'oldBrain');
  assert.equal(config.servers.cloud, undefined);

  let persisted: Config | undefined;
  persistSelectedBrainrouterProfile(
    config,
    'cloud',
    { type: 'http', url: 'https://brain.example.test/mcp' },
    (next) => { persisted = structuredClone(next); },
  );
  assert.equal(config.activeServer, 'cloud');
  assert.equal(config.activeBrainrouterServer, 'cloud');
  assert.equal(
    (config.servers.cloud as { identity?: string } | undefined)?.identity,
    'brainrouter',
  );
  assert.equal(persisted?.activeBrainrouterServer, 'cloud');
});

test('BrainRouter login mirrors the saved selection into reconnect state for the current session', async () => {
  const config: Config = {
    activeServer: 'oldBrain',
    activeBrainrouterServer: 'oldBrain',
    servers: {
      oldBrain: servers.localBrain,
      tools: servers.github,
    },
  };
  const cloud = {
    type: 'http' as const,
    url: 'https://brain.example.test/mcp',
    apiKey: 'secret',
    identity: 'brainrouter' as const,
    headers: { 'X-Tenant': 'original' },
  };
  persistSelectedBrainrouterProfile(config, 'cloud', cloud, () => undefined);

  const runtime = runtimeMcpStateWithSelectedBrainrouter({
    servers: {
      oldBrain: servers.localBrain,
      tools: servers.github,
    },
    activeServer: 'oldBrain',
    activeBrainrouterServer: 'oldBrain',
  }, 'cloud', cloud, config.activeServer);
  cloud.headers['X-Tenant'] = 'mutated-after-publish';

  assert.equal(runtime.activeServer, 'cloud');
  assert.equal(runtime.activeBrainrouterServer, 'cloud');
  assert.equal(runtime.servers.cloud.headers?.['X-Tenant'], 'original');
  assert.deepEqual(runtime.servers.tools, servers.github, 'unrelated runtime profiles remain available');

  const launch = await resolveEffectiveMcpLaunch({
    config: configForRuntimeMcpResolution(config, runtime),
    workspaceRoot: '/workspace',
  });
  assert.equal(launch.status, 'ready');
  if (launch.status !== 'ready') return;
  assert.equal(launch.runtimeActiveBrainrouterServer, 'cloud');
  assert.deepEqual(launch.targetIds.sort(), ['cloud', 'tools']);
});

test('MCP startup: effective LLM applies active profile before the explicit model override', () => {
  const config: Config = {
    activeServer: '',
    servers: {},
    llm: {
      provider: 'openai-compatible',
      apiKey: 'key',
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
  };

  assert.deepEqual(resolveEffectiveLlmConfig(config, { modelOverride: 'command-line-model' }), {
    provider: 'openai-compatible',
    apiKey: 'key',
    model: 'command-line-model',
    endpoint: 'https://profile.example.test/v1',
  });
});

test('MCP startup: an empty status set is local-only, not an all-failed result', () => {
  assert.equal(allMcpConnectionsFailed([]), false);
  assert.equal(allMcpConnectionsFailed([
    { serverId: 'brain', identity: 'unknown', status: 'failed', error: 'offline' },
  ]), true);
  assert.equal(allMcpConnectionsFailed([
    { serverId: 'brain', identity: 'brainrouter', status: 'connected' },
    { serverId: 'github', identity: 'unknown', status: 'failed' },
  ]), false);
});
