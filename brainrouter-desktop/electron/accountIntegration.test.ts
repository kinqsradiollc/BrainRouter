import test from 'node:test';
import assert from 'node:assert/strict';
import {
  brainRouterAccountHeaders,
  createGithubTrackProxyFetch,
  createGitlabTrackProxyFetch,
  fetchAccountConnectorStatuses,
  fetchAutomationAccountStatus,
  fetchAccountModelCatalog,
  fetchGithubAccountStatus,
  resolveBrainRouterAccountApi,
  resolveBrainRouterAccountContext,
  resolveDesktopAccountIdentity,
  startAccountConnectorOAuth,
} from './accountIntegration.js';
import { scrubCliSecrets } from './host/helpers.js';

const config = {
  cli: { account: { url: 'https://account.brainrouter.test/' } },
  servers: {
    unrelated: { identity: 'other', apiKey: 'nope' },
    cloud: { identity: 'brainrouter', apiKey: 'account-key' },
  },
};

type JsonResponse = { ok: boolean; status: number; json(): Promise<unknown> };
const response = (status: number, body: unknown): JsonResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

test('resolveBrainRouterAccountApi returns only the account endpoint and bearer key', () => {
  assert.deepEqual(resolveBrainRouterAccountApi(config), {
    baseUrl: 'https://account.brainrouter.test',
    apiKey: 'account-key',
  });
  assert.equal(resolveBrainRouterAccountApi({}), null);
});

test('renderer config snapshots strip legacy account bearer fields', () => {
  const cli = scrubCliSecrets({
    account: {
      url: 'https://account.brainrouter.test',
      email: 'member@example.test',
      jwt: 'secret-jwt',
      refreshToken: 'secret-refresh',
      accessToken: 'secret-access',
      apiKey: 'secret-api-key',
    },
  });
  assert.deepEqual(cli.account, {
    url: 'https://account.brainrouter.test',
    email: 'member@example.test',
  });
});

test('desktop identity prefers the BrainRouter profile and keeps signed-out use local', () => {
  assert.deepEqual(resolveDesktopAccountIdentity({
    cli: { account: { url: 'https://account.brainrouter.test', displayName: 'Ada Lovelace', email: 'ada@example.test' } },
  }, 'mac-user'), {
    signedIn: true,
    username: 'Ada Lovelace',
    email: 'ada@example.test',
  });
  assert.deepEqual(resolveDesktopAccountIdentity({
    cli: { account: { url: 'https://account.brainrouter.test', email: 'grace@example.test' } },
  }, 'mac-user'), {
    signedIn: true,
    username: 'grace@example.test',
    email: 'grace@example.test',
  });
  assert.deepEqual(resolveDesktopAccountIdentity({}, 'mac-user'), {
    signedIn: false,
    username: 'mac-user',
  });
});

test('fetchGithubAccountStatus reflects sealed account OAuth without returning a provider token', async () => {
  const calls: Array<{ url: string; authorization?: string; orgId?: string }> = [];
  const fetchImpl = async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, authorization: init?.headers?.Authorization, orgId: init?.headers?.['X-BrainRouter-Org'] });
    if (url.endsWith('/api/orgs')) {
      return response(200, { orgs: [{ orgId: 'org-main', name: 'Main org', isDefault: true }] });
    }
    return response(200, { connected: true, login: 'octocat', accessToken: 'must-not-cross' });
  };

  const status = await fetchGithubAccountStatus(config, fetchImpl);
  assert.deepEqual(status, {
    signedIn: true,
    connected: true,
    login: 'octocat',
    orgId: 'org-main',
    orgName: 'Main org',
  });
  assert.deepEqual(calls, [
    {
      url: 'https://account.brainrouter.test/api/orgs',
      authorization: 'Bearer account-key',
      orgId: undefined,
    },
    {
      url: 'https://account.brainrouter.test/api/connectors/github/status',
      authorization: 'Bearer account-key',
      orgId: 'org-main',
    },
  ]);
  assert.equal('accessToken' in status, false);
});

test('fetchAutomationAccountStatus joins OAuth and GitHub App installation state for the active org', async () => {
  const calls: Array<{ url: string; orgId?: string }> = [];
  const fetchImpl = async (url: string, init?: { headers?: Record<string, string> }): Promise<JsonResponse> => {
    calls.push({ url, orgId: init?.headers?.['X-BrainRouter-Org'] });
    if (url.endsWith('/api/connectors/github/status')) return response(200, { connected: true, login: 'octocat' });
    if (url.endsWith('/api/orgs')) return response(200, { orgs: [
      { orgId: 'org-secondary', name: 'Secondary' },
      { orgId: 'org-main', name: 'Main org', isDefault: true },
    ] });
    if (url.endsWith('/api/orgs/org-main/github/status')) return response(200, { configured: true, installed: true, installUrl: 'https://github.com/apps/brainrouter/installations/new' });
    return response(404, {});
  };

  assert.deepEqual(await fetchAutomationAccountStatus(config, fetchImpl), {
    signedIn: true,
    githubOauthConnected: true,
    githubLogin: 'octocat',
    orgId: 'org-main',
    orgName: 'Main org',
    githubAppConfigured: true,
    githubAppInstalled: true,
    installUrl: 'https://github.com/apps/brainrouter/installations/new',
  });
  assert.deepEqual(calls.map((call) => call.orgId), [undefined, 'org-main', 'org-main']);
});

test('account integration reads degrade to explicit signed-out or disconnected states', async () => {
  assert.deepEqual(await fetchGithubAccountStatus({}, async () => response(500, {})), { signedIn: false, connected: false });
  assert.deepEqual(
    await fetchGithubAccountStatus(config, async () => response(503, { error: 'offline' })),
    { signedIn: true, connected: false, error: 'offline' },
  );
});

test('fetchGithubAccountStatus preserves a provider reconnect reason returned with HTTP 200', async () => {
  const status = await fetchGithubAccountStatus(config, async (url) => {
    if (url.endsWith('/api/orgs')) return response(200, { orgs: [{ orgId: 'org-main', name: 'Main org', isDefault: true }] });
    return response(200, { connected: false, error: 'GitHub authorization expired or was revoked. Reconnect GitHub.' });
  });
  assert.deepEqual(status, {
    signedIn: true,
    connected: false,
    orgId: 'org-main',
    orgName: 'Main org',
    error: 'GitHub authorization expired or was revoked. Reconnect GitHub.',
  });
});

test('createGithubTrackProxyFetch tunnels collaborator reads without exposing the provider token', async () => {
  const calls: Array<{ url: string; authorization?: string; orgId?: string; body?: string }> = [];
  const fetchImpl = async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
    calls.push({ url, authorization: init?.headers?.Authorization, orgId: init?.headers?.['X-BrainRouter-Org'], body: init?.body });
    return response(200, { ok: true, status: 200, data: [{ login: 'octocat' }] });
  };
  const proxy = createGithubTrackProxyFetch({ baseUrl: 'https://account.brainrouter.test', apiKey: 'account-key', orgId: 'org-main' }, fetchImpl);

  const result = await proxy('https://api.github.com/repos/openai/codex/collaborators?per_page=100');
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), [{ login: 'octocat' }]);
  assert.deepEqual(calls, [{
    url: 'https://account.brainrouter.test/api/connectors/github/track/proxy',
    authorization: 'Bearer account-key',
    orgId: 'org-main',
    body: JSON.stringify({ method: 'GET', path: '/repos/openai/codex/collaborators?per_page=100' }),
  }]);
});

test('createGitlabTrackProxyFetch tunnels provider paths through the sealed account connector', async () => {
  const calls: Array<{ url: string; authorization?: string; orgId?: string; body?: string }> = [];
  const fetchImpl = async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
    calls.push({ url, authorization: init?.headers?.Authorization, orgId: init?.headers?.['X-BrainRouter-Org'], body: init?.body });
    return response(200, { ok: true, status: 201, data: { iid: 7 } });
  };
  const proxy = createGitlabTrackProxyFetch({ baseUrl: 'https://account.brainrouter.test', apiKey: 'account-key', orgId: 'org-main' }, fetchImpl);

  const result = await proxy('https://gitlab.test/api/v4/projects/acme%2Frepo/issues', {
    method: 'POST',
    body: JSON.stringify({ title: 'Ship it' }),
  });
  assert.equal(result.status, 201);
  assert.deepEqual(await result.json(), { iid: 7 });
  assert.deepEqual(calls, [{
    url: 'https://account.brainrouter.test/api/connectors/gitlab/track/proxy',
    authorization: 'Bearer account-key',
    orgId: 'org-main',
    body: JSON.stringify({ method: 'POST', path: '/projects/acme%2Frepo/issues', body: { title: 'Ship it' } }),
  }]);
});

test('account context and headers always pin account-backed requests to the default org', async () => {
  const context = await resolveBrainRouterAccountContext(config, async () => response(200, {
    orgs: [
      { orgId: 'org-secondary', name: 'Secondary' },
      { orgId: 'org-main', name: 'Main org', isDefault: true },
    ],
  }));

  assert.deepEqual(context, {
    baseUrl: 'https://account.brainrouter.test',
    apiKey: 'account-key',
    orgId: 'org-main',
    orgName: 'Main org',
  });
  assert.deepEqual(brainRouterAccountHeaders(context!, true), {
    Authorization: 'Bearer account-key',
    'X-BrainRouter-Org': 'org-main',
    'Content-Type': 'application/json',
  });
});

test('account connector OAuth start uses the JSON POST contract in the active org', async () => {
  const calls: Array<{ url: string; method?: string; headers?: Record<string, string> }> = [];
  const result = await startAccountConnectorOAuth(
    { baseUrl: 'https://account.brainrouter.test', apiKey: 'account-key', orgId: 'org-main' },
    'github',
    async (url, init) => {
      calls.push({ url, method: init?.method, headers: init?.headers });
      return response(200, { url: 'https://github.com/login/oauth/authorize?state=signed' });
    },
  );

  assert.deepEqual(result, { ok: true, url: 'https://github.com/login/oauth/authorize?state=signed' });
  assert.deepEqual(calls, [{
    url: 'https://account.brainrouter.test/api/connectors/github/oauth/start',
    method: 'POST',
    headers: {
      Authorization: 'Bearer account-key',
      'X-BrainRouter-Org': 'org-main',
      'Content-Type': 'application/json',
    },
  }]);
});

test('account connector snapshot is bounded, org-pinned, and strips credential material', async () => {
  const calls: Array<{ url: string; orgId?: string }> = [];
  const snapshot = await fetchAccountConnectorStatuses(
    config,
    ['slack', 'gitlab', 'slack'],
    async (url, init) => {
      calls.push({ url, orgId: init?.headers?.['X-BrainRouter-Org'] });
      if (url.endsWith('/api/orgs')) {
        return response(200, { orgs: [{ orgId: 'org-main', name: 'Main org', isDefault: true }] });
      }
      const source = url.includes('/slack/') ? 'slack' : 'gitlab';
      return response(200, {
        source,
        connected: true,
        connector: {
          id: `conn-${source}`,
          name: `${source} account`,
          status: 'connected',
          enabled: true,
          config: { pollMinutes: 15 },
          lastRunAt: '2026-07-13T00:00:00.000Z',
          lastError: null,
          credential: { accessToken: 'must-not-cross' },
        },
      });
    },
  );

  assert.equal(snapshot.signedIn, true);
  assert.equal(snapshot.orgId, 'org-main');
  assert.deepEqual(snapshot.connectors.map((item) => item.source), ['slack', 'gitlab']);
  assert.equal(JSON.stringify(snapshot).includes('must-not-cross'), false);
  assert.deepEqual(calls.map((call) => call.orgId), [undefined, 'org-main', 'org-main']);
});

test('account model catalog exposes only safe policy metadata and preserves exact efforts', async () => {
  const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
  const catalog = await fetchAccountModelCatalog(
    { baseUrl: 'https://account.brainrouter.test', apiKey: 'account-key', orgId: 'org-main' },
    null,
    async (url, init) => {
      calls.push({ url, headers: init?.headers });
      return {
        ...response(200, {
          revision: 'catalog:7',
          models: [{
            id: 'claude-fable-5',
            label: 'Claude Fable 5',
            provider: 'brainrouter',
            enabled: true,
            capabilities: { streaming: true, tools: true, responses: true, reasoning: true },
            reasoning: {
              default: 'high',
              allowed: [
                { id: 'low', label: 'Low' },
                { id: 'medium', label: 'Medium' },
                { id: 'high', label: 'High' },
                { id: 'xhigh', label: 'Extra high' },
                { id: 'max', label: 'Max' },
              ],
              source: 'verified',
              mode: 'adaptive',
              manualBudgetTokens: 'unsupported',
            },
            provenance: { source: 'verified', sourceUrl: 'https://docs.example/models', verifiedAt: '2026-07-14' },
            revision: 'model:7',
            upstreamModelId: 'custody-only-id',
            endpoint: 'https://upstream.example/v1',
            apiKey: 'must-not-cross',
          }],
        }),
        headers: { get: (name: string) => name.toLowerCase() === 'etag' ? '"catalog:7"' : null },
      };
    },
  );

  assert.equal(catalog.signedIn, true);
  assert.equal(catalog.revision, 'catalog:7');
  assert.equal(catalog.etag, '"catalog:7"');
  assert.deepEqual(catalog.models[0]?.reasoning?.allowed.map((entry) => entry.id), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(JSON.stringify(catalog).includes('must-not-cross'), false);
  assert.equal(JSON.stringify(catalog).includes('custody-only-id'), false);
  assert.equal(JSON.stringify(catalog).includes('upstream.example'), false);
  assert.deepEqual(calls, [{
    url: 'https://account.brainrouter.test/api/models/catalog',
    headers: {
      Authorization: 'Bearer account-key',
      'X-BrainRouter-Org': 'org-main',
    },
  }]);
});

test('account model catalog revalidates by ETag and fails closed on unsupported effort aliases', async () => {
  const previous = await fetchAccountModelCatalog(
    { baseUrl: 'https://account.brainrouter.test', apiKey: 'account-key', orgId: 'org-main' },
    null,
    async () => ({
      ...response(200, { revision: 'catalog:1', models: [] }),
      headers: { get: () => '"catalog:1"' },
    }),
  );
  let ifNoneMatch = '';
  const cached = await fetchAccountModelCatalog(
    { baseUrl: 'https://account.brainrouter.test', apiKey: 'account-key', orgId: 'org-main' },
    previous,
    async (_url, init) => {
      ifNoneMatch = init?.headers?.['If-None-Match'] ?? '';
      return { ...response(304, null), headers: { get: () => null } };
    },
  );
  assert.equal(ifNoneMatch, '"catalog:1"');
  assert.equal(cached.revision, 'catalog:1');
  assert.equal(cached.stale, false);

  const invalid = await fetchAccountModelCatalog(
    { baseUrl: 'https://account.brainrouter.test', apiKey: 'account-key', orgId: 'org-main' },
    null,
    async () => response(200, {
      revision: 'catalog:bad',
      models: [{
        id: 'bad', label: 'Bad', provider: 'brainrouter', enabled: true,
        capabilities: { streaming: true, tools: true, responses: true, reasoning: true },
        reasoning: { default: 'ultracode', allowed: [{ id: 'ultracode', label: 'Ultracode' }], source: 'manual', mode: 'selectable' },
        provenance: { source: 'manual' }, revision: 'bad',
      }],
    }),
  );
  assert.equal(invalid.models.length, 0);
  assert.match(invalid.error ?? '', /unsupported effort/i);
});
