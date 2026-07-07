/**
 * ADR-016 C4 — connector management REST API (per-user, backend-hosted). This is
 * the surface the desktop repoints its ~40 file-local connector handlers to. CRUD
 * + "run now"; the OAuth credential arrives via the broker (oauth.ts), never here.
 * Mounted at /api/connectors alongside the OAuth broker.
 */
import { Router, type Response } from "express";
import { requireJwt, type AuthedRequest } from "../../middleware/auth.js";
import { memoryEngine } from "../../../memory/engine.js";
import { resolveOrgContext } from "../../../tenancy/context.js";
import { runConnectorSync } from "../../../connectors/syncExecutor.js";

export const connectorManageRouter = Router();
connectorManageRouter.use(requireJwt);

/** The connector exists and belongs to the caller (or the caller is a global admin). */
async function ownedConnector(req: AuthedRequest, res: Response) {
  const c = await memoryEngine.connectors.getConnector(String(req.params.id));
  if (!c) { res.status(404).json({ error: "Connector not found" }); return null; }
  if (c.userId !== req.userId && !req.isAdmin) { res.status(403).json({ error: "Not your connector" }); return null; }
  return c;
}

/** GET /api/connectors — the caller's connectors (no secrets). */
connectorManageRouter.get("/", async (req: AuthedRequest, res) => {
  const connectors = await memoryEngine.connectors.listConnectors(req.userId!);
  res.json({ connectors });
});

/** POST /api/connectors — create (the token is attached later via the OAuth broker). */
connectorManageRouter.post("/", async (req: AuthedRequest, res) => {
  const source = String(req.body?.source ?? "").trim();
  if (!source) { res.status(400).json({ error: "source is required" }); return; }
  const wantsOrg = req.body?.visibility === "org";
  let orgId: string | null = null;
  if (wantsOrg) {
    const requested = (req.headers["x-brainrouter-org"] as string | undefined)?.trim() || undefined;
    const ctx = await resolveOrgContext(memoryEngine.tenancy, req.userId!, requested).catch(() => null);
    orgId = ctx?.orgId ?? null;
  }
  const connector = await memoryEngine.connectors.createConnector(req.userId!, {
    source,
    name: String(req.body?.name ?? source),
    orgId,
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
