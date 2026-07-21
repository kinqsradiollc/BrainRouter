import test from 'node:test';
import assert from 'node:assert/strict';
import type { Config, LLMConfig, ServerConfig } from '@kinqs/brainrouter-core/config';
import type { McpServerStatus } from '@kinqs/brainrouter-core/mcp';
import {
  createDesktopMcpLifecycle,
  redactDesktopMcpCommand,
  redactDesktopMcpEndpoint,
  resolveSelectedDesktopBrainRouterAccountApi,
  resolveDesktopMcpIdentity,
  validateDesktopMcpHttpUrl,
} from './queries.js';

class FakeMcpPool {
  readonly statuses = new Map<string, McpServerStatus>();
  readonly identities = new Map<string, McpServerStatus['identity']>();
  readonly failures = new Set<string>();
  readonly connects: Array<{
    id: string;
    profile: ServerConfig;
    llm: LLMConfig | undefined;
    options: { retireBrainrouterServerIds?: readonly string[]; brainrouterPriority?: number };
  }> = [];
  readonly reconnectCatalog = new Map<string, ServerConfig>();
  readonly removeFailures = new Set<string>();
  readonly removed: string[] = [];
  supervisorStops = 0;
  supervisorStarts = 0;
  supervisorRunning = true;

  getStatus(id: string): McpServerStatus | undefined {
    return this.statuses.get(id);
  }

  getStatuses(): McpServerStatus[] {
    return [...this.statuses.values()];
  }

  setReconnectLlmConfig(): void {}

  stopReconnectSupervisor(): void {
    this.supervisorStops += 1;
    this.supervisorRunning = false;
  }

  startReconnectSupervisor(): void {
    this.supervisorStarts += 1;
    this.supervisorRunning = true;
  }

  async connectOne(
    id: string,
    profile: ServerConfig,
    llm?: LLMConfig,
    _timeoutMs?: number,
    options: { retireBrainrouterServerIds?: readonly string[]; brainrouterPriority?: number } = {},
  ): Promise<void> {
    this.connects.push({ id, profile: structuredClone(profile), llm: structuredClone(llm), options });
    this.reconnectCatalog.set(id, structuredClone(profile));
    const identity = this.identities.get(id)
      ?? profile.identity
      ?? (profile.type === 'stdio' && profile.command?.includes('brainrouter') ? 'brainrouter' : 'third-party');
    if (this.failures.has(id)) {
      this.statuses.set(id, { serverId: id, identity, status: 'failed', error: 'offline' });
      return;
    }
    if (identity === 'brainrouter') {
      for (const retiredId of options.retireBrainrouterServerIds ?? []) this.statuses.delete(retiredId);
    }
    this.statuses.set(id, { serverId: id, identity, status: 'connected', toolCount: 1 });
  }

  async removeOne(id: string): Promise<void> {
    if (this.removeFailures.has(id)) throw new Error('remove failed');
    this.removed.push(id);
    this.statuses.delete(id);
    this.reconnectCatalog.delete(id);
  }

  async sweepReconnect(): Promise<void> {
    if (!this.supervisorRunning) return;
    const due = [...this.statuses.values()]
      .filter((status) => status.status !== 'connected' && status.status !== 'connecting')
      .map((status) => status.serverId);
    for (const id of due) {
      const profile = this.reconnectCatalog.get(id);
      if (profile) await this.connectOne(id, profile, llm);
    }
  }
}

const llm: LLMConfig = { provider: 'openai', model: 'test-model', apiKey: 'test-key' };

function configWithTwoBrains(): Config {
  return {
    activeServer: 'github',
    activeBrainrouterServer: 'brain-a',
    servers: {
      'brain-a': { type: 'stdio', command: 'brainrouter-mcp', identity: 'brainrouter' },
      'brain-b': { type: 'stdio', command: 'brainrouter-mcp', identity: 'brainrouter' },
      github: { type: 'http', url: 'https://example.test/mcp', identity: 'third-party' },
    },
    llm,
  };
}

function lifecycleHarness(initial: Config, pool = new FakeMcpPool()) {
  let disk = structuredClone(initial);
  let persistFailure: Error | undefined;
  const lifecycle = createDesktopMcpLifecycle({
    loadConfig: () => structuredClone(disk),
    persistConfig: (next) => {
      if (persistFailure) {
        const failure = persistFailure;
        persistFailure = undefined;
        throw failure;
      }
      disk = structuredClone(next);
    },
    mcpClient: pool as never,
    workspaceRoot: '/workspace/project',
    getLlm: () => structuredClone(llm),
  });
  return {
    lifecycle,
    pool,
    disk: () => structuredClone(disk),
    failNextPersist: (message = 'read only') => { persistFailure = new Error(message); },
  };
}

test('desktop MCP snapshot classifies an idle configured brain without a pool status', () => {
  const profile: ServerConfig = { type: 'stdio', command: 'brainrouter-mcp', identity: 'brainrouter' };
  assert.equal(resolveDesktopMcpIdentity('idle-brain', profile), 'brainrouter');
  assert.equal(
    resolveDesktopMcpIdentity('idle-brain', profile, {
      serverId: 'idle-brain',
      identity: 'unknown',
      status: 'offline',
    }),
    'brainrouter',
  );
});

test('desktop MCP snapshot helpers redact endpoint and stdio argument credentials', () => {
  const endpoint = redactDesktopMcpEndpoint(
    'https://user:password@example.test/mcp/token/secret-value?api_key=query-secret#fragment-secret',
  );
  assert.equal(endpoint, 'https://example.test/mcp/token/[redacted]?[redacted]#[redacted]');
  assert.doesNotMatch(endpoint ?? '', /password|secret-value|query-secret|fragment-secret/);
  assert.equal(
    redactDesktopMcpCommand({
      type: 'stdio',
      command: 'connector-mcp',
      args: ['--project', 'alpha', '--token', 'token-value', '--api-key=key-value'],
    }),
    'connector-mcp --project alpha --token [redacted] --api-key=[redacted]',
  );
});

test('desktop MCP snapshots scrub legacy encoded paths, raw headers, and option URLs', () => {
  const encodedPathSecret = 'multi-encoded-path-value';
  const encodedEndpoint = redactDesktopMcpEndpoint(
    `https://example.test/mcp/token%25252F${encodedPathSecret}`,
  );
  assert.equal(encodedEndpoint, 'https://example.test/[redacted]');
  assert.equal(encodedEndpoint?.includes(encodedPathSecret), false);

  const secrets = [
    'raw-authorization-value',
    'split-authorization-value',
    'endpoint-password-value',
    'endpoint-path-value',
    'endpoint-query-value',
    'endpoint-fragment-value',
  ];
  const command = redactDesktopMcpCommand({
    type: 'stdio',
    command: 'connector-mcp',
    args: [
      '--header',
      `Authorization: Bearer ${secrets[0]}`,
      '--header=Authorization:',
      'Bearer',
      secrets[1],
      `--endpoint=https://user:${secrets[2]}@example.test/mcp/token/${secrets[3]}?api_key=${secrets[4]}#${secrets[5]}`,
      '--private-key-path',
      '/safe/keys/service.pem',
    ],
  });

  for (const secret of secrets) assert.equal(command?.includes(secret), false);
  assert.match(command ?? '', /Authorization: Bearer \[redacted\]/);
  assert.match(command ?? '', /--header=Authorization: Bearer \[redacted\]/);
  assert.match(
    command ?? '',
    /--endpoint=https:\/\/example\.test\/mcp\/token\/\[redacted\]\?\[redacted\]#\[redacted\]/,
  );
  assert.match(command ?? '', /--private-key-path \/safe\/keys\/service\.pem/);
});

test('desktop MCP add URL validation rejects credential material without echoing it', () => {
  const credentialUrls = [
    ['https://example.test/mcp?api_key=query-secret-value', 'query-secret-value'],
    ['https://example.test/mcp?project=sk-abcdefghijklmnop', 'sk-abcdefghijklmnop'],
    ['https://example.test/mcp/token/path-secret-value', 'path-secret-value'],
    ['https://example.test/mcp%252ftoken%252fencoded-secret-value', 'encoded-secret-value'],
    ['https://example.test/mcp#fragment-secret-value', 'fragment-secret-value'],
  ] as const;

  for (const [url, secret] of credentialUrls) {
    const error = validateDesktopMcpHttpUrl(url);
    assert.ok(error, `expected credential-bearing URL to be rejected: ${url}`);
    assert.equal(error.includes(secret), false);
    assert.equal(error.includes(url), false);
  }
  assert.equal(validateDesktopMcpHttpUrl('https://example.test/mcp?project=alpha'), undefined);
});

test('desktop active-brain switch is exclusive, workspace-aware, and persists both selections', async () => {
  const harness = lifecycleHarness(configWithTwoBrains());
  harness.pool.statuses.set('brain-a', { serverId: 'brain-a', identity: 'brainrouter', status: 'connected' });

  const result = await harness.lifecycle.setActive('brain-b');

  assert.equal(result.ok, true);
  assert.equal(harness.disk().activeServer, 'brain-b');
  assert.equal(harness.disk().activeBrainrouterServer, 'brain-b');
  assert.deepEqual(harness.pool.connects.map((entry) => entry.id), ['brain-b']);
  assert.deepEqual(harness.pool.connects[0].options.retireBrainrouterServerIds, ['brain-a']);
  assert.equal(harness.pool.connects[0].options.brainrouterPriority, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(harness.pool.connects[0].profile.args, ['--root', '/workspace/project']);
  assert.equal(harness.pool.supervisorStops, 1);
  assert.equal(harness.pool.supervisorStarts, 1);
});

test('desktop active-brain switch rolls the live pool back when persistence fails', async () => {
  const initial = configWithTwoBrains();
  const harness = lifecycleHarness(initial);
  harness.pool.statuses.set('brain-a', { serverId: 'brain-a', identity: 'brainrouter', status: 'connected' });
  harness.failNextPersist();

  const result = await harness.lifecycle.setActive('brain-b');

  assert.equal(result.ok, false);
  assert.equal(harness.disk().activeServer, 'github');
  assert.equal(harness.disk().activeBrainrouterServer, 'brain-a');
  assert.deepEqual(harness.pool.connects.map((entry) => entry.id), ['brain-b', 'brain-a']);
  assert.equal(harness.pool.getStatus('brain-a')?.status, 'connected');
  assert.equal(harness.pool.getStatus('brain-b'), undefined);
});

test('desktop reconnect persists a discovered brain without changing the banner highlight', async () => {
  const initial: Config = {
    activeServer: 'github',
    servers: {
      candidate: { type: 'http', url: 'https://brain.example.test/mcp' },
      github: { type: 'http', url: 'https://example.test/mcp', identity: 'third-party' },
    },
    llm,
  };
  const harness = lifecycleHarness(initial);
  harness.pool.identities.set('candidate', 'brainrouter');

  const result = await harness.lifecycle.reconnect('candidate');

  assert.equal(result.ok, true);
  assert.equal(harness.disk().activeServer, 'github');
  assert.equal(harness.disk().activeBrainrouterServer, 'candidate');
  assert.equal(harness.disk().servers.candidate.identity, 'brainrouter');
});

test('desktop remove durably forgets the profile and activates the remaining brain', async () => {
  const harness = lifecycleHarness(configWithTwoBrains());
  harness.pool.statuses.set('brain-a', { serverId: 'brain-a', identity: 'brainrouter', status: 'connected' });

  const result = await harness.lifecycle.remove('brain-a');

  assert.equal(result.ok, true);
  assert.equal(harness.disk().servers['brain-a'], undefined);
  assert.equal(harness.disk().activeBrainrouterServer, 'brain-b');
  assert.deepEqual(harness.pool.removed, ['brain-a']);
  assert.deepEqual(harness.pool.connects.map((entry) => entry.id), ['brain-b']);
});

test('desktop add never connects or reports success when the strict config write fails', async () => {
  const initial: Config = { activeServer: '', servers: {}, llm };
  const harness = lifecycleHarness(initial);
  harness.failNextPersist('disk full');

  const result = await harness.lifecycle.add('github', {
    type: 'http',
    url: 'https://example.test/mcp',
    identity: 'third-party',
  });

  assert.equal(result.ok, false);
  assert.deepEqual(harness.disk().servers, {});
  assert.deepEqual(harness.pool.connects, []);
});

test('desktop add keeps an additional configured BrainRouter profile idle', async () => {
  const initial = configWithTwoBrains();
  delete initial.servers['brain-b'];
  const harness = lifecycleHarness(initial);

  const result = await harness.lifecycle.add('brain-b', {
    type: 'stdio',
    command: 'brainrouter-mcp',
    identity: 'brainrouter',
  });

  assert.deepEqual(result, { ok: true, id: 'brain-b', online: false, idle: true });
  assert.equal(harness.disk().servers['brain-b'].identity, 'brainrouter');
  assert.equal(harness.disk().activeBrainrouterServer, 'brain-a');
  assert.deepEqual(harness.pool.connects, []);
});

test('desktop account sign-in rejects a failed durable commit before changing the live pool', async () => {
  const initial = configWithTwoBrains();
  initial.activeBrainrouterServer = 'brain-b';
  const harness = lifecycleHarness(initial);
  harness.pool.statuses.set('brain-b', { serverId: 'brain-b', identity: 'brainrouter', status: 'connected' });
  harness.failNextPersist('disk full');

  const result = await harness.lifecycle.commitAccountSignIn({
    profile: {
      type: 'http',
      url: 'https://account.example.test/mcp',
      apiKey: 'account-key',
      identity: 'brainrouter',
    },
    account: {
      url: 'https://account.example.test',
      mcpUrl: 'https://account.example.test/mcp',
      userId: 'user-1',
      displayName: 'Account User',
      email: 'user@example.test',
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(harness.disk(), initial, 'a failed strict write leaves every durable selector and profile unchanged');
  assert.deepEqual(harness.pool.connects, [], 'sign-in cannot mutate the live pool before its durable commit');
});

test('desktop account sign-in replaces the selected brain and preserves the independent banner highlight', async () => {
  const initial = configWithTwoBrains();
  initial.activeBrainrouterServer = 'brain-b';
  const originalBrainA = structuredClone(initial.servers['brain-a']);
  const originalBrainB = structuredClone(initial.servers['brain-b']);
  const harness = lifecycleHarness(initial);

  const result = await harness.lifecycle.commitAccountSignIn({
    profile: {
      type: 'http',
      url: 'https://account.example.test/mcp',
      apiKey: 'selected-account-key',
      identity: 'brainrouter',
    },
    account: {
      url: 'https://account.example.test',
      mcpUrl: 'https://account.example.test/mcp',
      userId: 'user-1',
      displayName: 'Account User',
      email: 'user@example.test',
    },
  });

  const disk = harness.disk() as Config & {
    cli?: { account?: { brainId?: string; prevBrain?: ServerConfig | null } };
  };
  assert.equal(result.ok, true);
  assert.equal(result.id, 'brain-b');
  assert.deepEqual(disk.servers['brain-a'], originalBrainA, 'the first configured brain is not mistaken for the selected brain');
  assert.deepEqual(disk.servers['brain-b'], {
    type: 'http',
    url: 'https://account.example.test/mcp',
    apiKey: 'selected-account-key',
    identity: 'brainrouter',
  });
  assert.equal(disk.activeBrainrouterServer, 'brain-b');
  assert.equal(disk.activeServer, 'github', 'account selection does not overwrite the independent banner highlight');
  assert.equal(disk.cli?.account?.brainId, 'brain-b');
  assert.deepEqual(disk.cli?.account?.prevBrain, originalBrainB);
  assert.equal(harness.pool.connects.length, 0, 'the account action can return after commit and reconcile in the background');
  assert.deepEqual(resolveSelectedDesktopBrainRouterAccountApi(disk), {
    baseUrl: 'https://account.example.test',
    apiKey: 'selected-account-key',
  });

  const reconciled = await harness.lifecycle.connectCommittedAccountBrain('brain-b');
  assert.equal(reconciled.online, true);
  assert.deepEqual(harness.pool.connects.map((entry) => entry.id), ['brain-b']);

  const signedOut = await harness.lifecycle.signOutAccount();
  const restored = harness.disk();
  assert.equal(signedOut.ok, true);
  assert.deepEqual(restored.servers['brain-b'], originalBrainB);
  assert.equal(restored.activeBrainrouterServer, 'brain-b', 'sign-out keeps the restored selected brain durable');
  assert.equal(restored.activeServer, 'github');
});

test('desktop account sign-out forgets a deleted profile so the reconnect supervisor cannot restore it', async () => {
  const harness = lifecycleHarness({ activeServer: '', servers: {}, llm });
  const signIn = await harness.lifecycle.commitAccountSignIn({
    profile: {
      type: 'http',
      url: 'https://account.example.test/mcp',
      apiKey: 'account-key',
      identity: 'brainrouter',
    },
    account: {
      url: 'https://account.example.test',
      mcpUrl: 'https://account.example.test/mcp',
      userId: 'user-1',
      displayName: 'Account User',
      email: 'user@example.test',
    },
  });
  assert.equal(signIn.ok, true);
  await harness.lifecycle.connectCommittedAccountBrain(signIn.id!);
  assert.equal(harness.pool.reconnectCatalog.has(signIn.id!), true);
  const connectsBeforeSignOut = harness.pool.connects.length;

  const result = await harness.lifecycle.signOutAccount();
  await harness.pool.sweepReconnect();

  const disk = harness.disk() as Config & { cli?: { account?: unknown; brainUrl?: string | null } };
  assert.equal(result.ok, true);
  assert.equal(disk.servers[signIn.id!], undefined);
  assert.equal(disk.cli?.account, undefined);
  assert.equal(disk.cli?.brainUrl, undefined);
  assert.deepEqual(harness.pool.removed, [signIn.id!]);
  assert.equal(harness.pool.reconnectCatalog.has(signIn.id!), false, 'removeOne clears the supervisor reconnect catalog');
  assert.equal(harness.pool.connects.length, connectsBeforeSignOut, 'a supervisor sweep cannot reconnect the signed-out credential');
});

test('desktop account sign-out stays committed and pauses reconnect when live removal fails', async () => {
  const harness = lifecycleHarness({ activeServer: '', servers: {}, llm });
  const signIn = await harness.lifecycle.commitAccountSignIn({
    profile: {
      type: 'http',
      url: 'https://account.example.test/mcp',
      apiKey: 'account-key',
      identity: 'brainrouter',
    },
    account: {
      url: 'https://account.example.test',
      mcpUrl: 'https://account.example.test/mcp',
      userId: 'user-1',
      displayName: 'Account User',
      email: 'user@example.test',
    },
  });
  await harness.lifecycle.connectCommittedAccountBrain(signIn.id!);
  harness.pool.removeFailures.add(signIn.id!);
  const connectsBeforeSignOut = harness.pool.connects.length;

  const result = await harness.lifecycle.signOutAccount();
  await harness.pool.sweepReconnect();

  const disk = harness.disk() as Config & { cli?: { account?: unknown } };
  assert.equal(result.ok, true, 'post-commit live cleanup is a warning, not a rolled-back logout');
  assert.match(result.warning ?? '', /automatic reconnect remains paused/i);
  assert.equal(disk.servers[signIn.id!], undefined);
  assert.equal(disk.cli?.account, undefined);
  assert.equal(harness.pool.supervisorRunning, false, 'a retained in-memory credential cannot auto-reconnect');
  assert.equal(harness.pool.connects.length, connectsBeforeSignOut);
});
