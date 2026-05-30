/**
 * BRAIN-P1-T5 (0.4.1) — dashboard-facing brain-agent routes.
 *
 * The dashboard talks REST (not MCP), so it reads brain-agent health
 * here instead of via the `memory_agent_status` tool. Read-only; same
 * `BrainAgentStatus[]` shape the tool returns (shared builder).
 *
 *   GET /api/brain/agents        → { agents: BrainAgentStatus[] }
 *   GET /api/brain/jobs?limit=N  → { jobs: MemoryJobRecord[] }  (recent)
 */

import { Router } from "express";
import { memoryEngine } from "../../memory/engine.js";
import { requireAnyAuth, type AuthedRequest } from "../middleware/auth.js";
import { buildBrainAgentStatuses } from "../../memory/agents/status.js";

export const brainRouter = Router();
brainRouter.use(requireAnyAuth);

brainRouter.get("/agents", (_req, res) => {
  try {
    res.json({ agents: buildBrainAgentStatuses(memoryEngine.store) });
  } catch (err: any) {
    res.status(500).json({ error: `brain agents failed: ${err?.message ?? err}` });
  }
});

brainRouter.get("/jobs", (req, res) => {
  try {
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(200, Math.floor(limitRaw)) : 50;
    const kind = typeof req.query.kind === "string" ? req.query.kind : undefined;
    res.json({ jobs: memoryEngine.store.listMemoryJobs({ kind, limit }) });
  } catch (err: any) {
    res.status(500).json({ error: `brain jobs failed: ${err?.message ?? err}` });
  }
});

// 0.4.3 — source documents + chunks (the captured, citable source layer the
// dashboard Sources view drills into). Read-only; capability-detected so a
// store without the 0.4.3 tables degrades to empty rather than erroring.
brainRouter.get("/sources", (req: AuthedRequest, res) => {
  try {
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(500, Math.floor(limitRaw)) : 100;
    const store = memoryEngine.store as Partial<{ getSourceDocuments(userId: string, limit?: number): unknown[] }>;
    const documents = typeof store.getSourceDocuments === "function" ? store.getSourceDocuments(req.userId!, limit) : [];
    res.json({ documents });
  } catch (err: any) {
    res.status(500).json({ error: `brain sources failed: ${err?.message ?? err}` });
  }
});

brainRouter.get("/sources/:id/chunks", (req, res) => {
  try {
    const store = memoryEngine.store as Partial<{ getSourceChunksByDocument(documentId: string): unknown[] }>;
    const chunks = typeof store.getSourceChunksByDocument === "function" ? store.getSourceChunksByDocument(String(req.params.id)) : [];
    res.json({ chunks });
  } catch (err: any) {
    res.status(500).json({ error: `brain source chunks failed: ${err?.message ?? err}` });
  }
});
