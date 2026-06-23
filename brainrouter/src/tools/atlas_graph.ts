import { z } from "zod";
import { isAtlasGraph, atlasSearchMatches, atlasImpact, enrichAtlasGraph, type AtlasGraph, type AtlasLlmCaller } from "@kinqs/brainrouter-types";
import { memoryEngine } from "../memory/engine.js";
import { ModelLLMRunner } from "../memory/llm/modelRunner.js";

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

// ---- atlas_query (Phase 3b: server-side query over the stored graph) -----

export const atlasQueryToolSchema = {
  name: "atlas_query",
  description:
    "Search a stored Atlas graph's nodes by free text (name/path/summary/tags), ranked best-first. Tenant-scoped. Returns {found, workspaceTag, matches:[{id,type,name,filePath?}]}.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string" },
      workspaceTag: { type: "string" },
      query: { type: "string", description: "Free-text query." },
      limit: { type: "number", description: "Max matches (default 30, max 200)." },
    },
    required: ["workspaceTag", "query"],
  },
} as const;

const querySchema = z.object({
  userId: z.string().optional(),
  workspaceTag: WORKSPACE_TAG,
  query: z.string().min(1),
  limit: z.number().int().min(1).max(200).optional(),
});

export async function handleAtlasQuery(args: unknown, options?: { defaultUserId?: string }) {
  try {
    const params = querySchema.parse(args ?? {});
    const userId = params.userId ?? options?.defaultUserId ?? "default";
    const graph = await memoryEngine.store.getAtlasGraph(userId, params.workspaceTag);
    if (!graph) return toolResult({ found: false, workspaceTag: params.workspaceTag });
    const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
    const matches = atlasSearchMatches(graph, params.query)
      .slice(0, params.limit ?? 30)
      .map((id) => {
        const n = byId.get(id)!;
        return { id: n.id, type: n.type, name: n.name, filePath: n.filePath };
      });
    return toolResult({ found: true, workspaceTag: params.workspaceTag, matches });
  } catch (err) {
    return toolError("atlas_query", err);
  }
}

// ---- atlas_impact (Phase 3b: blast radius over the stored graph) ---------

export const atlasImpactToolSchema = {
  name: "atlas_impact",
  description:
    "Blast radius of a node in a stored Atlas graph: its transitive dependents (who breaks if it changes), its dependencies, and dependents grouped by layer. Tenant-scoped. Returns {found, workspaceTag, nodeId, impact?}.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string" },
      workspaceTag: { type: "string" },
      nodeId: { type: "string", description: "Atlas node id, e.g. file:src/x.ts." },
    },
    required: ["workspaceTag", "nodeId"],
  },
} as const;

const impactSchema = z.object({
  userId: z.string().optional(),
  workspaceTag: WORKSPACE_TAG,
  nodeId: z.string().min(1),
});

export async function handleAtlasImpact(args: unknown, options?: { defaultUserId?: string }) {
  try {
    const params = impactSchema.parse(args ?? {});
    const userId = params.userId ?? options?.defaultUserId ?? "default";
    const graph = await memoryEngine.store.getAtlasGraph(userId, params.workspaceTag);
    if (!graph) return toolResult({ found: false, workspaceTag: params.workspaceTag, nodeId: params.nodeId });
    return toolResult({ found: true, workspaceTag: params.workspaceTag, nodeId: params.nodeId, impact: atlasImpact(graph, params.nodeId) });
  } catch (err) {
    return toolError("atlas_impact", err);
  }
}

// ---- atlas_enrich (Phase 3c: enrich the stored graph server-side) --------

export const atlasEnrichToolSchema = {
  name: "atlas_enrich",
  description:
    "Enrich a stored Atlas graph server-side with the brain's configured LLM — file summaries, architectural layers, a guided tour, and layer-relationship labels — then store the enriched graph back. Best-effort (a missing/failing LLM degrades to fewer artifacts, never an error). Tenant-scoped. Returns {found, workspaceTag, enriched?}.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string" },
      workspaceTag: { type: "string" },
      maxFiles: { type: "number", description: "Cap file-level nodes summarised (default 200)." },
      batchSize: { type: "number", description: "Files per summary LLM call (default 12)." },
      concurrency: { type: "number", description: "Concurrent summary batches (default 3)." },
    },
    required: ["workspaceTag"],
  },
} as const;

const enrichSchema = z.object({
  userId: z.string().optional(),
  workspaceTag: WORKSPACE_TAG,
  maxFiles: z.number().int().min(1).max(5000).optional(),
  batchSize: z.number().int().min(1).max(64).optional(),
  concurrency: z.number().int().min(1).max(8).optional(),
});

export async function handleAtlasEnrich(args: unknown, options?: { defaultUserId?: string }) {
  try {
    const params = enrichSchema.parse(args ?? {});
    const userId = params.userId ?? options?.defaultUserId ?? "default";
    const graph = await memoryEngine.store.getAtlasGraph(userId, params.workspaceTag);
    if (!graph) return toolResult({ found: false, workspaceTag: params.workspaceTag });

    // Adapt the brain's LLM runner to the AtlasLlmCaller port — forwarding the
    // structured-output `tool` so enrichment uses the same forced-tool-call
    // harness as the memory passes (consistent across models).
    const runner = new ModelLLMRunner();
    const caller: AtlasLlmCaller = async ({ system, user, tool }) =>
      runner.run({ prompt: user, systemPrompt: system, taskId: "atlas-enrich", tool });

    const res = await enrichAtlasGraph(graph, caller, {
      ...(params.maxFiles ? { maxFiles: params.maxFiles } : {}),
      ...(params.batchSize ? { batchSize: params.batchSize } : {}),
      ...(params.concurrency ? { concurrency: params.concurrency } : {}),
    });
    await memoryEngine.store.putAtlasGraph(userId, params.workspaceTag, res.graph);

    return toolResult({
      found: true,
      workspaceTag: params.workspaceTag,
      enriched: {
        summarized: res.summarized,
        layers: res.layers,
        tourSteps: res.tourSteps,
        relationships: res.relationships,
        batchesFailed: res.batchesFailed,
      },
    });
  } catch (err) {
    return toolError("atlas_enrich", err);
  }
}
