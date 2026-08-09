import {
  MODEL_REASONING_EFFORTS,
  type ModelCapabilities,
  type ModelCapabilityProvenanceSource,
  type ModelPolicy,
  type ModelReasoningEffort,
  type ModelReasoningPolicy,
} from '@kinqs/brainrouter-types';

type AccountConfig = {
  cli?: { account?: { url?: string; userId?: string; orgId?: string; displayName?: string; email?: string } };
  servers?: Record<string, {
    identity?: string;
    apiKey?: string;
    url?: string;
    headers?: Record<string, string>;
  }>;
};

const BRAINROUTER_ORG_HEADER = 'X-BrainRouter-Org';

function isBrainRouterServer(id: string, server: { identity?: string }): boolean {
  return server.identity === 'brainrouter' || /^brainrouter/i.test(id);
}

/**
 * ADR-032 D8 — record which tenant this install is currently working as.
 *
 * Sign-in writes `userId`; the ACTIVE ORG is a later, separate choice that the
 * user can change at any time from the workspace switcher, so it cannot be
 * captured once at sign-in without going stale the first time they switch. The
 * learned store keys on `cli.account`, and core reads that file rather than
 * renderer state, so the switcher's selection has to land here to have any
 * effect on the partition.
 *
 * Pure on purpose: the decision (what changes, and whether anything changed at
 * all) is separable from the config write, so it can be tested without a disk.
 *
 * An empty/unknown org clears the field rather than storing `''`. An absent org
 * means PERSONAL, and personal is the safe reading — a lesson learned in one
 * customer's workspace reaching another is a data leak with a pleasant name.
 * Signed-out installs are left alone entirely: an org id with no account behind
 * it would claim a tenancy nothing established.
 */
export function withAccountOrgId(
  config: unknown,
  orgId: unknown,
): { changed: boolean; next: AccountConfig } {
  const source = (config ?? {}) as AccountConfig;
  const next: AccountConfig = {
    ...source,
    ...(source.cli ? {
      cli: {
        ...source.cli,
        ...(source.cli.account ? { account: { ...source.cli.account } } : {}),
      },
    } : {}),
    ...(source.servers ? {
      servers: Object.fromEntries(Object.entries(source.servers).map(([id, server]) => [
        id,
        { ...server, ...(server.headers ? { headers: { ...server.headers } } : {}) },
      ])),
    } : {}),
  };
  const account = next.cli?.account;
  if (!account) return { changed: false, next };
  const desired = typeof orgId === 'string' ? orgId.trim() : '';
  const current = typeof account.orgId === 'string' ? account.orgId.trim() : '';
  let changed = desired !== current;
  if (changed) {
    if (desired) account.orgId = desired;
    else delete account.orgId;
  }

  // The learned ledger and the central memory lifecycle must cross the same
  // tenant boundary. HTTP MCP transport headers are fixed at connection time,
  // so persist the selected org on every BrainRouter profile; the host then
  // reconnects those profiles before constructing a replacement Agent.
  for (const [id, server] of Object.entries(next.servers ?? {})) {
    if (!isBrainRouterServer(id, server)) continue;
    const headers = { ...(server.headers ?? {}) };
    let foundDesired = false;
    let headerChanged = false;
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() !== BRAINROUTER_ORG_HEADER.toLowerCase()) continue;
      if (key === BRAINROUTER_ORG_HEADER && headers[key] === desired && desired && !foundDesired) {
        foundDesired = true;
        continue;
      }
      delete headers[key];
      headerChanged = true;
    }
    if (desired && !foundDesired) {
      headers[BRAINROUTER_ORG_HEADER] = desired;
      headerChanged = true;
    }
    if (!headerChanged) continue;
    if (Object.keys(headers).length) server.headers = headers;
    else delete server.headers;
    changed = true;
  }
  return { changed, next };
}

type FetchResponse = {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
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

/**
 * PERF — the default account fetch, with a bounded timeout so an unreachable or
 * slow account server can't hang desktop boot for the OS socket timeout (tens of
 * seconds). Injected test/production fetches that already carry a signal are
 * unaffected (they pass their own fetchImpl).
 */
const ACCOUNT_FETCH_TIMEOUT_MS = 4000;
export const timeoutFetch: AccountFetch = ((
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<FetchResponse> =>
  (globalThis.fetch as unknown as (u: string, i?: unknown) => Promise<FetchResponse>)(url, {
    ...(init ?? {}),
    signal: AbortSignal.timeout(ACCOUNT_FETCH_TIMEOUT_MS),
  })) as AccountFetch;

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

/** Credential-free state Electron can expose synchronously before the utility
 * host boots. It is intentionally limited to durable display identity. */
export interface DesktopBootstrapState {
  accountStatus: {
    signedIn: boolean;
    account: {
      url: string;
      userId: string;
      displayName: string;
      email: string;
    } | null;
  };
}

/** Renderer-safe snapshot for the built-in, read-only BrainRouter provider. */
export interface DesktopAccountModelCatalog {
  signedIn: boolean;
  provider: { id: 'brainrouter'; label: 'BrainRouter'; readOnly: true };
  revision: string | null;
  etag: string | null;
  models: ModelPolicy[];
  stale: boolean;
  refreshedAt: string | null;
  error?: string;
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

/** Turn low-level fetch/socket failures into a stable message suitable for the
 * renderer. HTTP and catalog-validation failures remain specific so operators
 * can still distinguish a bad response from an unavailable account service. */
export function accountServiceError(error: unknown, fallback: string): string {
  if (error instanceof TypeError) return 'BrainRouter service is unavailable. Check the connection and try again.';
  if (error instanceof Error) {
    const cause = error.cause && typeof error.cause === 'object'
      ? error.cause as { code?: unknown }
      : null;
    const code = typeof cause?.code === 'string' ? cause.code : '';
    if (
      error.name === 'AbortError'
      || error.name === 'TimeoutError'
      || code.startsWith('UND_ERR_')
      || /^(?:ECONN|EHOST|ENET|ETIMEDOUT|EAI_)/.test(code)
    ) {
      return 'BrainRouter service is unavailable. Check the connection and try again.';
    }
    if (error.message.trim()) return error.message;
  }
  return fallback;
}

const MODEL_EFFORTS = new Set<string>(MODEL_REASONING_EFFORTS);
const CAPABILITY_SOURCES = new Set<ModelCapabilityProvenanceSource>(['verified', 'discovered', 'manual', 'inferred']);

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Model catalog ${field} is required.`);
  return value.trim();
}

function capabilitySource(value: unknown, field: string): ModelCapabilityProvenanceSource {
  if (typeof value !== 'string' || !CAPABILITY_SOURCES.has(value as ModelCapabilityProvenanceSource)) {
    throw new Error(`Model catalog ${field} is invalid.`);
  }
  return value as ModelCapabilityProvenanceSource;
}

function parseCapabilities(value: unknown): ModelCapabilities {
  const raw = asRecord(value);
  for (const field of ['streaming', 'tools', 'responses', 'reasoning'] as const) {
    if (typeof raw[field] !== 'boolean') throw new Error(`Model catalog capability "${field}" must be boolean.`);
  }
  return {
    streaming: raw.streaming as boolean,
    tools: raw.tools as boolean,
    responses: raw.responses as boolean,
    reasoning: raw.reasoning as boolean,
  };
}

function parseReasoning(value: unknown): ModelReasoningPolicy | null {
  if (value === null) return null;
  const raw = asRecord(value);
  if (!Array.isArray(raw.allowed)) throw new Error('Model catalog reasoning.allowed must be an array.');
  const allowed = raw.allowed.map((entry) => {
    const item = asRecord(entry);
    const id = nonEmptyString(item.id, 'reasoning effort') as ModelReasoningEffort;
    if (!MODEL_EFFORTS.has(id)) throw new Error(`Model catalog contains unsupported effort "${id}".`);
    return { id, label: nonEmptyString(item.label, `reasoning label for ${id}`) };
  });
  if (new Set(allowed.map((entry) => entry.id)).size !== allowed.length) {
    throw new Error('Model catalog contains duplicate reasoning efforts.');
  }
  const defaultEffort = raw.default === null ? null : nonEmptyString(raw.default, 'reasoning default') as ModelReasoningEffort;
  if (defaultEffort !== null && !allowed.some((entry) => entry.id === defaultEffort)) {
    throw new Error('Model catalog reasoning default is not allowed.');
  }
  if (raw.mode !== 'selectable' && raw.mode !== 'adaptive') throw new Error('Model catalog reasoning mode is invalid.');
  if (raw.manualBudgetTokens !== undefined && raw.manualBudgetTokens !== 'supported' && raw.manualBudgetTokens !== 'unsupported') {
    throw new Error('Model catalog manual budget support is invalid.');
  }
  return {
    default: defaultEffort,
    allowed,
    source: capabilitySource(raw.source, 'reasoning source'),
    mode: raw.mode,
    ...(raw.manualBudgetTokens ? { manualBudgetTokens: raw.manualBudgetTokens } : {}),
  };
}

function parseModelPolicy(value: unknown): ModelPolicy {
  const raw = asRecord(value);
  if (raw.provider !== 'brainrouter') throw new Error('Model catalog provider must be BrainRouter.');
  if (raw.enabled !== true) throw new Error('Model catalog returned a disabled model.');
  const provenance = asRecord(raw.provenance);
  const sourceUrl = typeof provenance.sourceUrl === 'string' && provenance.sourceUrl.trim() ? provenance.sourceUrl.trim() : undefined;
  const verifiedAt = typeof provenance.verifiedAt === 'string' && provenance.verifiedAt.trim() ? provenance.verifiedAt.trim() : undefined;
  return {
    id: nonEmptyString(raw.id, 'model id'),
    label: nonEmptyString(raw.label, 'model label'),
    provider: 'brainrouter',
    enabled: true,
    capabilities: parseCapabilities(raw.capabilities),
    reasoning: parseReasoning(raw.reasoning),
    provenance: {
      source: capabilitySource(provenance.source, 'provenance source'),
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(verifiedAt ? { verifiedAt } : {}),
    },
    revision: nonEmptyString(raw.revision, 'model revision'),
  };
}

export function emptyAccountModelCatalog(signedIn: boolean, error?: string): DesktopAccountModelCatalog {
  return {
    signedIn,
    provider: { id: 'brainrouter', label: 'BrainRouter', readOnly: true },
    revision: null,
    etag: null,
    models: [],
    stale: false,
    refreshedAt: null,
    ...(error ? { error } : {}),
  };
}

/** Fetch and strictly whitelist the member-safe model catalog. Account bearer
 * and gateway endpoint never enter the returned object. `previous` enables
 * normal ETag revalidation plus an explicit stale offline view. */
export async function fetchAccountModelCatalog(
  account: BrainRouterAccountContext | null,
  previous: DesktopAccountModelCatalog | null,
  fetchImpl: AccountFetch = timeoutFetch,
): Promise<DesktopAccountModelCatalog> {
  if (!account) return emptyAccountModelCatalog(false);
  const headers = brainRouterAccountHeaders(account);
  if (previous?.etag) headers['If-None-Match'] = previous.etag;
  try {
    const response = await fetchImpl(`${account.baseUrl}/api/models/catalog`, { headers });
    if (response.status === 304 && previous) {
      return { ...previous, stale: false, refreshedAt: new Date().toISOString(), error: undefined };
    }
    const body = await safeJson(response);
    if (!response.ok) throw new Error(responseError(response, body));
    const revision = nonEmptyString(body.revision, 'revision');
    if (!Array.isArray(body.models)) throw new Error('Model catalog models must be an array.');
    const models = body.models.map(parseModelPolicy);
    return {
      signedIn: true,
      provider: { id: 'brainrouter', label: 'BrainRouter', readOnly: true },
      revision,
      etag: response.headers?.get('etag') ?? `"${revision}"`,
      models,
      stale: false,
      refreshedAt: new Date().toISOString(),
    };
  } catch (error) {
    const message = accountServiceError(error, 'Unable to refresh the BrainRouter model catalog.');
    return previous
      ? { ...previous, signedIn: true, stale: true, error: message }
      : emptyAccountModelCatalog(true, message);
  }
}

function normalizeAccountBaseUrl(value: unknown, fromMcpProfile = false): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    url.hash = '';
    url.search = '';
    // A BrainRouter MCP profile normally points at `<account>/mcp`. Keep any
    // deployment path prefix, but remove the MCP endpoint before calling the
    // account REST API. Explicit cli.account URLs are already API bases and
    // retain their path unchanged.
    const pathname = url.pathname.replace(/\/+$/, '');
    url.pathname = fromMcpProfile && /\/mcp$/i.test(pathname)
      ? pathname.slice(0, -4) || '/'
      : (fromMcpProfile ? '/' : pathname || '/');
    return url.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/** Resolve the account API base from either modern account metadata or an
 * existing BrainRouter MCP profile. The latter keeps older CLI/desktop logins
 * fully usable instead of reporting "signed out" while their server key works. */
export function resolveBrainRouterAccountBaseUrl(config: unknown): string {
  const candidate = asRecord(config) as AccountConfig;
  const serverId = Object.keys(candidate.servers ?? {}).find((id) => {
    const server = candidate.servers?.[id];
    return server?.identity === 'brainrouter' || /^brainrouter/i.test(id);
  });
  return normalizeAccountBaseUrl(candidate.cli?.account?.url)
    || normalizeAccountBaseUrl(serverId ? candidate.servers?.[serverId]?.url : '', true);
}

export function resolveBrainRouterAccountApi(config: unknown): BrainRouterAccountApi | null {
  const candidate = asRecord(config) as AccountConfig;
  const baseUrl = resolveBrainRouterAccountBaseUrl(candidate);
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
    signedIn: account !== undefined || resolveBrainRouterAccountApi(candidate) !== null,
    username: displayName || email || fallback,
    ...(email ? { email } : {}),
  };
}

/** Build the renderer's launch snapshot from local config only. No network or
 * safe-storage read is required, and no bearer/API key crosses the bridge. */
export function resolveDesktopBootstrapState(config: unknown, fallbackUsername: string): DesktopBootstrapState {
  const candidate = asRecord(config) as AccountConfig;
  const identity = resolveDesktopAccountIdentity(candidate, fallbackUsername);
  if (!identity.signedIn) return { accountStatus: { signedIn: false, account: null } };
  const stored = candidate.cli?.account;
  const connected = resolveBrainRouterAccountApi(candidate);
  return {
    accountStatus: {
      signedIn: true,
      account: {
        url: normalizeAccountBaseUrl(stored?.url) || connected?.baseUrl || '',
        userId: String(stored?.userId ?? '').trim(),
        displayName: String(stored?.displayName ?? '').trim() || identity.username,
        email: String(stored?.email ?? '').trim(),
      },
    },
  };
}

/** Resolve the desktop account's active organization from the same default-org
 * contract the dashboard uses. Account-backed connector/review calls must carry
 * this context explicitly instead of relying on a server-side fallback. */
export async function resolveBrainRouterAccountContext(
  config: unknown,
  fetchImpl: AccountFetch = timeoutFetch,
): Promise<BrainRouterAccountContext | null> {
  const candidate = asRecord(config) as AccountConfig;
  const account = resolveBrainRouterAccountApi(candidate);
  if (!account) return null;
  const response = await fetchImpl(`${account.baseUrl}/api/orgs`, {
    headers: { Authorization: `Bearer ${account.apiKey}` },
  });
  const body = await safeJson(response);
  if (!response.ok) throw new Error(responseError(response, body));
  const orgs = Array.isArray(body.orgs)
    ? body.orgs.map(asRecord).filter((org) => typeof org.orgId === 'string')
    : [];
  const selectedOrgId = String(candidate.cli?.account?.orgId ?? '').trim();
  const selected = orgs.find((entry) => selectedOrgId && String(entry.orgId).trim() === selectedOrgId);
  if (selectedOrgId && !selected) {
    throw new Error('The selected BrainRouter organization is no longer available. Choose an active organization.');
  }
  const org = selected ?? orgs.find((entry) => entry.isDefault === true) ?? orgs[0];
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
    ...(account.orgId ? { 'X-BrainRouter-Org': account.orgId } : {}),
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

export async function startAccountConnectorOAuth(
  account: BrainRouterAccountContext,
  source: string,
  fetchImpl: AccountFetch = timeoutFetch,
  connectorId?: string,
): Promise<{ ok: boolean; url?: string; error?: string }> {
  // `connectorId` (multi-account) re-connects a specific existing account rather
  // than minting a new one; the backend reads it as a query param and verifies
  // ownership before binding it into the signed state.
  const query = connectorId ? `?connectorId=${encodeURIComponent(connectorId)}` : '';
  const response = await fetchImpl(
    `${account.baseUrl}/api/connectors/${encodeURIComponent(source)}/oauth/start${query}`,
    { method: 'POST', headers: brainRouterAccountHeaders(account, true) },
  );
  const body = await safeJson(response);
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (!response.ok || !url) return { ok: false, error: responseError(response, body) };
  return { ok: true, url };
}

/** A bounded, metadata-only view of account-managed OAuth connectors for the
 * desktop Configured list. The server remains the credential source of truth;
 * this function copies only an allowlist of status fields into the renderer. */
export async function fetchAccountConnectorStatuses(
  config: unknown,
  sources: readonly string[],
  fetchImpl: AccountFetch = timeoutFetch,
): Promise<AccountConnectorSnapshotResult> {
  if (!resolveBrainRouterAccountApi(config)) return { signedIn: false, connectors: [] };
  try {
    const account = await resolveBrainRouterAccountContext(config, fetchImpl);
    if (!account) return { signedIn: false, connectors: [] };
    const boundedSources = [...new Set(sources.map((source) => source.trim()).filter(Boolean))].slice(0, 12);
    // Multi-account: enumerate EVERY account per source (work + personal + …) via
    // the /accounts route, not the single /status connector — otherwise the
    // Configured list shows just one card for an N-account source and a connected
    // second account can render as disconnected.
    const perSource = await Promise.all(boundedSources.map(async (source): Promise<AccountConnectorSnapshot[]> => {
      try {
        const response = await fetchImpl(
          `${account.baseUrl}/api/connectors/${encodeURIComponent(source)}/accounts`,
          { headers: brainRouterAccountHeaders(account) },
        );
        const body = await safeJson(response);
        if (!response.ok) {
          return [{ source, connected: false, connector: null, error: responseError(response, body) }];
        }
        const list = Array.isArray(body.accounts) ? body.accounts : [];
        return list.map((entry): AccountConnectorSnapshot => {
          const raw = asRecord(entry);
          const id = typeof raw.id === 'string' ? raw.id.trim() : '';
          const connected = raw.connected === true;
          const connector = id ? {
            id,
            name: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : source,
            status: typeof raw.status === 'string' ? raw.status : (connected ? 'connected' : 'disconnected'),
            enabled: raw.enabled === true,
            config: {} as Record<string, unknown>,
            lastRunAt: typeof raw.lastRunAt === 'string' ? raw.lastRunAt : null,
            lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
          } : null;
          return {
            source,
            connected,
            connector,
            ...(typeof raw.account === 'string' ? { account: raw.account } : {}),
          };
        });
      } catch (error) {
        return [{
          source,
          connected: false,
          connector: null,
          error: error instanceof Error ? error.message : 'Unable to read connector status.',
        }];
      }
    }));
    return {
      signedIn: true,
      orgId: account.orgId,
      ...(account.orgName ? { orgName: account.orgName } : {}),
      connectors: perSource.flat(),
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
  fetchImpl: AccountFetch = timeoutFetch,
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
  fetchImpl: AccountFetch = timeoutFetch,
): AccountTrackFetch {
  return createAccountTrackProxyFetch('github', account, fetchImpl);
}

export function createGitlabTrackProxyFetch(
  account: BrainRouterAccountContext,
  fetchImpl: AccountFetch = timeoutFetch,
): AccountTrackFetch {
  return createAccountTrackProxyFetch('gitlab', account, fetchImpl);
}

export async function fetchGithubAccountStatus(
  config: unknown,
  fetchImpl: AccountFetch = timeoutFetch,
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
  fetchImpl: AccountFetch = timeoutFetch,
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
