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
import { z } from "zod";
import { MODEL_REASONING_EFFORTS, projectTagFromName } from "@kinqs/brainrouter-types";
import { memoryEngine } from "../../../memory/engine.js";
import { requireAnyAuth, type AuthedRequest } from "../../middleware/auth.js";
import { withOrgContext } from "../../middleware/tenancy.js";
import { buildBrainAgentStatuses } from "../../../memory/agents/status.js";
import { sendError } from "../../../contracts/http.js";
import { roleAtLeast } from "../../../tenancy/rbac.js";
import {
  modelGateway,
  resolveScopedModelSelection,
  ScopedModelSelectionError,
} from "../../../services/modelGateway/modelGateway.js";
import { runBrainChat } from "./brainChatService.js";

export const brainRouter = Router();
brainRouter.use(requireAnyAuth);

const ChatRequestSchema = z.object({
  messages: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().trim().min(1).max(12_000),
  })).min(1).max(30),
  sessionKey: z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9._:-]+$/, "sessionKey contains unsupported characters"),
  projectId: z.string().trim().min(1).max(160).optional(),
  workspaceTag: z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9._:-]+$/, "workspaceTag contains unsupported characters").optional(),
  model: z.string().trim().min(1).max(160).optional(),
  reasoningEffort: z.enum(MODEL_REASONING_EFFORTS).optional(),
}).superRefine((body, ctx) => {
  if (body.messages.at(-1)?.role !== "user") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["messages"], message: "the latest message must be from the user" });
  }
  const total = body.messages.reduce((sum, message) => sum + message.content.length, 0);
  if (total > 80_000) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["messages"], message: "message history is too large" });
  }
});

async function accessibleProject(req: AuthedRequest, projectId: string) {
  const projects = await memoryEngine.projects.listAccessibleProjects(
    req.orgId!,
    req.userId!,
    Boolean(req.isAdmin || roleAtLeast(req.role, "admin")),
  );
  return projects.find((project) => project.projectId === projectId) ?? null;
}

/** POST /api/brain/chat — authenticated, org/project/workspace-scoped agent chat. */
brainRouter.post("/chat", withOrgContext, async (req: AuthedRequest, res) => {
  try {
    const body = ChatRequestSchema.parse(req.body ?? {});
    const project = body.projectId ? await accessibleProject(req, body.projectId) : null;
    if (body.projectId && !project) {
      sendError(res, 404, "project not found or not accessible");
      return;
    }
    const selection = await resolveScopedModelSelection({
      store: memoryEngine.models,
      orgId: req.orgId!,
      requestedModel: body.model,
      reasoningEffort: body.reasoningEffort,
    });
    const result = await runBrainChat({
      userId: req.userId!,
      orgId: req.orgId!,
      // Dispatch runs as the model owner (selection.orgId) — same as orgId unless
      // this org inherited the deployment-default model from the system org.
      dispatchOrgId: selection.orgId,
      sessionKey: body.sessionKey,
      projectId: project?.projectId,
      projectTag: project ? projectTagFromName(project.name) ?? undefined : undefined,
      workspaceTag: body.workspaceTag,
      model: selection.publicModelId,
      reasoningEffort: selection.reasoningEffort,
      servicePrincipalId: selection.servicePrincipalId,
      messages: body.messages,
    }, {
      recall: (input) => memoryEngine.recall(input),
      dispatch: (input) => modelGateway.dispatchScoped(input),
      capture: (input) => memoryEngine.capture(input),
    });
    res.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      sendError(res, 400, error.issues.map((issue) => issue.message).join("; "));
      return;
    }
    if (error instanceof ScopedModelSelectionError) {
      const status = error.code === "model_not_configured" ? 503 : 400;
      sendError(res, status, error.message);
      return;
    }
    // Provider failures can include upstream response bodies. Keep those details
    // server-side so a dashboard caller never receives vendor diagnostics or
    // reflected sensitive data in the public error envelope.
    console.error("[BrainRouter] dashboard chat request failed:", error instanceof Error ? error.message : error);
    sendError(res, 502, "Chat request failed. Check the active model provider and try again.");
  }
});

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
brainRouter.get("/sources", withOrgContext, async (req: AuthedRequest, res) => {
  try {
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(500, Math.floor(limitRaw)) : 100;
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId.trim().slice(0, 160) : "";
    const workspaceTag = typeof req.query.workspaceTag === "string" ? req.query.workspaceTag.trim().slice(0, 160) : "";
    if (projectId && !(await accessibleProject(req, projectId))) {
      sendError(res, 404, "project not found or not accessible");
      return;
    }
    const defaultOrgId = await memoryEngine.tenancy.getDefaultOrgId(req.userId!);
    const store = memoryEngine.store as Partial<{
      getSourceDocuments(userId: string, limit?: number, filters?: {
        orgId?: string;
        projectId?: string;
        workspaceTag?: string;
        includeUnscoped?: boolean;
      }): Promise<unknown[]>;
    }>;
    const documents = typeof store.getSourceDocuments === "function" ? await store.getSourceDocuments(req.userId!, limit, {
      orgId: req.orgId!,
      ...(projectId ? { projectId } : {}),
      ...(workspaceTag ? { workspaceTag } : {}),
      includeUnscoped: defaultOrgId === req.orgId && !projectId && !workspaceTag,
    }) : [];
    res.json({ documents });
  } catch (error) {
    console.error("[BrainRouter] source listing failed:", error instanceof Error ? error.message : error);
    sendError(res, 500, "Could not load sources");
  }
});

brainRouter.get("/sources/:id/chunks", withOrgContext, async (req: AuthedRequest, res) => {
  try {
    const store = memoryEngine.store as Partial<{
      getSourceDocument(id: string): Promise<{ userId: string; orgId?: string | null; projectId?: string | null } | null>;
      getSourceChunksByDocument(documentId: string): Promise<unknown[]>;
    }>;
    // Ownership gate: only the document's owner may read its chunks (cross-user
    // IDOR otherwise — the chunk query isn't user-scoped on its own).
    const doc = typeof store.getSourceDocument === "function" ? await store.getSourceDocument(String(req.params.id)) : null;
    const defaultOrgId = await memoryEngine.tenancy.getDefaultOrgId(req.userId!);
    const orgAllowed = doc?.orgId ? doc.orgId === req.orgId : defaultOrgId === req.orgId;
    const projectAllowed = !doc?.projectId || Boolean(await accessibleProject(req, doc.projectId));
    if (!doc || doc.userId !== req.userId || !orgAllowed || !projectAllowed) {
      sendError(res, 404, "source document not found");
      return;
    }
    const chunks = typeof store.getSourceChunksByDocument === "function" ? await store.getSourceChunksByDocument(String(req.params.id)) : [];
    res.json({ chunks });
  } catch (error) {
    console.error("[BrainRouter] source chunk loading failed:", error instanceof Error ? error.message : error);
    sendError(res, 500, "Could not load source chunks");
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
