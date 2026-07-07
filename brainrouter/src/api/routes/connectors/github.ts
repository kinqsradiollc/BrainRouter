/**
 * ADR-016 — server-mediated GitHub OAuth broker (per-user). The BrainRouter backend
 * holds ONE GitHub OAuth App (client_id + sealed client_secret, admin-set). Each user
 * authorizes via the standard web flow — the BACKEND is the callback target (GitHub
 * allows http://localhost callbacks, so a self-hosted server needs no tunnel) — and we
 * store their access token sealed, per user. The desktop just opens the start URL in
 * the system browser and polls status; the client_secret never leaves the server.
 *
 * Routes (mounted at /api/connectors):
 *   GET  /github/oauth/start     (authed) → { url } to open in a browser
 *   GET  /github/oauth/callback  (public; auth via signed state) → GitHub redirect target
 *   GET  /github/status          (authed) → { appConfigured, connected, login }
 *   POST /github/disconnect      (authed)
 *   GET  /github/repos           (authed) → the user's repos via their token
 * Admin (mounted at /api/admin/connectors):
 *   GET/POST /github/app         (global admin) → the deployment's OAuth App creds
 */
import { Router } from "express";
import crypto from "node:crypto";
import { memoryEngine } from "../../../memory/engine.js";
import { requireAnyAuth, JWT_SECRET, type AuthedRequest } from "../../middleware/auth.js";
import { sendError } from "../../../contracts/http.js";
import { seal, open, isSecretBoxConfigured } from "../../../security/secretBox.js";

const APP_KEY = "connectorOAuthApp:github";
const tokenKey = (userId: string) => `connectorToken:github:${userId}`;
const GH = "https://github.com";
const GH_API = "https://api.github.com";
const SCOPE = "repo read:org";

interface OAuthApp { clientId: string; clientSecretSealed: string; redirectBase?: string }
interface UserToken { accessToken: string; login: string; scope: string; connectedAt: string }

async function getApp(): Promise<OAuthApp | null> {
  return (await memoryEngine.emailAuth.getSetting<OAuthApp>(APP_KEY)) ?? null;
}
async function getUserToken(userId: string): Promise<UserToken | null> {
  const rec = await memoryEngine.emailAuth.getSetting<{ sealed?: string }>(tokenKey(userId));
  if (!rec?.sealed) return null;
  try { return JSON.parse(open(rec.sealed)) as UserToken; } catch { return null; }
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
function redirectUri(app: OAuthApp | null, req: AuthedRequest): string {
  const base = (app?.redirectBase || `${req.protocol}://${req.get("host") ?? "localhost:3747"}`).replace(/\/+$/, "");
  return `${base}/api/connectors/github/oauth/callback`;
}
function resultPage(title: string, msg: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;background:#0d0f13;color:#e6e6e6;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center;max-width:440px;padding:24px"><h2>${title}</h2><p style="opacity:.85">${msg}</p><p style="opacity:.55;font-size:13px;margin-top:18px">You can close this tab and return to BrainRouter.</p></div>`;
}

export const githubConnectorRouter = Router();

githubConnectorRouter.get("/github/oauth/start", requireAnyAuth, async (req: AuthedRequest, res) => {
  const app = await getApp();
  if (!app?.clientId) { sendError(res, 400, "GitHub OAuth is not configured on this server yet."); return; }
  const url = `${GH}/login/oauth/authorize?client_id=${encodeURIComponent(app.clientId)}`
    + `&redirect_uri=${encodeURIComponent(redirectUri(app, req))}`
    + `&scope=${encodeURIComponent(SCOPE)}&state=${encodeURIComponent(signState(req.userId!))}&allow_signup=false`;
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
    const stored: UserToken = { accessToken: td.access_token, login, scope: td.scope ?? SCOPE, connectedAt: new Date().toISOString() };
    await memoryEngine.emailAuth.setSetting(tokenKey(userId), { sealed: seal(JSON.stringify(stored)) });
    res.send(resultPage("GitHub connected ✓", `Signed in as <b>${login || "your account"}</b>. BrainRouter can now read your repositories.`));
  } catch {
    res.status(500).send(resultPage("Connection failed", "Could not complete the exchange with GitHub."));
  }
});

githubConnectorRouter.get("/github/status", requireAnyAuth, async (req: AuthedRequest, res) => {
  const app = await getApp();
  const tok = await getUserToken(req.userId!);
  res.json({ appConfigured: !!app?.clientId, connected: !!tok, login: tok?.login ?? null, scope: tok?.scope ?? null });
});

githubConnectorRouter.post("/github/disconnect", requireAnyAuth, async (req: AuthedRequest, res) => {
  await memoryEngine.emailAuth.setSetting(tokenKey(req.userId!), {});
  res.json({ ok: true });
});

// ---- Device flow (RFC 8628) — no client secret needed (public client). The user
// gets a short code to enter at github.com/login/device; we poll for the token. ----
const deviceKey = (userId: string) => `connectorDevice:github:${userId}`;

githubConnectorRouter.post("/github/device/start", requireAnyAuth, async (req: AuthedRequest, res) => {
  const app = await getApp();
  if (!app?.clientId) { sendError(res, 400, "GitHub OAuth is not configured on this server yet."); return; }
  try {
    const r = await fetch(`${GH}/login/device/code`, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: app.clientId, scope: SCOPE }),
    });
    const d = await r.json() as { device_code?: string; user_code?: string; verification_uri?: string; interval?: number; expires_in?: number; error?: string };
    if (!d.device_code || !d.user_code) { sendError(res, 400, d.error || "GitHub returned no device code — is Device Flow enabled on the OAuth App?"); return; }
    await memoryEngine.emailAuth.setSetting(deviceKey(req.userId!), { deviceCode: d.device_code, exp: Math.floor(Date.now() / 1000) + (d.expires_in ?? 900) });
    res.json({ userCode: d.user_code, verificationUri: d.verification_uri ?? "https://github.com/login/device", interval: d.interval ?? 5 });
  } catch (e) { sendError(res, 500, e instanceof Error ? e.message : "device start failed"); }
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
    await memoryEngine.emailAuth.setSetting(tokenKey(req.userId!), { sealed: seal(JSON.stringify({ accessToken: d.access_token, login, scope: d.scope ?? SCOPE, connectedAt: new Date().toISOString() })) });
    await memoryEngine.emailAuth.setSetting(deviceKey(req.userId!), {});
    res.json({ status: "connected", login });
  } catch (e) { res.json({ status: "error", error: e instanceof Error ? e.message : "poll failed" }); }
});

githubConnectorRouter.get("/github/repos", requireAnyAuth, async (req: AuthedRequest, res) => {
  const tok = await getUserToken(req.userId!);
  if (!tok) { res.json({ connected: false, repos: [] }); return; }
  try {
    const r = await fetch(`${GH_API}/user/repos?per_page=100&sort=updated`, {
      headers: { Authorization: `Bearer ${tok.accessToken}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (!r.ok) { res.json({ connected: true, repos: [], error: `GitHub ${r.status}` }); return; }
    const data = (await r.json()) as Array<{ full_name?: string; html_url?: string; private?: boolean; default_branch?: string }>;
    const repos = (Array.isArray(data) ? data : [])
      .map((x) => ({ fullName: String(x.full_name ?? ""), url: String(x.html_url ?? ""), private: !!x.private, defaultBranch: String(x.default_branch ?? "main") }))
      .filter((x) => x.fullName);
    res.json({ connected: true, repos });
  } catch (e) {
    res.json({ connected: true, repos: [], error: e instanceof Error ? e.message : "failed" });
  }
});

/** Admin surface — the deployment's single GitHub OAuth App credentials. */
export const githubConnectorAdminRouter = Router();
githubConnectorAdminRouter.get("/github/app", requireAnyAuth, async (req: AuthedRequest, res) => {
  if (!req.isAdmin) { sendError(res, 403, "This action requires a global admin."); return; }
  const app = await getApp();
  res.json({ configured: !!app?.clientId, clientId: app?.clientId ?? "", hasSecret: !!app?.clientSecretSealed, redirectBase: app?.redirectBase ?? "", secretStorageReady: isSecretBoxConfigured() });
});
githubConnectorAdminRouter.post("/github/app", requireAnyAuth, async (req: AuthedRequest, res) => {
  if (!req.isAdmin) { sendError(res, 403, "This action requires a global admin."); return; }
  const clientId = String(req.body?.clientId ?? "").trim();
  const clientSecret = String(req.body?.clientSecret ?? "").trim();
  const redirectBase = String(req.body?.redirectBase ?? "").trim();
  if (!clientId) { sendError(res, 400, "clientId is required"); return; }
  if (clientSecret && !isSecretBoxConfigured()) { sendError(res, 400, "BRAINROUTER_SECRET_KEY must be set before storing the client secret"); return; }
  const existing = await getApp();
  const clientSecretSealed = clientSecret ? seal(clientSecret) : (existing?.clientSecretSealed ?? "");
  await memoryEngine.emailAuth.setSetting(APP_KEY, { clientId, clientSecretSealed, redirectBase });
  res.json({ ok: true, configured: true, hasSecret: !!clientSecretSealed });
});
