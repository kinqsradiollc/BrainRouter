/**
 * ADR-016 C4 — connector management REST API (per-user, backend-hosted). This is
 * the surface the desktop repoints its ~40 file-local connector handlers to. CRUD
 * + "run now"; the OAuth credential arrives via the broker (oauth.ts), never here.
 * Mounted at /api/connectors alongside the OAuth broker.
 */
import { Router, type Response } from "express";
import { requireAnyAuth, type AuthedRequest } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/tenancy.js";
import { memoryEngine } from "../../../memory/engine.js";
import { runConnectorSync } from "../../../connectors/syncExecutor.js";
import { isOAuthSource } from "../../../connectors/oauthBroker.js";
import { CONNECTOR_RESOURCE_FIELDS, discoverConnectorAccount, discoverConnectorResources } from "../../../connectors/resources.js";
import { enqueueAgentJob } from "../../../memory/scheduler/jobs.js";
import { gitlabTrackProxyTarget } from "../../../connectors/gitlabTrackProxy.js";

export const connectorManageRouter = Router();
connectorManageRouter.use(requireAnyAuth);
// Connector accounts are per-user. Developers may connect and sync their own
// sources, while shared OAuth-app credentials remain behind triggers:manage.
connectorManageRouter.use(requirePermission("connectors:manage"));

function activeOrgId(req: AuthedRequest): string {
  // `requirePermission` immediately above resolves and attaches this value. Keep
  // every subsequent lookup pinned to that single request context instead of
  // resolving again (or silently degrading to an unscoped query on an error).
  if (!req.orgId) throw new Error("Connector route is missing its organization context");
  return req.orgId;
}

async function sourceConnector(req: AuthedRequest, res: Response, connectorId?: string) {
  const source = String(req.params.source ?? "").trim();
  if (!isOAuthSource(source)) { res.status(404).json({ error: "Unknown OAuth connector source" }); return null; }
  const orgId = activeOrgId(req);
  const candidates = (await memoryEngine.connectors.listConnectors(req.userId!))
    .filter((item) => item.source === source && item.orgId === orgId);
  // Multi-account: an explicit connectorId picks a SPECIFIC account (implicitly
  // ownership-checked — `candidates` is already scoped to the caller + source +
  // org). Without one we fall back to the first account (single-account callers).
  const connector = connectorId ? candidates.find((item) => item.id === connectorId) : candidates[0];
  if (connectorId && !connector) { res.status(404).json({ error: "Connector not found" }); return null; }
  return { source, connector, orgId };
}

/** The connector exists in the active org and belongs to the caller (or the
 * caller is a global admin acting inside that same active org). */
async function ownedConnector(req: AuthedRequest, res: Response) {
  const c = await memoryEngine.connectors.getConnector(String(req.params.id));
  if (!c) { res.status(404).json({ error: "Connector not found" }); return null; }
  if (c.orgId !== activeOrgId(req)) { res.status(404).json({ error: "Connector not found" }); return null; }
  if (c.userId !== req.userId && !req.isAdmin) { res.status(403).json({ error: "Not your connector" }); return null; }
  return c;
}

/** GET /api/connectors — the caller's connectors (no secrets). */
connectorManageRouter.get("/", async (req: AuthedRequest, res) => {
  const orgId = activeOrgId(req);
  const connectors = (await memoryEngine.connectors.listConnectors(req.userId!))
    .filter((connector) => connector.orgId === orgId);
  res.json({ connectors });
});

/** GET /api/connectors/:source/status — public connector state for desktop and dashboard.
 * This intentionally returns only metadata: credentials remain server-only. */
connectorManageRouter.get("/:source/status", async (req: AuthedRequest, res) => {
  const found = await sourceConnector(req, res);
  if (!found) return;
  const c = found.connector;
  const resolved = c?.hasCredential ? await memoryEngine.connectors.getResolvedConnector(c.id) : null;
  const account = resolved ? await discoverConnectorAccount(resolved).catch(() => null) : null;
  res.json({ source: found.source, connected: !!c?.hasCredential, connector: c ?? null, account, scopes: resolved?.credential?.scope ?? null });
});

/** GET /api/connectors/:source/accounts — EVERY account the caller has connected
 * for this source in the active org (multi-account: work + personal + …). Each
 * connector IS one external account; credentials stay server-only, so this
 * returns only the label, connected state, and the discovered account identity. */
connectorManageRouter.get("/:source/accounts", async (req: AuthedRequest, res) => {
  const source = String(req.params.source ?? "").trim();
  if (!isOAuthSource(source)) { res.status(404).json({ error: "Unknown OAuth connector source" }); return; }
  const orgId = activeOrgId(req);
  const connectors = (await memoryEngine.connectors.listConnectors(req.userId!))
    .filter((item) => item.source === source && item.orgId === orgId);
  const accounts = await Promise.all(connectors.map(async (c) => {
    const resolved = c.hasCredential ? await memoryEngine.connectors.getResolvedConnector(c.id) : null;
    const account = resolved ? await discoverConnectorAccount(resolved).catch(() => null) : null;
    return {
      id: c.id, label: c.name, connected: !!c.hasCredential, status: c.status,
      account, enabled: c.enabled, lastRunAt: c.lastRunAt, lastError: c.lastError,
      authMode: (c.config?.authMode as string | undefined) ?? undefined,
    };
  }));
  res.json({ source, accounts });
});

/** POST /api/connectors/:source/accounts — start a NEW account for this source.
 * Creates an empty connector the OAuth/device flow then binds a credential to,
 * so a user can add a second (work/personal) account without touching the first. */
connectorManageRouter.post("/:source/accounts", async (req: AuthedRequest, res) => {
  const source = String(req.params.source ?? "").trim();
  if (!isOAuthSource(source)) { res.status(404).json({ error: "Unknown OAuth connector source" }); return; }
  const label = typeof req.body?.label === "string" && req.body.label.trim() ? req.body.label.trim().slice(0, 80) : source;
  const connector = await memoryEngine.connectors.createConnector(req.userId!, {
    source,
    name: label,
    orgId: activeOrgId(req),
    visibility: "private",
  });
  res.status(201).json({ connector });
});

/** GET /api/connectors/:source/resources — selection state safe for a browser UI.
 * Source runtimes persist their selected repositories/projects/channels in config;
 * the endpoint never attempts to expose an OAuth token to enumerate them client-side. */
connectorManageRouter.get("/:source/resources", async (req: AuthedRequest, res) => {
  const found = await sourceConnector(req, res, String(req.query.connectorId ?? "").trim() || undefined);
  if (!found) return;
  if (!found.connector?.hasCredential) { res.json({ source: found.source, connected: false, resources: [] }); return; }
  const resolved = await memoryEngine.connectors.getResolvedConnector(found.connector.id);
  try { res.json({ source: found.source, connected: true, resources: resolved ? await discoverConnectorResources(resolved) : [] }); }
  catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : 'Resource discovery failed' }); }
});

/** PUT /api/connectors/:source/resources — persist the source-specific selection
 * while retaining all unrelated sync configuration. */
connectorManageRouter.put("/:source/resources", async (req: AuthedRequest, res) => {
  const found = await sourceConnector(req, res, typeof req.body?.connectorId === "string" && req.body.connectorId.trim() ? req.body.connectorId.trim() : undefined);
  if (!found?.connector) { res.status(404).json({ error: 'Connector not found' }); return; }
  const field = CONNECTOR_RESOURCE_FIELDS[found.source];
  if (!field) { res.status(400).json({ error: `${found.source} does not expose a selectable resource filter` }); return; }
  const resourceIds = Array.isArray(req.body?.resourceIds) ? req.body.resourceIds.filter((item: unknown): item is string => typeof item === 'string' && item.trim().length > 0).map((item: string) => item.trim()).slice(0, 200) : null;
  if (!resourceIds) { res.status(400).json({ error: 'resourceIds must be an array' }); return; }
  const connector = await memoryEngine.connectors.updateConnector(found.connector.id, { config: { ...found.connector.config, [field]: [...new Set(resourceIds)] } });
  if (!connector) { res.status(404).json({ error: 'Connector not found' }); return; }
  if (connector.enabled && connector.hasCredential) {
    await enqueueAgentJob(memoryEngine.store, "connector_sync", { connectorId: connector.id, userId: connector.userId }).catch(() => undefined);
  }
  res.json({ connector });
});

/** POST /api/connectors/:source/disconnect — clear the sealed token but retain
 * selection/checkpoint history, so reconnecting is an explicit, reversible action. */
connectorManageRouter.post("/:source/disconnect", async (req: AuthedRequest, res) => {
  const found = await sourceConnector(req, res);
  if (!found) return;
  if (!found.connector) { res.json({ ok: true, connector: null }); return; }
  const connector = await memoryEngine.connectors.updateConnector(found.connector.id, {
    credential: null,
    status: "disconnected",
    enabled: false,
    lastError: null,
  });
  res.json({ ok: true, connector });
});

/** POST /api/connectors — create (the token is attached later via the OAuth broker). */
connectorManageRouter.post("/", async (req: AuthedRequest, res) => {
  const source = String(req.body?.source ?? "").trim();
  if (!source) { res.status(400).json({ error: "source is required" }); return; }
  const wantsOrg = req.body?.visibility === "org";
  const connector = await memoryEngine.connectors.createConnector(req.userId!, {
    source,
    name: String(req.body?.name ?? source),
    // Private controls who can read the connector inside an org; it must not
    // erase the tenant boundary itself.
    orgId: activeOrgId(req),
    visibility: wantsOrg ? "org" : "private",
    config: (req.body?.config && typeof req.body.config === "object") ? req.body.config as Record<string, unknown> : {},
  });
  res.status(201).json({ connector });
});

/** PATCH /api/connectors/:id — rename / toggle / retarget config / visibility. */
connectorManageRouter.patch("/:id", async (req: AuthedRequest, res) => {
  if (!(await ownedConnector(req, res))) return;
  const patch: Record<string, unknown> = {};
  if (typeof req.body?.name === "string") patch.name = req.body.name;
  if (typeof req.body?.enabled === "boolean") patch.enabled = req.body.enabled;
  if (req.body?.config && typeof req.body.config === "object") patch.config = req.body.config;
  if (req.body?.visibility === "private" || req.body?.visibility === "org") patch.visibility = req.body.visibility;
  const connector = await memoryEngine.connectors.updateConnector(String(req.params.id), patch);
  if (!connector) { res.status(404).json({ error: 'Connector not found' }); return; }
  if (connector.enabled && connector.hasCredential) {
    await enqueueAgentJob(memoryEngine.store, "connector_sync", { connectorId: connector.id, userId: connector.userId }).catch(() => undefined);
  }
  res.json({ connector });
});

/** DELETE /api/connectors/:id */
connectorManageRouter.delete("/:id", async (req: AuthedRequest, res) => {
  if (!(await ownedConnector(req, res))) return;
  await memoryEngine.connectors.deleteConnector(String(req.params.id));
  res.json({ ok: true });
});

/** POST /api/connectors/:id/run — sync now (enqueue-free, direct run for feedback). */
connectorManageRouter.post("/:id/run", async (req: AuthedRequest, res) => {
  if (!(await ownedConnector(req, res))) return;
  const result = await runConnectorSync(String(req.params.id));
  res.json({ result });
});

/** Bounded GitLab Track proxy. The desktop's provider adapter emits only
 * project issue/note/member calls; the sealed connector credential never
 * leaves this worker and the target host is the connector's fixed HTTPS host. */
connectorManageRouter.post("/:source/track/proxy", async (req: AuthedRequest, res) => {
  if (String(req.params.source) !== "gitlab") { res.status(404).json({ error: "Track proxy is not available for this connector" }); return; }
  const found = await sourceConnector(req, res);
  if (!found?.connector?.hasCredential) { res.json({ ok: false, status: 401, error: "GitLab is not connected." }); return; }
  const resolved = await memoryEngine.connectors.getResolvedConnector(found.connector.id);
  const token = resolved?.credential?.accessToken?.trim();
  if (!resolved || !token) { res.json({ ok: false, status: 401, error: "GitLab is not connected." }); return; }
  const method = String(req.body?.method ?? "GET").toUpperCase();
  if (!["GET", "POST", "PUT"].includes(method)) { res.json({ ok: false, status: 405, error: "method not allowed" }); return; }
  const url = gitlabTrackProxyTarget(resolved.config.hostUrl, req.body?.path);
  if (!url) { res.json({ ok: false, status: 400, error: "path not allowed" }); return; }
  try {
    const upstream = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify(req.body?.body ?? {}),
    });
    const text = await upstream.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    res.json({ ok: upstream.ok, status: upstream.status, data });
  } catch (error) {
    res.json({ ok: false, status: 502, error: error instanceof Error ? error.message : "proxy failed" });
  }
});
