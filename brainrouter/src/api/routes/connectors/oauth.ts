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

const stateSecret = (): string => (process.env.BRAINROUTER_SECRET_KEY ?? "brainrouter-dev-oauth-state").trim();
const nowSec = (): number => Math.floor(Date.now() / 1000);

function baseUrlOf(req: AuthedRequest): string {
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() || req.protocol || "http";
  const host = req.headers.host ?? "localhost:3747";
  return `${proto}://${host}`;
}
const redirectUri = (req: AuthedRequest, source: string): string => `${baseUrlOf(req)}/api/connectors/${source}/oauth/callback`;

async function resolveOrgId(req: AuthedRequest): Promise<string | undefined> {
  const requested = (req.headers["x-brainrouter-org"] as string | undefined)?.trim() || undefined;
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
  const requested = (req.headers["x-brainrouter-org"] as string | undefined)?.trim() || undefined;
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

/** GET /api/connectors/:source/oauth/start — build the authorize URL + redirect. */
connectorOauthRouter.get("/:source/oauth/start", requireJwt, async (req: AuthedRequest, res) => {
  const source = String(req.params.source);
  if (!isOAuthSource(source)) { res.status(400).json({ error: `No OAuth broker for source "${source}"` }); return; }
  const orgId = await resolveOrgId(req);
  if (!orgId) { res.status(400).json({ error: "No active org" }); return; }
  const app = await memoryEngine.connectors.getResolvedOAuthApp(orgId, source);
  if (!app?.clientId) { res.status(409).json({ error: `OAuth for "${source}" isn't configured for this org — an admin must set its client id/secret first.` }); return; }
  const provider = OAUTH_PROVIDERS[source];
  const pkce = provider.usesPkce ? makePkce() : undefined;
  const state = signState({
    userId: req.userId!, orgId, source,
    connectorId: (String(req.query.connectorId ?? "").trim() || undefined),
    verifier: pkce?.verifier, iat: nowSec(),
  }, stateSecret());
  const scopes = app.scopes ? app.scopes.split(/\s+/).filter(Boolean) : provider.scopes;
  res.redirect(buildAuthorizeUrl(source, app.clientId, redirectUri(req, source), state, scopes, pkce?.challenge));
});

/** GET /api/connectors/:source/oauth/callback — validate state, exchange, store. */
connectorOauthRouter.get("/:source/oauth/callback", async (req: AuthedRequest, res) => {
  const source = String(req.params.source);
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
