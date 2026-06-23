import { z } from "zod";
import { isAtlasGraph, type AtlasGraph } from "@kinqs/brainrouter-types";
import { memoryEngine } from "../memory/engine.js";

/**
 * REMOTE-BRAIN Phase 3 (ADR-005) — Atlas-as-service: store & serve.
 *
 * A remote/cloud brain can't BUILD an Atlas (that scans the client filesystem),
 * but it CAN hold one: the client builds locally and uploads via `atlas_put`,
 * then any client — or the dashboard as a remote client — fetches it back with
 * `atlas_get` / discovers it with `atlas_list`. The graph is stored verbatim
 * (the same JSON the CLI writes to `atlas-graph.json`).
 *
 * Tenant isolation: the MCP dispatcher pins the `userId` argument to the
 * authenticated user (cross-tenant IDOR guard), and every store call is scoped
 * by `userId`, so a client can only ever touch its own graphs.
 */

function toolResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function toolError(toolName: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text" as const, text: `${toolName} failed: ${message}` }] };
}

const WORKSPACE_TAG = z.string().min(1).max(200);

// ---- atlas_put ----------------------------------------------------------

export const atlasPutToolSchema = {
  name: "atlas_put",
  description:
    "Store (upsert) a client-built Atlas knowledge graph for a workspace so a remote brain can serve it back. The graph is built client-side (it scans the filesystem); this persists it, keyed by workspaceTag. Tenant-scoped. Returns {ok, workspaceTag, nodeCount}.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string" },
      workspaceTag: { type: "string", description: "Identifier the graph is stored under (e.g. a workspace path hash or name)." },
      graph: { type: "object", description: "The full AtlasGraph JSON artifact." },
    },
    required: ["workspaceTag", "graph"],
  },
} as const;

const putSchema = z.object({
  userId: z.string().optional(),
  workspaceTag: WORKSPACE_TAG,
  graph: z.unknown(),
});

export async function handleAtlasPut(args: unknown, options?: { defaultUserId?: string }) {
  try {
    const params = putSchema.parse(args ?? {});
    const userId = params.userId ?? options?.defaultUserId ?? "default";
    if (!isAtlasGraph(params.graph)) {
      return toolError("atlas_put", new Error("`graph` is not a valid AtlasGraph"));
    }
    const graph = params.graph as AtlasGraph;
    await memoryEngine.store.putAtlasGraph(userId, params.workspaceTag, graph);
    return toolResult({ ok: true, workspaceTag: params.workspaceTag, nodeCount: graph.nodes.length });
  } catch (err) {
    return toolError("atlas_put", err);
  }
}

// ---- atlas_get ----------------------------------------------------------

export const atlasGetToolSchema = {
  name: "atlas_get",
  description:
    "Fetch a previously-stored Atlas graph for a workspace. Tenant-scoped. Returns {found, workspaceTag, graph?}.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string" },
      workspaceTag: { type: "string" },
    },
    required: ["workspaceTag"],
  },
} as const;

const getSchema = z.object({ userId: z.string().optional(), workspaceTag: WORKSPACE_TAG });

export async function handleAtlasGet(args: unknown, options?: { defaultUserId?: string }) {
  try {
    const params = getSchema.parse(args ?? {});
    const userId = params.userId ?? options?.defaultUserId ?? "default";
    const graph = await memoryEngine.store.getAtlasGraph(userId, params.workspaceTag);
    return toolResult(
      graph
        ? { found: true, workspaceTag: params.workspaceTag, graph }
        : { found: false, workspaceTag: params.workspaceTag },
    );
  } catch (err) {
    return toolError("atlas_get", err);
  }
}

// ---- atlas_list ---------------------------------------------------------

export const atlasListToolSchema = {
  name: "atlas_list",
  description:
    "List the Atlas workspaces stored for the tenant, most-recently-updated first. Returns {workspaces:[{workspaceTag, nodeCount, updatedAt}]}.",
  inputSchema: {
    type: "object",
    properties: { userId: { type: "string" } },
  },
} as const;

const listSchema = z.object({ userId: z.string().optional() });

export async function handleAtlasList(args: unknown, options?: { defaultUserId?: string }) {
  try {
    const params = listSchema.parse(args ?? {});
    const userId = params.userId ?? options?.defaultUserId ?? "default";
    const workspaces = await memoryEngine.store.listAtlasWorkspaces(userId);
    return toolResult({ workspaces });
  } catch (err) {
    return toolError("atlas_list", err);
  }
}
