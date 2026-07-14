type AccountConfig = {
  cli?: { account?: { url?: string; displayName?: string; email?: string } };
  servers?: Record<string, { identity?: string; apiKey?: string }>;
};

type FetchResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};

export type AccountFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<FetchResponse>;

export type AccountTrackFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<FetchResponse & { text(): Promise<string> }>;

/** @deprecated Use AccountTrackFetch for provider-neutral connector traffic. */
export type GithubTrackFetch = AccountTrackFetch;

export interface BrainRouterAccountApi {
  baseUrl: string;
  apiKey: string;
}

export interface BrainRouterAccountContext extends BrainRouterAccountApi {
  orgId: string;
  orgName?: string;
}

export interface DesktopAccountIdentity {
  signedIn: boolean;
  username: string;
  email?: string;
}

export interface GithubAccountStatus {
  signedIn: boolean;
  connected: boolean;
  login?: string;
  orgId?: string;
  orgName?: string;
  error?: string;
}

export interface AutomationAccountStatus {
  signedIn: boolean;
  githubOauthConnected: boolean;
  githubLogin?: string;
  orgId?: string;
  orgName?: string;
  githubAppConfigured: boolean;
  githubAppInstalled: boolean;
  installUrl?: string;
  error?: string;
}

export interface AccountConnectorSnapshot {
  source: string;
  connected: boolean;
  connector: {
    id: string;
    name: string;
    status: string;
    enabled: boolean;
    config: Record<string, unknown>;
    lastRunAt: string | null;
    lastError: string | null;
  } | null;
  account?: string | null;
  error?: string;
}

export interface AccountConnectorSnapshotResult {
  signedIn: boolean;
  orgId?: string;
  orgName?: string;
  connectors: AccountConnectorSnapshot[];
  error?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function safeJson(response: FetchResponse): Promise<Record<string, unknown>> {
  try {
    return asRecord(await response.json());
  } catch {
    return {};
  }
}

function responseError(response: FetchResponse, body: Record<string, unknown>): string {
  const message = typeof body.error === 'string' ? body.error.trim() : '';
  return message || `HTTP ${response.status}`;
}

export function resolveBrainRouterAccountApi(config: unknown): BrainRouterAccountApi | null {
  const candidate = asRecord(config) as AccountConfig;
  const baseUrl = String(candidate.cli?.account?.url ?? '').trim().replace(/\/+$/, '');
  const serverId = Object.keys(candidate.servers ?? {}).find((id) => {
    const server = candidate.servers?.[id];
    return server?.identity === 'brainrouter' || /^brainrouter/i.test(id);
  });
  const apiKey = serverId ? String(candidate.servers?.[serverId]?.apiKey ?? '').trim() : '';
  return baseUrl && apiKey ? { baseUrl, apiKey } : null;
}

/** Resolve the renderer-facing identity without exposing account credentials.
 * A signed-in BrainRouter profile always wins over the operating-system account;
 * the OS name remains a local-only fallback so sign-in never gates desktop use. */
export function resolveDesktopAccountIdentity(config: unknown, fallbackUsername: string): DesktopAccountIdentity {
  const candidate = asRecord(config) as AccountConfig;
  const account = candidate.cli?.account;
  const displayName = String(account?.displayName ?? '').trim();
  const email = String(account?.email ?? '').trim();
  const fallback = String(fallbackUsername ?? '').trim() || 'BrainRouter user';
  return {
    signedIn: account !== undefined,
    username: displayName || email || fallback,
    ...(email ? { email } : {}),
  };
}

/** Resolve the desktop account's active organization from the same default-org
 * contract the dashboard uses. Account-backed connector/review calls must carry
 * this context explicitly instead of relying on a server-side fallback. */
export async function resolveBrainRouterAccountContext(
  config: unknown,
  fetchImpl: AccountFetch = globalThis.fetch as unknown as AccountFetch,
): Promise<BrainRouterAccountContext | null> {
  const account = resolveBrainRouterAccountApi(config);
  if (!account) return null;
  const response = await fetchImpl(`${account.baseUrl}/api/orgs`, {
    headers: { Authorization: `Bearer ${account.apiKey}` },
  });
  const body = await safeJson(response);
  if (!response.ok) throw new Error(responseError(response, body));
  const orgs = Array.isArray(body.orgs)
    ? body.orgs.map(asRecord).filter((org) => typeof org.orgId === 'string')
    : [];
  const org = orgs.find((entry) => entry.isDefault === true) ?? orgs[0];
  if (!org) throw new Error('No active BrainRouter organization is available.');
  const orgId = String(org.orgId).trim();
  if (!orgId) throw new Error('No active BrainRouter organization is available.');
  const orgName = typeof org.name === 'string' ? org.name.trim() : '';
  return { ...account, orgId, ...(orgName ? { orgName } : {}) };
}

export function brainRouterAccountHeaders(
  account: BrainRouterAccountContext,
  json = false,
): Record<string, string> {
  return {
    Authorization: `Bearer ${account.apiKey}`,
    'X-BrainRouter-Org': account.orgId,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

export async function startAccountConnectorOAuth(
  account: BrainRouterAccountContext,
  source: string,
  fetchImpl: AccountFetch = globalThis.fetch as unknown as AccountFetch,
): Promise<{ ok: boolean; url?: string; error?: string }> {
  const response = await fetchImpl(
    `${account.baseUrl}/api/connectors/${encodeURIComponent(source)}/oauth/start`,
    { method: 'POST', headers: brainRouterAccountHeaders(account, true) },
  );
  const body = await safeJson(response);
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (!response.ok || !url) return { ok: false, error: responseError(response, body) };
  return { ok: true, url };
}

const SECRETISH_CONFIG_KEY = /(token|secret|password|passphrase|apikey|api[_-]?key|credential|refresh|client[_-]?secret|private[_-]?key)/i;

/** A bounded, metadata-only view of account-managed OAuth connectors for the
 * desktop Configured list. The server remains the credential source of truth;
 * this function copies only an allowlist of status fields into the renderer. */
export async function fetchAccountConnectorStatuses(
  config: unknown,
  sources: readonly string[],
  fetchImpl: AccountFetch = globalThis.fetch as unknown as AccountFetch,
): Promise<AccountConnectorSnapshotResult> {
  if (!resolveBrainRouterAccountApi(config)) return { signedIn: false, connectors: [] };
  try {
    const account = await resolveBrainRouterAccountContext(config, fetchImpl);
    if (!account) return { signedIn: false, connectors: [] };
    const boundedSources = [...new Set(sources.map((source) => source.trim()).filter(Boolean))].slice(0, 12);
    const connectors = await Promise.all(boundedSources.map(async (source): Promise<AccountConnectorSnapshot> => {
      try {
        const response = await fetchImpl(
          `${account.baseUrl}/api/connectors/${encodeURIComponent(source)}/status`,
          { headers: brainRouterAccountHeaders(account) },
        );
        const body = await safeJson(response);
        if (!response.ok) {
          return { source, connected: false, connector: null, error: responseError(response, body) };
        }
        const raw = asRecord(body.connector);
        const id = typeof raw.id === 'string' ? raw.id.trim() : '';
        const connector = id ? {
          id,
          name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : source,
          status: typeof raw.status === 'string' ? raw.status : 'connected',
          enabled: raw.enabled === true,
          config: Object.fromEntries(
            Object.entries(asRecord(raw.config)).filter(([key]) => !SECRETISH_CONFIG_KEY.test(key)),
          ),
          lastRunAt: typeof raw.lastRunAt === 'string' ? raw.lastRunAt : null,
          lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
        } : null;
        return {
          source,
          connected: body.connected === true,
          connector,
          ...(typeof body.account === 'string' ? { account: body.account } : {}),
        };
      } catch (error) {
        return {
          source,
          connected: false,
          connector: null,
          error: error instanceof Error ? error.message : 'Unable to read connector status.',
        };
      }
    }));
    return {
      signedIn: true,
      orgId: account.orgId,
      ...(account.orgName ? { orgName: account.orgName } : {}),
      connectors,
    };
  } catch (error) {
    return {
      signedIn: true,
      connectors: [],
      error: error instanceof Error ? error.message : 'Unable to read account connector status.',
    };
  }
}

function createAccountTrackProxyFetch(
  source: 'github' | 'gitlab',
  account: BrainRouterAccountContext,
  fetchImpl: AccountFetch = globalThis.fetch as unknown as AccountFetch,
): AccountTrackFetch {
  return async (url, init) => {
    const providerUrl = new URL(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    let requestBody: unknown;
    if (init?.body) {
      try { requestBody = JSON.parse(init.body); }
      catch { requestBody = init.body; }
    }
    // URL() already normalizes, but reject any traversal segment as defense-in-depth
    // so a crafted path can never walk outside the provider API (CWE-22).
    if (/(^|\/)\.\.(\/|$)/.test(providerUrl.pathname)) {
      throw new Error('Invalid provider path.');
    }
    const providerPath = source === 'gitlab'
      ? providerUrl.pathname.replace(/^\/api\/v4(?=\/)/, '') + providerUrl.search
      : providerUrl.pathname + providerUrl.search;
    const response = await fetchImpl(`${account.baseUrl}/api/connectors/${source}/track/proxy`, {
      method: 'POST',
      headers: brainRouterAccountHeaders(account, true),
      body: JSON.stringify({
        method,
        path: providerPath,
        ...(requestBody !== undefined ? { body: requestBody } : {}),
      }),
    });
    const wrapper = await safeJson(response);
    const status = typeof wrapper.status === 'number' ? wrapper.status : wrapper.ok === true ? 200 : 500;
    const data = wrapper.data ?? (typeof wrapper.error === 'string' ? { message: wrapper.error } : null);
    return {
      ok: wrapper.ok === true || (wrapper.ok === undefined && status >= 200 && status < 300),
      status,
      json: async () => data,
      text: async () => typeof data === 'string' ? data : JSON.stringify(data ?? ''),
    };
  };
}

export function createGithubTrackProxyFetch(
  account: BrainRouterAccountContext,
  fetchImpl: AccountFetch = globalThis.fetch as unknown as AccountFetch,
): AccountTrackFetch {
  return createAccountTrackProxyFetch('github', account, fetchImpl);
}

export function createGitlabTrackProxyFetch(
  account: BrainRouterAccountContext,
  fetchImpl: AccountFetch = globalThis.fetch as unknown as AccountFetch,
): AccountTrackFetch {
  return createAccountTrackProxyFetch('gitlab', account, fetchImpl);
}

export async function fetchGithubAccountStatus(
  config: unknown,
  fetchImpl: AccountFetch = globalThis.fetch as unknown as AccountFetch,
): Promise<GithubAccountStatus> {
  const account = resolveBrainRouterAccountApi(config);
  if (!account) return { signedIn: false, connected: false };

  try {
    const context = await resolveBrainRouterAccountContext(config, fetchImpl);
    if (!context) return { signedIn: false, connected: false };
    const response = await fetchImpl(`${context.baseUrl}/api/connectors/github/status`, {
      headers: brainRouterAccountHeaders(context),
    });
    const body = await safeJson(response);
    if (!response.ok) {
      return {
        signedIn: true,
        connected: false,
        orgId: context.orgId,
        ...(context.orgName ? { orgName: context.orgName } : {}),
        error: responseError(response, body),
      };
    }

    const login = typeof body.login === 'string' ? body.login.trim() : '';
    const providerError = typeof body.error === 'string' ? body.error.trim() : '';
    return {
      signedIn: true,
      connected: body.connected === true,
      ...(login ? { login } : {}),
      orgId: context.orgId,
      ...(context.orgName ? { orgName: context.orgName } : {}),
      ...(providerError ? { error: providerError } : {}),
    };
  } catch (error) {
    return {
      signedIn: true,
      connected: false,
      error: error instanceof Error ? error.message : 'Unable to reach BrainRouter account.',
    };
  }
}

export async function fetchAutomationAccountStatus(
  config: unknown,
  fetchImpl: AccountFetch = globalThis.fetch as unknown as AccountFetch,
): Promise<AutomationAccountStatus> {
  const account = resolveBrainRouterAccountApi(config);
  if (!account) {
    return {
      signedIn: false,
      githubOauthConnected: false,
      githubAppConfigured: false,
      githubAppInstalled: false,
    };
  }

  const github = await fetchGithubAccountStatus(config, fetchImpl);
  const base: AutomationAccountStatus = {
    signedIn: true,
    githubOauthConnected: github.connected,
    ...(github.login ? { githubLogin: github.login } : {}),
    ...(github.orgId ? { orgId: github.orgId } : {}),
    ...(github.orgName ? { orgName: github.orgName } : {}),
    githubAppConfigured: false,
    githubAppInstalled: false,
  };

  if (!github.orgId) return github.error ? { ...base, error: github.error } : base;

  try {
    const appResponse = await fetchImpl(
      `${account.baseUrl}/api/orgs/${encodeURIComponent(github.orgId)}/github/status`,
      { headers: brainRouterAccountHeaders({ ...account, orgId: github.orgId }) },
    );
    const appBody = await safeJson(appResponse);
    if (!appResponse.ok) {
      return {
        ...base,
        error: responseError(appResponse, appBody),
      };
    }

    const installUrl = typeof appBody.installUrl === 'string' ? appBody.installUrl.trim() : '';
    return {
      ...base,
      githubAppConfigured: appBody.configured === true,
      githubAppInstalled: appBody.installed === true,
      ...(installUrl ? { installUrl } : {}),
      ...(github.error ? { error: github.error } : {}),
    };
  } catch (error) {
    return {
      ...base,
      error: error instanceof Error ? error.message : 'Unable to read account automation status.',
    };
  }
}
