/**
 * ADR-016 — server-mediated GitHub connect (per-user), unified onto ONE GitHub App.
 *
 * The BrainRouter backend brokers GitHub sign-in for every user. The deployment's
 * GitHub App is identified by a SINGLE env var — `BRAINROUTER_GITHUB_APP_CLIENT_ID`
 * (plus `BRAINROUTER_GITHUB_APP_SLUG` for the "install on more repos" link). A user
 * signs in with the **device flow** (like `claude auth login`): they get a short code
 * to enter at github.com/login/device and we poll for a user-to-server token, which we
 * store SEALED, per user. No client secret is involved — a GitHub App device flow is a
 * public-client flow and the App's permissions (not OAuth scopes) govern access.
 *
 * Repos are listed through the user's App *installations* (`/user/installations` →
 * `/user/installations/{id}/repositories`), so we only ever see repos where the user
 * actually installed the App — the same model as the dashboard's /integrations/github.
 *
 * A legacy DB-configured OAuth App (admin-set client_id + sealed secret) is still
 * honored as a fallback when no env App is set — that path keeps the classic web
 * redirect + `/user/repos`. The env GitHub App always wins when present.
 *
 * Routes (mounted at /api/connectors):
 *   POST /github/device/start    (authed) → { userCode, verificationUri, interval }
 *   POST /github/device/poll     (authed) → { status: pending|connected|expired|error, login? }
 *   GET  /github/status          (authed) → { appConfigured, connected, login, installUrl }
 *   GET  /github/repos           (authed) → { connected, repos[], installUrl }
 *   POST /github/disconnect      (authed)
 *   GET  /github/oauth/start     (authed) → { url }   (legacy DB OAuth App only)
 *   GET  /github/oauth/callback  (public; auth via signed state)  (legacy)
 * Admin (mounted at /api/admin/connectors):
 *   GET/POST /github/app         (global admin) → the legacy DB OAuth App creds
 */
import { Router } from "express";
import crypto from "node:crypto";
import { memoryEngine } from "../../../memory/engine.js";
import { requireAnyAuth, JWT_SECRET, type AuthedRequest } from "../../middleware/auth.js";
import { sendError } from "../../../contracts/http.js";
import { seal, open, isSecretBoxConfigured } from "../../../security/secretBox.js";
import { probeGithubConnection } from "./githubConnection.js";

const APP_KEY = "connectorOAuthApp:github";
const tokenKey = (userId: string) => `connectorToken:github:${userId}`;
const deviceKey = (userId: string) => `connectorDevice:github:${userId}`;
const GH = "https://github.com";
const GH_API = "https://api.github.com";
/** Only sent for the legacy OAuth-App path — a GitHub App device flow ignores scopes. */
const LEGACY_SCOPE = "repo read:org";

interface OAuthApp { clientId: string; clientSecretSealed: string; redirectBase?: string }
/** Unified view the routes use: env GitHub App (device flow) or legacy DB OAuth App. */
interface AppConfig { clientId: string; slug: string; isGithubApp: boolean; clientSecretSealed?: string; redirectBase?: string }
interface UserToken { accessToken: string; login: string; scope: string; connectedAt: string }
interface RepoRow { fullName: string; url: string; private: boolean; defaultBranch: string }

// The BrainRouter GitHub App is bundled by default — a GitHub App's client_id and
// slug are PUBLIC (not secrets), so shipping them means GitHub connect works with zero
// config, the same way `gh`/`claude` bundle their own client_id. A self-hosted
// deployment can point at its own App with one env var each (the "single .env" knob).
const DEFAULT_APP_CLIENT_ID = "Iv23ligghGTjBPtQEkiq";
const DEFAULT_APP_SLUG = "brainrouter-memory-kinqsradiollc";
const APP_CLIENT_ID = process.env.BRAINROUTER_GITHUB_APP_CLIENT_ID?.trim() || DEFAULT_APP_CLIENT_ID;
const APP_SLUG = process.env.BRAINROUTER_GITHUB_APP_SLUG?.trim() || DEFAULT_APP_SLUG;

async function getDbApp(): Promise<OAuthApp | null> {
  return (await memoryEngine.emailAuth.getSetting<OAuthApp>(APP_KEY)) ?? null;
}
/** The GitHub App (bundled/env, device flow, no secret) wins; else a legacy DB OAuth App. */
async function getApp(): Promise<AppConfig | null> {
  if (APP_CLIENT_ID) return { clientId: APP_CLIENT_ID, slug: APP_SLUG, isGithubApp: true };
  const db = await getDbApp();
  if (db?.clientId) return { clientId: db.clientId, slug: "", isGithubApp: false, clientSecretSealed: db.clientSecretSealed, redirectBase: db.redirectBase };
  return null;
}
/** Public install page for the App (so the user can grant more repos). */
function installUrl(app: AppConfig | null): string | null {
  return app?.isGithubApp && app.slug ? `${GH}/apps/${app.slug}/installations/new` : null;
}
async function getUserToken(userId: string): Promise<UserToken | null> {
  const rec = await memoryEngine.emailAuth.getSetting<{ sealed?: string }>(tokenKey(userId));
  if (!rec?.sealed) return null;
  try { return JSON.parse(open(rec.sealed)) as UserToken; } catch { return null; }
}

// ---- GitHub REST helpers (fixed api.github.com host — no user-controlled base) ----
async function ghGet(token: string, path: string): Promise<unknown> {
  const r = await fetch(`${GH_API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
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

/** Stateless HMAC-signed state binding the initiating user (10-min TTL). */
function signState(userId: string): string {
  const payload = Buffer.from(JSON.stringify({ u: userId, n: crypto.randomBytes(8).toString("hex"), e: Math.floor(Date.now() / 1000) + 600 })).toString("base64url");
  const mac = crypto.createHmac("sha256", JWT_SECRET).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}
function verifyState(state: string): string | null {
  const [payload, mac] = String(state).split(".");
  if (!payload || !mac) return null;
  const expect = crypto.createHmac("sha256", JWT_SECRET).update(payload).digest("base64url");
  const a = Buffer.from(mac), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, "base64url").toString()) as { u?: string; e?: number };
    if (typeof p.e !== "number" || p.e < Math.floor(Date.now() / 1000)) return null;
    return typeof p.u === "string" ? p.u : null;
  } catch { return null; }
}
function redirectUri(app: AppConfig | null, req: AuthedRequest): string {
  const base = (app?.redirectBase || `${req.protocol}://${req.get("host") ?? "localhost:3747"}`).replace(/\/+$/, "");
  return `${base}/api/connectors/github/oauth/callback`;
}
function escHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => (({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c));
}
// title/msg may carry a provider-derived value (a GitHub login, an error text) —
// escape both so this HTML response can never reflect markup.
function resultPage(title: string, msg: string): string {
  const t = escHtml(title), m = escHtml(msg);
  return `<!doctype html><meta charset="utf-8"><title>${t}</title><body style="font-family:system-ui;background:#0d0f13;color:#e6e6e6;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center;max-width:440px;padding:24px"><h2>${t}</h2><p style="opacity:.85">${m}</p><p style="opacity:.55;font-size:13px;margin-top:18px">You can close this tab and return to BrainRouter.</p></div>`;
}

export const githubConnectorRouter = Router();

// ---- Device flow (RFC 8628) — the primary path. No client secret: a GitHub App
// device flow is a public-client flow; the App's permissions govern access. ----
githubConnectorRouter.post("/github/device/start", requireAnyAuth, async (req: AuthedRequest, res) => {
  const app = await getApp();
  if (!app?.clientId) { sendError(res, 400, "GitHub sign-in is not configured on this server yet."); return; }
  try {
    const body = app.isGithubApp ? { client_id: app.clientId } : { client_id: app.clientId, scope: LEGACY_SCOPE };
    const r = await fetch(`${GH}/login/device/code`, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json() as { device_code?: string; user_code?: string; verification_uri?: string; interval?: number; expires_in?: number; error?: string };
    if (!d.device_code || !d.user_code) { sendError(res, 400, d.error || "GitHub returned no device code — is Device Flow enabled on the App?"); return; }
    await memoryEngine.emailAuth.setSetting(deviceKey(req.userId!), { deviceCode: d.device_code, exp: Math.floor(Date.now() / 1000) + (d.expires_in ?? 900) });
    res.json({ userCode: d.user_code, verificationUri: d.verification_uri ?? "https://github.com/login/device", interval: d.interval ?? 5 });
  } catch (e) { console.error("[github] device start failed:", e); sendError(res, 500, "Could not start the GitHub device flow."); }
});

githubConnectorRouter.post("/github/device/poll", requireAnyAuth, async (req: AuthedRequest, res) => {
  const app = await getApp();
  const dev = await memoryEngine.emailAuth.getSetting<{ deviceCode?: string; exp?: number }>(deviceKey(req.userId!));
  if (!app?.clientId || !dev?.deviceCode) { res.json({ status: "error", error: "no pending device authorization" }); return; }
  if ((dev.exp ?? 0) < Math.floor(Date.now() / 1000)) { res.json({ status: "expired" }); return; }
  try {
    const r = await fetch(`${GH}/login/oauth/access_token`, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: app.clientId, device_code: dev.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
    });
    const d = await r.json() as { access_token?: string; scope?: string; error?: string };
    if (d.error === "authorization_pending" || d.error === "slow_down") { res.json({ status: "pending" }); return; }
    if (!d.access_token) { res.json({ status: "error", error: d.error || "no token" }); return; }
    const ur = await fetch(`${GH_API}/user`, { headers: { Authorization: `Bearer ${d.access_token}`, Accept: "application/vnd.github+json" } });
    const login = (ur.ok ? ((await ur.json()) as { login?: string }).login : "") || "";
    await memoryEngine.emailAuth.setSetting(tokenKey(req.userId!), { sealed: seal(JSON.stringify({ accessToken: d.access_token, login, scope: d.scope ?? "", connectedAt: new Date().toISOString() })) });
    await memoryEngine.emailAuth.setSetting(deviceKey(req.userId!), {});
    res.json({ status: "connected", login });
  } catch (e) { console.error("[github] device poll failed:", e); res.json({ status: "error", error: "Could not complete the GitHub sign-in." }); }
});

githubConnectorRouter.get("/github/status", requireAnyAuth, async (req: AuthedRequest, res) => {
  const app = await getApp();
  const tok = await getUserToken(req.userId!);
  const probe = tok ? await probeGithubConnection(tok.accessToken) : { connected: false };
  res.json({
    appConfigured: !!app?.clientId,
    ...probe,
    login: probe.login ?? (probe.connected ? tok?.login ?? null : null),
    scope: probe.connected ? tok?.scope ?? null : null,
    installUrl: installUrl(app),
  });
});

githubConnectorRouter.get("/github/repos", requireAnyAuth, async (req: AuthedRequest, res) => {
  const app = await getApp();
  const tok = await getUserToken(req.userId!);
  if (!tok) { res.json({ connected: false, repos: [], installUrl: installUrl(app) }); return; }
  try {
    const repos = app?.isGithubApp ? await listReposViaInstallations(tok.accessToken) : await listReposViaUser(tok.accessToken);
    res.json({ connected: true, repos, installUrl: installUrl(app) });
  } catch (e) {
    console.error("[github] repo list failed:", e);
    res.json({ connected: true, repos: [], installUrl: installUrl(app), error: "Could not list repositories." });
  }
});

githubConnectorRouter.post("/github/disconnect", requireAnyAuth, async (req: AuthedRequest, res) => {
  await memoryEngine.emailAuth.setSetting(tokenKey(req.userId!), {});
  res.json({ ok: true });
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
githubConnectorRouter.post("/github/track/proxy", requireAnyAuth, async (req: AuthedRequest, res) => {
  const tok = await getUserToken(req.userId!);
  if (!tok) { res.json({ ok: false, status: 401, error: "GitHub is not connected." }); return; }
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

// ---- Legacy web redirect flow — only for a DB-configured OAuth App (needs a secret).
// When an env GitHub App is set we sign in with device flow, so this path is disabled. ----
githubConnectorRouter.get("/github/oauth/start", requireAnyAuth, async (req: AuthedRequest, res) => {
  const app = await getApp();
  if (!app?.clientId) { sendError(res, 400, "GitHub OAuth is not configured on this server yet."); return; }
  if (app.isGithubApp) { sendError(res, 400, "This deployment signs in with GitHub via device flow — use /github/device/start."); return; }
  const url = `${GH}/login/oauth/authorize?client_id=${encodeURIComponent(app.clientId)}`
    + `&redirect_uri=${encodeURIComponent(redirectUri(app, req))}`
    + `&scope=${encodeURIComponent(LEGACY_SCOPE)}&state=${encodeURIComponent(signState(req.userId!))}&allow_signup=false`;
  res.json({ url });
});

// PUBLIC — GitHub redirects the user's browser here; the signed `state` is the auth.
githubConnectorRouter.get("/github/oauth/callback", async (req: AuthedRequest, res) => {
  const code = String(req.query.code ?? "");
  const userId = verifyState(String(req.query.state ?? ""));
  if (!userId || !code) { res.status(400).send(resultPage("Connection failed", "Invalid or expired authorization request.")); return; }
  const app = await getApp();
  if (!app?.clientId || !app.clientSecretSealed) { res.status(400).send(resultPage("Connection failed", "GitHub OAuth is not fully configured.")); return; }
  let clientSecret: string;
  try { clientSecret = open(app.clientSecretSealed); } catch { res.status(500).send(resultPage("Connection failed", "Server secret storage error.")); return; }
  try {
    const tr = await fetch(`${GH}/login/oauth/access_token`, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: app.clientId, client_secret: clientSecret, code, redirect_uri: redirectUri(app, req) }),
    });
    const td = await tr.json() as { access_token?: string; scope?: string; error_description?: string };
    if (!td.access_token) { res.status(400).send(resultPage("Connection failed", td.error_description || "GitHub did not return a token.")); return; }
    const ur = await fetch(`${GH_API}/user`, { headers: { Authorization: `Bearer ${td.access_token}`, Accept: "application/vnd.github+json" } });
    const login = (ur.ok ? ((await ur.json()) as { login?: string }).login : "") || "";
    const stored: UserToken = { accessToken: td.access_token, login, scope: td.scope ?? LEGACY_SCOPE, connectedAt: new Date().toISOString() };
    await memoryEngine.emailAuth.setSetting(tokenKey(userId), { sealed: seal(JSON.stringify(stored)) });
    res.send(resultPage("GitHub connected ✓", `Signed in as ${login || "your account"}. BrainRouter can now read your repositories.`));
  } catch {
    res.status(500).send(resultPage("Connection failed", "Could not complete the exchange with GitHub."));
  }
});

/** Admin surface — the legacy DB OAuth App credentials (fallback when no env App). */
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
  if (clientSecret && !isSecretBoxConfigured()) { sendError(res, 400, "BRAINROUTER_SECRET_KEY must be set before storing the client secret"); return; }
  const existing = await getDbApp();
  const clientSecretSealed = clientSecret ? seal(clientSecret) : (existing?.clientSecretSealed ?? "");
  await memoryEngine.emailAuth.setSetting(APP_KEY, { clientId, clientSecretSealed, redirectBase });
  res.json({ ok: true, configured: true, hasSecret: !!clientSecretSealed });
});
