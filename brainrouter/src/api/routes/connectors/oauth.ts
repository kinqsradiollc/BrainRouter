/**
 * ADR-016 C2 — server-side OAuth broker routes. The desktop/dashboard open
 * `/start` in the system browser; the provider redirects back to `/callback` HERE
 * (localhost callbacks are allowed), the backend exchanges the code with the org's
 * sealed client secret, and stores the per-user token sealed. No client secret
 * ever reaches a client. Mounted at /api/connectors.
 */
import { Router } from "express";
import { requireJwt, type AuthedRequest } from "../../middleware/auth.js";
import { memoryEngine } from "../../../memory/engine.js";
import { resolveOrgContext } from "../../../tenancy/context.js";
import { can } from "../../../tenancy/rbac.js";
import {
  OAUTH_PROVIDERS, isOAuthSource, makePkce, signState, verifyState,
  buildAuthorizeUrl, exchangeCode,
} from "../../../connectors/oauthBroker.js";
import type { ConnectorTokenSecret } from "../../../connectors/store.js";

export const connectorOauthRouter = Router();

// The OAuth `state` is HMAC-signed with this secret; a KNOWN fallback would let an
// attacker forge a state (any userId/connectorId) and defeat the ownership check
// below. Require a real secret in production; only fall back for local dev.
const stateSecret = (): string => {
  const s = process.env.BRAINROUTER_SECRET_KEY?.trim();
  if (s) return s;
  if (process.env.NODE_ENV === "production") throw new Error("BRAINROUTER_SECRET_KEY is required to sign OAuth state");
  return "brainrouter-dev-oauth-state";
};
const nowSec = (): number => Math.floor(Date.now() / 1000);

function baseUrlOf(req: AuthedRequest): string {
  // The OAuth redirect_uri must not be built from an untrusted Host header — a
  // spoofed Host would send the authorization code to an attacker (CWE-20). Prefer
  // the configured public URL; otherwise fall back to a FORMAT-validated Host (dev
  // localhost), never a raw one.
  const publicUrl = process.env.BRAINROUTER_PUBLIC_URL?.trim();
  if (publicUrl) return publicUrl.replace(/\/+$/, "");
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() || req.protocol || "http";
  const rawHost = req.headers.host ?? "";
  const host = /^[a-z0-9.-]+(:\d+)?$/i.test(rawHost) ? rawHost : "localhost:3747";
  return `${proto}://${host}`;
}
const redirectUri = (req: AuthedRequest, source: string): string => `${baseUrlOf(req)}/api/connectors/${source}/oauth/callback`;

async function resolveOrgId(req: AuthedRequest): Promise<string | undefined> {
  const orgHeader = req.headers["x-brainrouter-org"]; // string[] if the header repeats
  const requested = (Array.isArray(orgHeader) ? orgHeader[0] : orgHeader)?.trim() || undefined;
  const ctx = await resolveOrgContext(memoryEngine.tenancy, req.userId!, requested).catch(() => null);
  return ctx?.orgId;
}

/**
 * POST /api/connectors/:source/oauth/app — admin: set the org's OAuth *app*
 * client id/secret for a source (sealed). Required before users can connect.
 */
connectorOauthRouter.post("/:source/oauth/app", requireJwt, async (req: AuthedRequest, res) => {
  const source = String(req.params.source);
  if (!isOAuthSource(source)) { res.status(400).json({ error: `No OAuth broker for source "${source}"` }); return; }
  const orgHeader = req.headers["x-brainrouter-org"]; // string[] if the header repeats
  const requested = (Array.isArray(orgHeader) ? orgHeader[0] : orgHeader)?.trim() || undefined;
  const ctx = await resolveOrgContext(memoryEngine.tenancy, req.userId!, requested).catch(() => null);
  if (!ctx?.orgId) { res.status(400).json({ error: "No active org" }); return; }
  if (!req.isAdmin && !can(ctx.role, "triggers:manage")) { res.status(403).json({ error: "Requires the 'triggers:manage' capability" }); return; }
  const clientId = String(req.body?.clientId ?? "").trim();
  const clientSecret = req.body?.clientSecret ? String(req.body.clientSecret) : undefined;
  const scopes = String(req.body?.scopes ?? "").trim();
  if (!clientId) { res.status(400).json({ error: "clientId is required" }); return; }
  const app = await memoryEngine.connectors.upsertOAuthApp(ctx.orgId, source, clientId, clientSecret, scopes);
  res.json({ app });
});

/**
 * GET /api/connectors/oauth/apps — the org's per-source OAuth-app config STATUS for the
 * dashboard Integrations screen (mirrors the GitHub OAuth App card, per connector). Returns
 * NO secrets — only whether each source is configured + the (public) client id + scopes.
 */
connectorOauthRouter.get("/oauth/apps", requireJwt, async (req: AuthedRequest, res) => {
  const orgHeader = req.headers["x-brainrouter-org"]; // string[] if the header repeats
  const requested = (Array.isArray(orgHeader) ? orgHeader[0] : orgHeader)?.trim() || undefined;
  const ctx = await resolveOrgContext(memoryEngine.tenancy, req.userId!, requested).catch(() => null);
  if (!ctx?.orgId) { res.status(400).json({ error: "No active org" }); return; }
  if (!req.isAdmin && !can(ctx.role, "triggers:manage")) { res.status(403).json({ error: "Requires the 'triggers:manage' capability" }); return; }
  const orgId = ctx.orgId;
  const apps = await Promise.all(Object.entries(OAUTH_PROVIDERS).map(async ([source, provider]) => {
    const app = await memoryEngine.connectors.getResolvedOAuthApp(orgId, source).catch(() => null);
    return {
      source,
      configured: !!app?.clientId,
      hasSecret: !!app?.clientSecret, // boolean only — the secret itself never leaves the server
      clientId: app?.clientId ?? "",  // client id is public in OAuth, safe to return
      scopes: app?.scopes ?? "",
      defaultScopes: provider.scopes.join(" "),
      usesPkce: !!provider.usesPkce,
    };
  }));
  res.json({ apps });
});

/** GET /api/connectors/:source/oauth/start — build the authorize URL + redirect. */
connectorOauthRouter.get("/:source/oauth/start", requireJwt, async (req: AuthedRequest, res) => {
  const source = String(req.params.source);
  if (!isOAuthSource(source)) { res.status(400).json({ error: `No OAuth broker for source "${source}"` }); return; }
  const orgId = await resolveOrgId(req);
  if (!orgId) { res.status(400).json({ error: "No active org" }); return; }
  const app = await memoryEngine.connectors.getResolvedOAuthApp(orgId, source);
  if (!app?.clientId) { res.status(409).json({ error: `OAuth for "${source}" isn't configured for this org — an admin must set its client id/secret first.` }); return; }
  // Re-connecting an existing connector? Verify the caller OWNS it before we bind
  // its id into the signed state — otherwise an attacker could enumerate ids and
  // overwrite someone else's connector credentials on callback (IDOR, CWE-639).
  const connectorId = String(req.query.connectorId ?? "").trim() || undefined;
  if (connectorId) {
    const conn = await memoryEngine.connectors.getConnector(connectorId);
    if (!conn || conn.userId !== req.userId) { res.status(403).json({ error: "Connector not found or access denied." }); return; }
  }
  const provider = OAUTH_PROVIDERS[source];
  const pkce = provider.usesPkce ? makePkce() : undefined;
  const state = signState({
    userId: req.userId!, orgId, source,
    connectorId,
    verifier: pkce?.verifier, iat: nowSec(),
  }, stateSecret());
  const scopes = app.scopes ? app.scopes.split(/\s+/).filter(Boolean) : provider.scopes;
  res.redirect(buildAuthorizeUrl(source, app.clientId, redirectUri(req, source), state, scopes, pkce?.challenge));
});

/** GET /api/connectors/:source/oauth/callback — validate state, exchange, store. */
connectorOauthRouter.get("/:source/oauth/callback", async (req: AuthedRequest, res) => {
  const source = String(req.params.source);
  // Reject unknown sources up front so `source` (reflected in the success HTML
  // below) is always a known, safe token — no reflected XSS.
  if (!isOAuthSource(source)) { res.status(400).send("Unknown OAuth source."); return; }
  const code = String(req.query.code ?? "");
  const state = verifyState(String(req.query.state ?? ""), stateSecret(), 600, nowSec());
  if (!state || state.source !== source || !code || !state.orgId) { res.status(400).send("Invalid or expired OAuth state — restart the connection."); return; }
  const app = await memoryEngine.connectors.getResolvedOAuthApp(state.orgId, source);
  if (!app) { res.status(409).send("OAuth app not configured."); return; }
  let credential: ConnectorTokenSecret;
  try {
    const token = await exchangeCode(source, { clientId: app.clientId, clientSecret: app.clientSecret, code, redirectUri: redirectUri(req, source), codeVerifier: state.verifier }, { fetchImpl: fetch });
    credential = { accessToken: token.accessToken, refreshToken: token.refreshToken, expiresAt: token.expiresAt, scope: token.scope };
  } catch (e) { res.status(502).send(`OAuth exchange failed: ${e instanceof Error ? e.message : "unknown error"}`); return; }
  if (state.connectorId) {
    await memoryEngine.connectors.updateConnector(state.connectorId, { credential, status: "connected", lastError: null });
  } else {
    await memoryEngine.connectors.createConnector(state.userId, { source, name: source, orgId: state.orgId, credential });
  }
  res.set("Content-Type", "text/html").send(
    `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:2rem;background:#0b0b0f;color:#e6e6ea">` +
    `<h3>Connected ${source} ✓</h3><p>You can close this window and return to BrainRouter.</p></body>`,
  );
});
