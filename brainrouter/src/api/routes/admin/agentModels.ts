/**
 * Per-role model routing for the MEMORY BRAIN's own cognitive workers.
 *
 * These are the brain's roles (extraction vs synthesis), which are DISTINCT from
 * the coding agent's SUBAGENT_ROLES — so this reuses core's BRAIN_AGENT_ROLES +
 * isBrainAgentRole (defined in @kinqs/brainrouter-core). Each role maps to an
 * assignment ({ provider?, model? }): `provider` references a DB provider config,
 * `model` overrides the model on the shared LLM provider. Stored per-org in the
 * system-settings KV so it survives redeploys and stays out of .env.
 */
import { Router } from "express";
import { memoryEngine } from "../../../memory/engine.js";
import { requireAnyAuth, type AuthedRequest } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/tenancy.js";
import { sendError } from "../../../contracts/http.js";
import { BRAIN_AGENT_ROLES, isBrainAgentRole } from "@kinqs/brainrouter-core/provider";

export const agentModelsRouter = Router();
agentModelsRouter.use(requireAnyAuth, requirePermission("providers:manage"));

interface AgentModelAssignment { provider?: string; model?: string }
const settingsKey = (orgId: string) => `agentModels:${orgId}`;

/** GET /api/admin/agent-models — the roles + the org's current per-role assignments. */
agentModelsRouter.get("/", async (req: AuthedRequest, res) => {
  const stored = (await memoryEngine.emailAuth.getSetting<Record<string, AgentModelAssignment>>(settingsKey(req.orgId!))) ?? {};
  res.json({ roles: [...BRAIN_AGENT_ROLES], assignments: stored });
});

/** PUT /api/admin/agent-models — replace the per-role assignments (validated against core roles). */
agentModelsRouter.put("/", async (req: AuthedRequest, res) => {
  const body = req.body?.assignments;
  if (!body || typeof body !== "object") { sendError(res, 400, "an `assignments` object is required"); return; }
  const clean: Record<string, AgentModelAssignment> = {};
  for (const [role, raw] of Object.entries(body as Record<string, unknown>)) {
    if (!isBrainAgentRole(role) || !raw || typeof raw !== "object") continue;
    const a = raw as AgentModelAssignment;
    const provider = typeof a.provider === "string" && a.provider.trim() ? a.provider.trim() : undefined;
    const model = typeof a.model === "string" && a.model.trim() ? a.model.trim() : undefined;
    if (provider || model) clean[role] = { ...(provider ? { provider } : {}), ...(model ? { model } : {}) };
  }
  await memoryEngine.emailAuth.setSetting(settingsKey(req.orgId!), clean);
  res.json({ assignments: clean });
});
