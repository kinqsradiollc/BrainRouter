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

brainRouter.get("/sources/:id/chunks", (req: AuthedRequest, res) => {
  try {
    const store = memoryEngine.store as Partial<{
      getSourceDocument(id: string): { userId: string } | null;
      getSourceChunksByDocument(documentId: string): unknown[];
    }>;
    // Ownership gate: only the document's owner may read its chunks (cross-user
    // IDOR otherwise — the chunk query isn't user-scoped on its own).
    const doc = typeof store.getSourceDocument === "function" ? store.getSourceDocument(String(req.params.id)) : null;
    if (!doc || doc.userId !== req.userId) {
      res.status(404).json({ error: "source document not found" });
      return;
    }
    const chunks = typeof store.getSourceChunksByDocument === "function" ? store.getSourceChunksByDocument(String(req.params.id)) : [];
    res.json({ chunks });
  } catch (err: any) {
    res.status(500).json({ error: `brain source chunks failed: ${err?.message ?? err}` });
  }
});

// 0.4.3 — blackboard staging area (candidates pending commit to cognitive records).
brainRouter.get("/blackboard", (req: AuthedRequest, res) => {
  try {
    const store = memoryEngine.store as Partial<{ getBlackboardItems(userId: string, status?: string): unknown[] }>;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const items = typeof store.getBlackboardItems === "function" ? store.getBlackboardItems(req.userId!, status) : [];
    res.json({ items });
  } catch (err: any) {
    res.status(500).json({ error: `brain blackboard failed: ${err?.message ?? err}` });
  }
});

// 0.4.3 — memory tree (summary hierarchy). Roots, then drill children by id.
brainRouter.get("/tree", (req: AuthedRequest, res) => {
  try {
    const store = memoryEngine.store as Partial<{ getTreeRoots(userId: string, kind?: string): unknown[] }>;
    const kind = typeof req.query.kind === "string" ? req.query.kind : undefined;
    const roots = typeof store.getTreeRoots === "function" ? store.getTreeRoots(req.userId!, kind) : [];
    res.json({ roots });
  } catch (err: any) {
    res.status(500).json({ error: `brain tree failed: ${err?.message ?? err}` });
  }
});

brainRouter.get("/tree/:id/children", (req: AuthedRequest, res) => {
  try {
    const store = memoryEngine.store as Partial<{
      getTreeNode(id: string): { userId: string } | null;
      getTreeChildren(parentId: string): unknown[];
    }>;
    // Ownership gate: only the node's owner may drill its children.
    const node = typeof store.getTreeNode === "function" ? store.getTreeNode(String(req.params.id)) : null;
    if (!node || node.userId !== req.userId) {
      res.status(404).json({ error: "tree node not found" });
      return;
    }
    const children = typeof store.getTreeChildren === "function" ? store.getTreeChildren(String(req.params.id)) : [];
    res.json({ children });
  } catch (err: any) {
    res.status(500).json({ error: `brain tree children failed: ${err?.message ?? err}` });
  }
});

// 0.4.3 — vault export ledger (read-only markdown mirror of records + tree).
brainRouter.get("/vault", (req: AuthedRequest, res) => {
  try {
    const store = memoryEngine.store as Partial<{ getVaultExports(userId: string): unknown[] }>;
    const exports = typeof store.getVaultExports === "function" ? store.getVaultExports(req.userId!) : [];
    res.json({ exports });
  } catch (err: any) {
    res.status(500).json({ error: `brain vault failed: ${err?.message ?? err}` });
  }
});
