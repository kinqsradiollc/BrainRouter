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
import { memoryEngine } from "../../../memory/engine.js";
import { requireAnyAuth, type AuthedRequest } from "../../middleware/auth.js";
import { buildBrainAgentStatuses } from "../../../memory/agents/status.js";
import { sendError } from "../../../contracts/http.js";

export const brainRouter = Router();
brainRouter.use(requireAnyAuth);

brainRouter.get("/agents", async (_req, res) => {
  try {
    res.json({ agents: await buildBrainAgentStatuses(memoryEngine.store) });
  } catch (err: any) {
    sendError(res, 500, `brain agents failed: ${err?.message ?? err}`);
  }
});

brainRouter.get("/jobs", async (req, res) => {
  try {
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(200, Math.floor(limitRaw)) : 50;
    const kind = typeof req.query.kind === "string" ? req.query.kind : undefined;
    res.json({ jobs: await memoryEngine.store.listMemoryJobs({ kind, limit }) });
  } catch (err: any) {
    sendError(res, 500, `brain jobs failed: ${err?.message ?? err}`);
  }
});

// 0.4.3 — source documents + chunks (the captured, citable source layer the
// dashboard Sources view drills into). Read-only; capability-detected so a
// store without the 0.4.3 tables degrades to empty rather than erroring.
brainRouter.get("/sources", async (req: AuthedRequest, res) => {
  try {
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(500, Math.floor(limitRaw)) : 100;
    const store = memoryEngine.store as Partial<{ getSourceDocuments(userId: string, limit?: number): Promise<unknown[]> }>;
    const documents = typeof store.getSourceDocuments === "function" ? await store.getSourceDocuments(req.userId!, limit) : [];
    res.json({ documents });
  } catch (err: any) {
    sendError(res, 500, `brain sources failed: ${err?.message ?? err}`);
  }
});

brainRouter.get("/sources/:id/chunks", async (req: AuthedRequest, res) => {
  try {
    const store = memoryEngine.store as Partial<{
      getSourceDocument(id: string): Promise<{ userId: string } | null>;
      getSourceChunksByDocument(documentId: string): Promise<unknown[]>;
    }>;
    // Ownership gate: only the document's owner may read its chunks (cross-user
    // IDOR otherwise — the chunk query isn't user-scoped on its own).
    const doc = typeof store.getSourceDocument === "function" ? await store.getSourceDocument(String(req.params.id)) : null;
    if (!doc || doc.userId !== req.userId) {
      sendError(res, 404, "source document not found");
      return;
    }
    const chunks = typeof store.getSourceChunksByDocument === "function" ? await store.getSourceChunksByDocument(String(req.params.id)) : [];
    res.json({ chunks });
  } catch (err: any) {
    sendError(res, 500, `brain source chunks failed: ${err?.message ?? err}`);
  }
});

// 0.4.3 — blackboard staging area (candidates pending commit to cognitive records).
brainRouter.get("/blackboard", async (req: AuthedRequest, res) => {
  try {
    const store = memoryEngine.store as Partial<{ getBlackboardItems(userId: string, status?: string): Promise<unknown[]> }>;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const items = typeof store.getBlackboardItems === "function" ? await store.getBlackboardItems(req.userId!, status) : [];
    res.json({ items });
  } catch (err: any) {
    sendError(res, 500, `brain blackboard failed: ${err?.message ?? err}`);
  }
});

// 0.4.3 — memory tree (summary hierarchy). Roots, then drill children by id.
brainRouter.get("/tree", async (req: AuthedRequest, res) => {
  try {
    const store = memoryEngine.store as Partial<{ getTreeRoots(userId: string, kind?: string): Promise<unknown[]> }>;
    const kind = typeof req.query.kind === "string" ? req.query.kind : undefined;
    const roots = typeof store.getTreeRoots === "function" ? await store.getTreeRoots(req.userId!, kind) : [];
    res.json({ roots });
  } catch (err: any) {
    sendError(res, 500, `brain tree failed: ${err?.message ?? err}`);
  }
});

brainRouter.get("/tree/:id/children", async (req: AuthedRequest, res) => {
  try {
    const store = memoryEngine.store as Partial<{
      getTreeNode(id: string): Promise<{ userId: string } | null>;
      getTreeChildren(parentId: string): Promise<unknown[]>;
    }>;
    // Ownership gate: only the node's owner may drill its children.
    const node = typeof store.getTreeNode === "function" ? await store.getTreeNode(String(req.params.id)) : null;
    if (!node || node.userId !== req.userId) {
      sendError(res, 404, "tree node not found");
      return;
    }
    const children = typeof store.getTreeChildren === "function" ? await store.getTreeChildren(String(req.params.id)) : [];
    res.json({ children });
  } catch (err: any) {
    sendError(res, 500, `brain tree children failed: ${err?.message ?? err}`);
  }
});

// 0.4.3 — vault export ledger (read-only markdown mirror of records + tree).
brainRouter.get("/vault", async (req: AuthedRequest, res) => {
  try {
    const store = memoryEngine.store as Partial<{ getVaultExports(userId: string): Promise<unknown[]> }>;
    const exports = typeof store.getVaultExports === "function" ? await store.getVaultExports(req.userId!) : [];
    res.json({ exports });
  } catch (err: any) {
    sendError(res, 500, `brain vault failed: ${err?.message ?? err}`);
  }
});
