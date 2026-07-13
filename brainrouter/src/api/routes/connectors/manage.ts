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

export const connectorManageRouter = Router();
connectorManageRouter.use(requireAnyAuth);
// Connector credentials control what external data enters an organization.  Keep
// this surface aligned with the OAuth-app configuration endpoints: a valid JWT
// alone is not sufficient; the active org role must be allowed to manage
// triggers/integrations.
connectorManageRouter.use(requirePermission("triggers:manage"));

function activeOrgId(req: AuthedRequest): string {
  // `requirePermission` immediately above resolves and attaches this value. Keep
  // every subsequent lookup pinned to that single request context instead of
  // resolving again (or silently degrading to an unscoped query on an error).
  if (!req.orgId) throw new Error("Connector route is missing its organization context");
  return req.orgId;
}

async function sourceConnector(req: AuthedRequest, res: Response) {
  const source = String(req.params.source ?? "").trim();
  if (!isOAuthSource(source)) { res.status(404).json({ error: "Unknown OAuth connector source" }); return null; }
  const orgId = activeOrgId(req);
  const candidates = (await memoryEngine.connectors.listConnectors(req.userId!)).filter((item) => item.source === source);
  const connector = candidates.find((item) => item.orgId === orgId);
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

/** GET /api/connectors/:source/resources — selection state safe for a browser UI.
 * Source runtimes persist their selected repositories/projects/channels in config;
 * the endpoint never attempts to expose an OAuth token to enumerate them client-side. */
connectorManageRouter.get("/:source/resources", async (req: AuthedRequest, res) => {
  const found = await sourceConnector(req, res);
  if (!found) return;
  if (!found.connector?.hasCredential) { res.json({ source: found.source, connected: false, resources: [] }); return; }
  const resolved = await memoryEngine.connectors.getResolvedConnector(found.connector.id);
  try { res.json({ source: found.source, connected: true, resources: resolved ? await discoverConnectorResources(resolved) : [] }); }
  catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : 'Resource discovery failed' }); }
});

/** PUT /api/connectors/:source/resources — persist the source-specific selection
 * while retaining all unrelated sync configuration. */
connectorManageRouter.put("/:source/resources", async (req: AuthedRequest, res) => {
  const found = await sourceConnector(req, res);
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
