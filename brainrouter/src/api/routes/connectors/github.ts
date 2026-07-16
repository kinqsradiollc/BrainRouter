/**
 * ADR-016 — server-mediated GitHub connect (per-user).
 *
 * The BrainRouter backend brokers GitHub sign-in for every user. The dashboard-configured,
 * deployment-wide OAuth App is the preferred browser sign-in
 * path. Its client secret stays sealed on the backend. The bundled/env GitHub App
 * remains a native-device fallback: the user enters a short code at GitHub and the
 * backend polls for a user-to-server token. Both credentials are stored sealed per user.
 *
 * OAuth-App tokens list repositories through `/user/repos`; device-flow GitHub-App
 * tokens list only their installations. The saved token flow selects the endpoint, so
 * the presence of the bundled device client cannot misclassify a browser OAuth token.
 *
 * Routes (mounted at /api/connectors):
 *   POST /github/device/start    (authed) → { userCode, verificationUri, interval }
 *   POST /github/device/poll     (authed) → { status: pending|connected|expired|error, login? }
 *   GET  /github/status          (authed) → { appConfigured, connected, login, installUrl }
 *   GET  /github/repos           (authed) → { connected, repos[], installUrl }
 *   POST /github/disconnect      (authed)
 * Browser OAuth start/callback are owned by the generic connector OAuth router.
 * Admin (mounted at /api/admin/connectors):
 *   GET/POST /github/app         (global admin) → deployment-wide OAuth App config
 */
import { Router } from "express";
import { memoryEngine } from "../../../memory/engine.js";
import { requireAnyAuth, type AuthedRequest } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/tenancy.js";
import { sendError } from "../../../contracts/http.js";
import { seal, isSecretBoxConfigured } from "../../../security/secretBox.js";
import { probeGithubConnection } from "./githubConnection.js";
import {
  githubAccountTokenFromResponse,
  githubAccountTokenSettingKey,
  githubAppClientId,
  githubRepositoryAccessMode,
  readGithubAccountToken,
  resolveGithubAccountToken,
  type GithubAccountToken,
} from "../../../connectors/githubAccountToken.js";
import {
  GITHUB_OAUTH_APP_SETTING_KEY,
  readGithubOAuthApp,
  resolveGithubOAuthApp,
  type GithubOAuthAppSetting,
} from "../../../connectors/githubOAuthApp.js";
import type { ConnectorConfigRecord, ConnectorTokenSecret } from "../../../connectors/store.js";
import { enqueueAgentJob } from "../../../memory/scheduler/jobs.js";

const APP_KEY = GITHUB_OAUTH_APP_SETTING_KEY;
const tokenKey = githubAccountTokenSettingKey;
const deviceKey = (userId: string) => `connectorDevice:github:${userId}`;
const GH = "https://github.com";
const GH_API = "https://api.github.com";
/** Only sent for the legacy OAuth-App path — a GitHub App device flow ignores scopes. */
const LEGACY_SCOPE = "repo read:org";

/** Unified view the routes use: env GitHub App (device flow) or legacy DB OAuth App. */
interface AppConfig { clientId: string; slug: string; isGithubApp: boolean; redirectBase?: string }
type UserToken = GithubAccountToken;
interface RepoRow { fullName: string; url: string; private: boolean; defaultBranch: string }

// The BrainRouter GitHub App is bundled by default — a GitHub App's client_id and
// slug are PUBLIC (not secrets), so shipping them means GitHub connect works with zero
// config, the same way `gh`/`claude` bundle their own client_id. A self-hosted
// deployment can point at its own App with one env var each (the "single .env" knob).
const DEFAULT_APP_SLUG = "brainrouter-memory-kinqsradiollc";
const APP_CLIENT_ID = githubAppClientId();
const APP_SLUG = process.env.BRAINROUTER_GITHUB_APP_SLUG?.trim() || DEFAULT_APP_SLUG;

async function getDbApp(): Promise<GithubOAuthAppSetting | null> {
  return readGithubOAuthApp(memoryEngine.emailAuth);
}
function getDeviceApp(): AppConfig | null {
  return APP_CLIENT_ID ? { clientId: APP_CLIENT_ID, slug: APP_SLUG, isGithubApp: true } : null;
}
/** A dashboard-configured OAuth App is the preferred interactive path. The
 * bundled GitHub App remains the zero-config device-flow fallback. */
async function getPreferredApp(): Promise<AppConfig | null> {
  const db = await resolveGithubOAuthApp(memoryEngine.emailAuth);
  if (db?.clientId && db.clientSecret) return { clientId: db.clientId, slug: "", isGithubApp: false, redirectBase: db.redirectBase };
  return getDeviceApp();
}
/** Public install page for the App (so the user can grant more repos). */
function installUrl(app: AppConfig | null): string | null {
  return app?.isGithubApp && app.slug ? `${GH}/apps/${app.slug}/installations/new` : null;
}
async function getUserToken(userId: string, existing?: UserToken | null): Promise<UserToken | null> {
  const stored = existing === undefined ? await readGithubAccountToken(memoryEngine.emailAuth, userId) : existing;
  const webApp = stored?.flow === "device" ? null : await resolveGithubOAuthApp(memoryEngine.emailAuth);
  return resolveGithubAccountToken(memoryEngine.emailAuth, userId, {
    clientId: webApp?.clientId ?? APP_CLIENT_ID,
    ...(webApp?.clientSecret ? { clientSecret: webApp.clientSecret } : {}),
  });
}

function connectorCredential(token: GithubAccountToken): ConnectorTokenSecret {
  return {
    accessToken: token.accessToken,
    ...(token.flow ? { authMode: token.flow } : {}),
    ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
    ...(token.expiresAt ? { expiresAt: token.expiresAt } : {}),
    ...(token.scope ? { scope: token.scope } : {}),
  };
}

async function upsertGithubConnector(userId: string, orgId: string, token: GithubAccountToken): Promise<ConnectorConfigRecord> {
  const existing = (await memoryEngine.connectors.listConnectors(userId))
    .find((item) => item.orgId === orgId && item.source === "github");
  const credential = connectorCredential(token);
  const connector = existing
    ? await memoryEngine.connectors.updateConnector(existing.id, { credential, status: "connected", enabled: true, lastError: null })
    : await memoryEngine.connectors.createConnector(userId, {
      source: "github",
      name: "GitHub",
      orgId,
      visibility: "private",
      credential,
    });
  if (!connector) throw new Error("GitHub connector changed while authorization was being saved");
  await enqueueAgentJob(memoryEngine.store, "connector_sync", { connectorId: connector.id, userId }).catch(() => undefined);
  return connector;
}

interface OrgGithubConnection {
  connector: ConnectorConfigRecord | null;
  token: GithubAccountToken | null;
  probe: Awaited<ReturnType<typeof probeGithubConnection>>;
}

/** Resolve only the credential explicitly attached to the active organization.
 * A pre-connector account token is migrated once for backward compatibility, but
 * never copied into a second org merely because its status endpoint was read. */
async function getOrgGithubConnection(userId: string, orgId: string): Promise<OrgGithubConnection> {
  const githubConnectors = (await memoryEngine.connectors.listConnectors(userId))
    .filter((item) => item.source === "github");
  let connector = githubConnectors.find((item) => item.orgId === orgId) ?? null;
  const storedAccount = await readGithubAccountToken(memoryEngine.emailAuth, userId);
  const account = await getUserToken(userId, storedAccount);

  if (connector?.hasCredential) {
    const resolved = await memoryEngine.connectors.getResolvedConnector(connector.id);
    const credential = resolved?.credential;
    if (credential?.accessToken) {
      // When the account-token compatibility record rotated, keep the matching
      // org connector in step without exposing either credential to a client.
      const usesAccountRecord = !!storedAccount && credential.accessToken === storedAccount.accessToken;
      if (usesAccountRecord && account && account.accessToken !== credential.accessToken) {
        connector = await memoryEngine.connectors.updateConnector(connector.id, {
          credential: connectorCredential(account),
          status: "connected",
          lastError: null,
        }) ?? connector;
      }
      const token = usesAccountRecord && account ? account : {
        accessToken: credential.accessToken,
        login: "",
        scope: credential.scope ?? "",
        connectedAt: connector.updatedAt,
        ...(credential.refreshToken ? { refreshToken: credential.refreshToken } : {}),
        ...(credential.expiresAt ? { expiresAt: credential.expiresAt } : {}),
        flow: credential.authMode === "device" ? "device" as const : "web" as const,
      };
      return { connector, token, probe: await probeGithubConnection(token.accessToken) };
    }
  }

  // Upgrade only a truly legacy account: once any GitHub connector exists, a
  // missing connector in another org means "not connected" for that org.
  if (!connector && githubConnectors.length === 0 && account) {
    const probe = await probeGithubConnection(account.accessToken);
    if (probe.connected) connector = await upsertGithubConnector(userId, orgId, account);
    return { connector, token: account, probe };
  }
  return { connector, token: null, probe: { connected: false } };
}

// ---- GitHub REST helpers (fixed api.github.com host — no user-controlled base) ----
class GithubApiError extends Error {
  constructor(readonly status: number) { super(`GitHub ${status}`); }
}
async function ghGet(token: string, path: string): Promise<unknown> {
  const r = await fetch(`${GH_API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!r.ok) throw new GithubApiError(r.status);
  return r.json();
}
function mapRepo(x: { full_name?: string; html_url?: string; private?: boolean; default_branch?: string }): RepoRow {
  return { fullName: String(x.full_name ?? ""), url: String(x.html_url ?? ""), private: !!x.private, defaultBranch: String(x.default_branch ?? "main") };
}
/** Legacy OAuth-App token: every repo the user can touch. */
async function listReposViaUser(token: string): Promise<RepoRow[]> {
  const data = await ghGet(token, "/user/repos?per_page=100&sort=updated") as Array<Parameters<typeof mapRepo>[0]>;
  return (Array.isArray(data) ? data : []).map(mapRepo).filter((x) => x.fullName);
}
/** GitHub App user token: only repos in the user's App installations. */
async function listReposViaInstallations(token: string): Promise<RepoRow[]> {
  const inst = await ghGet(token, "/user/installations?per_page=100") as { installations?: Array<{ id?: number }> };
  const ids = (inst.installations ?? []).map((i) => i.id).filter((n): n is number => typeof n === "number");
  const out = new Map<string, RepoRow>();
  for (const id of ids) {
    for (let page = 1; page <= 10; page++) { // cap: 10 pages × 100 = 1000 repos/installation
      const rd = await ghGet(token, `/user/installations/${id}/repositories?per_page=100&page=${page}`) as { repositories?: Array<Parameters<typeof mapRepo>[0]> };
      const rows = (rd.repositories ?? []).map(mapRepo).filter((x) => x.fullName);
      for (const row of rows) out.set(row.fullName, row);
      if ((rd.repositories?.length ?? 0) < 100) break;
    }
  }
  return [...out.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
}

export const githubConnectorRouter = Router();

// ---- Device flow (RFC 8628) — browser/native fallback. No client secret: a
// GitHub App device flow is a public-client flow; the App's permissions govern access. ----
githubConnectorRouter.post("/github/device/start", requireAnyAuth, requirePermission("connectors:manage"), async (req: AuthedRequest, res) => {
  const app = getDeviceApp();
  if (!app?.clientId) { sendError(res, 400, "GitHub sign-in is not configured on this server yet."); return; }
  try {
    const body = app.isGithubApp ? { client_id: app.clientId } : { client_id: app.clientId, scope: LEGACY_SCOPE };
    const r = await fetch(`${GH}/login/device/code`, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json() as { device_code?: string; user_code?: string; verification_uri?: string; interval?: number; expires_in?: number; error?: string };
    if (!d.device_code || !d.user_code) { sendError(res, 400, d.error || "GitHub returned no device code — is Device Flow enabled on the App?"); return; }
    await memoryEngine.emailAuth.setSetting(deviceKey(req.userId!), { deviceCode: d.device_code, orgId: req.orgId!, exp: Math.floor(Date.now() / 1000) + (d.expires_in ?? 900) });
    res.json({ userCode: d.user_code, verificationUri: d.verification_uri ?? "https://github.com/login/device", interval: d.interval ?? 5, expiresIn: d.expires_in ?? 900 });
  } catch (e) { console.error("[github] device start failed:", e); sendError(res, 500, "Could not start the GitHub device flow."); }
});

githubConnectorRouter.post("/github/device/cancel", requireAnyAuth, requirePermission("connectors:manage"), async (req: AuthedRequest, res) => {
  const pending = await memoryEngine.emailAuth.getSetting<{ orgId?: string }>(deviceKey(req.userId!));
  if (pending?.orgId === req.orgId) await memoryEngine.emailAuth.setSetting(deviceKey(req.userId!), {});
  res.json({ ok: true });
});

githubConnectorRouter.post("/github/device/poll", requireAnyAuth, requirePermission("connectors:manage"), async (req: AuthedRequest, res) => {
  const app = getDeviceApp();
  const dev = await memoryEngine.emailAuth.getSetting<{ deviceCode?: string; orgId?: string; exp?: number }>(deviceKey(req.userId!));
  if (!app?.clientId || !dev?.deviceCode || dev.orgId !== req.orgId) { res.json({ status: "error", error: "no pending device authorization" }); return; }
  if ((dev.exp ?? 0) < Math.floor(Date.now() / 1000)) { res.json({ status: "expired" }); return; }
  try {
    const r = await fetch(`${GH}/login/oauth/access_token`, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: app.clientId, device_code: dev.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
    });
    const d = await r.json() as { access_token?: string; scope?: string; expires_in?: number; refresh_token?: string; refresh_token_expires_in?: number; error?: string };
    if (d.error === "authorization_pending" || d.error === "slow_down") { res.json({ status: "pending" }); return; }
    if (!d.access_token) { res.json({ status: "error", error: d.error || "no token" }); return; }
    const ur = await fetch(`${GH_API}/user`, { headers: { Authorization: `Bearer ${d.access_token}`, Accept: "application/vnd.github+json" } });
    const login = (ur.ok ? ((await ur.json()) as { login?: string }).login : "") || "";
    const connectedAt = new Date().toISOString();
    const stored = githubAccountTokenFromResponse(d, { login, scope: d.scope ?? "", connectedAt, flow: "device" });
    if (!stored) { res.json({ status: "error", error: "GitHub returned no usable access token." }); return; }
    await memoryEngine.emailAuth.setSetting(tokenKey(req.userId!), { sealed: seal(JSON.stringify(stored)) });
    await upsertGithubConnector(req.userId!, req.orgId!, stored);
    await memoryEngine.emailAuth.setSetting(deviceKey(req.userId!), {});
    res.json({ status: "connected", login });
  } catch (e) { console.error("[github] device poll failed:", e); res.json({ status: "error", error: "Could not complete the GitHub sign-in." }); }
});

githubConnectorRouter.get("/github/status", requireAnyAuth, requirePermission("connectors:manage"), async (req: AuthedRequest, res) => {
  const app = await getPreferredApp();
  const { token: tok, probe, connector } = await getOrgGithubConnection(req.userId!, req.orgId!);
  res.json({
    source: "github",
    appConfigured: !!app?.clientId,
    ...probe,
    login: probe.login ?? (probe.connected ? tok?.login ?? null : null),
    account: probe.login ?? (probe.connected ? tok?.login ?? null : null),
    scopes: probe.connected ? tok?.scope ?? null : null,
    connector,
    installUrl: tok?.flow === "device" || (!tok && app?.isGithubApp) ? installUrl(getDeviceApp()) : null,
    authMode: tok?.flow ?? (app?.isGithubApp ? "device" : "web"),
  });
});

githubConnectorRouter.get("/github/repos", requireAnyAuth, requirePermission("connectors:manage"), async (req: AuthedRequest, res) => {
  const app = await getPreferredApp();
  const { token: tok, probe } = await getOrgGithubConnection(req.userId!, req.orgId!);
  if (!tok) { res.json({ connected: false, repos: [], installUrl: installUrl(app) }); return; }
  if (!probe.connected) {
    res.json({ connected: false, repos: [], installUrl: tok.flow === "device" ? installUrl(getDeviceApp()) : null, error: probe.error });
    return;
  }
  try {
    const repos = githubRepositoryAccessMode(tok) === "installations" ? await listReposViaInstallations(tok.accessToken) : await listReposViaUser(tok.accessToken);
    res.json({ connected: true, repos, installUrl: tok.flow === "device" ? installUrl(getDeviceApp()) : null });
  } catch (e) {
    console.error("[github] repo list failed:", e);
    const expired = e instanceof GithubApiError && e.status === 401;
    res.json({
      connected: !expired,
      repos: [],
      installUrl: tok.flow === "device" ? installUrl(getDeviceApp()) : null,
      error: expired ? "GitHub authorization expired or was revoked. Reconnect GitHub." : "Could not list repositories.",
    });
  }
});

githubConnectorRouter.post("/github/disconnect", requireAnyAuth, requirePermission("connectors:manage"), async (req: AuthedRequest, res) => {
  await memoryEngine.emailAuth.setSetting(tokenKey(req.userId!), {});
  const connector = (await memoryEngine.connectors.listConnectors(req.userId!))
    .find((item) => item.orgId === req.orgId && item.source === "github");
  const updated = connector ? await memoryEngine.connectors.updateConnector(connector.id, {
    credential: null,
    status: "disconnected",
    enabled: false,
    lastError: null,
  }) : null;
  res.json({ ok: true, connector: updated });
});

// ---- Track sync proxy — Track runs on the desktop, but the GitHub token is sealed
// server-side, so Track's GitHub REST calls are proxied here through the user's token.
// NOT an open proxy: the path is constrained to /repos/{owner}/{repo}/{issues|
// collaborators}, the query to a tiny allowlist, method to GET/POST/PATCH, and the host
// is always api.github.com — so an attacker can't turn this into an SSRF primitive. ----
const TRACK_PROXY_PATH = /^\/repos\/[^/]+\/[^/]+\/(issues|issues\/\d+|issues\/\d+\/comments|collaborators)$/;
const TRACK_QUERY_KEYS = new Set(["per_page", "page", "state"]);
function sanitizeTrackQuery(query: string): string {
  if (!query) return "";
  const params = new URLSearchParams(query.replace(/^\?/, ""));
  const out = new URLSearchParams();
  for (const [k, v] of params) if (TRACK_QUERY_KEYS.has(k)) out.set(k, v);
  const s = out.toString();
  return s ? `?${s}` : "";
}
githubConnectorRouter.post("/github/track/proxy", requireAnyAuth, requirePermission("connectors:manage"), async (req: AuthedRequest, res) => {
  const { token: tok, probe } = await getOrgGithubConnection(req.userId!, req.orgId!);
  if (!tok) { res.json({ ok: false, status: 401, error: "GitHub is not connected." }); return; }
  if (!probe.connected) { res.json({ ok: false, status: 401, error: probe.error ?? "GitHub authorization expired or was revoked." }); return; }
  const method = String(req.body?.method ?? "GET").toUpperCase();
  const [pathname, ...rest] = String(req.body?.path ?? "").split("?");
  if (!["GET", "POST", "PATCH"].includes(method)) { res.json({ ok: false, status: 405, error: "method not allowed" }); return; }
  if (!TRACK_PROXY_PATH.test(pathname)) { res.json({ ok: false, status: 400, error: "path not allowed" }); return; }
  const url = `${GH_API}${pathname}${sanitizeTrackQuery(rest.join("?"))}`;
  try {
    const r = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${tok.accessToken}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify(req.body?.body ?? {}),
    });
    const text = await r.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    res.json({ ok: r.ok, status: r.status, data });
  } catch (e) { res.json({ ok: false, status: 502, error: e instanceof Error ? e.message : "proxy failed" }); }
});

/** Admin surface — the deployment-wide browser OAuth App credentials. */
export const githubConnectorAdminRouter = Router();
githubConnectorAdminRouter.get("/github/app", requireAnyAuth, async (req: AuthedRequest, res) => {
  if (!req.isAdmin) { sendError(res, 403, "This action requires a global admin."); return; }
  const app = await getDbApp();
  res.json({ configured: !!app?.clientId, clientId: app?.clientId ?? "", hasSecret: !!app?.clientSecretSealed, redirectBase: app?.redirectBase ?? "", secretStorageReady: isSecretBoxConfigured(), bundledAppActive: !!APP_CLIENT_ID });
});
githubConnectorAdminRouter.post("/github/app", requireAnyAuth, async (req: AuthedRequest, res) => {
  if (!req.isAdmin) { sendError(res, 403, "This action requires a global admin."); return; }
  const clientId = String(req.body?.clientId ?? "").trim();
  const clientSecret = String(req.body?.clientSecret ?? "").trim();
  const redirectBase = String(req.body?.redirectBase ?? "").trim();
  if (!clientId) { sendError(res, 400, "clientId is required"); return; }
  const existing = await getDbApp();
  if (!clientSecret && !existing?.clientSecretSealed) {
    sendError(res, 400, "clientSecret is required before users can connect with this OAuth App");
    return;
  }
  if (clientSecret && !isSecretBoxConfigured()) { sendError(res, 400, "BRAINROUTER_SECRET_KEY must be set before storing the client secret"); return; }
  const clientSecretSealed = clientSecret ? seal(clientSecret) : (existing?.clientSecretSealed ?? "");
  await memoryEngine.emailAuth.setSetting(APP_KEY, { clientId, clientSecretSealed, redirectBase });
  res.json({ ok: true, configured: true, hasSecret: !!clientSecretSealed });
});
