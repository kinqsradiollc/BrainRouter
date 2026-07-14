import test from 'node:test';
import assert from 'node:assert/strict';
import {
  brainRouterAccountHeaders,
  createGithubTrackProxyFetch,
  createGitlabTrackProxyFetch,
  fetchAccountConnectorStatuses,
  fetchAutomationAccountStatus,
  fetchGithubAccountStatus,
  resolveBrainRouterAccountApi,
  resolveBrainRouterAccountContext,
  resolveDesktopAccountIdentity,
  startAccountConnectorOAuth,
} from './accountIntegration.js';

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
