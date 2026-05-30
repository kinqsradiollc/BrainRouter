import { z } from "zod";
import { memoryEngine } from "../memory/engine.js";

/**
 * MEM-5 / MEM-8 (0.4.3) — `memory_tree_walk`: navigate the durable memory tree
 * and (optionally) build it. Walk the roots of a kind, drill into a node's
 * children, append a leaf summarizing some source chunks, or seal a bucket of
 * children into a summarized parent.
 *
 *   • (no action) → walk: nodeId given → that node + its children; else the
 *     roots of `kind` (or all roots).
 *   • action "append_leaf"      → add a level-0 leaf (summaryMd + sourceChunkIds).
 *   • action "summarize_bucket" → roll childIds into a summarized parent + seal them.
 */

function toolResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function toolError(toolName: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text" as const, text: `${toolName} failed: ${message}` }] };
}

const KINDS = ["source", "topic", "global"] as const;

export const memoryTreeWalkToolSchema = {
  name: "memory_tree_walk",
  description:
    "Navigate (and optionally build) the durable memory tree. Walk the roots of a kind, drill into a node's children, append a leaf summarizing source chunks, or seal a bucket of children into a summarized parent. Pairs with memory_fetch_source_chunk for full drill-down.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string" },
      action: { type: "string", enum: ["append_leaf", "summarize_bucket"], description: "Omit to walk/read." },
      nodeId: { type: "string", description: "Drill into this node's children (walk mode)." },
      kind: { type: "string", enum: KINDS as unknown as string[], description: "source | topic | global." },
      summaryMd: { type: "string", description: "Leaf summary (action=append_leaf)." },
      sourceChunkIds: { type: "array", items: { type: "string" }, description: "Chunks the leaf cites (action=append_leaf)." },
      childIds: { type: "array", items: { type: "string" }, description: "Children to roll up (action=summarize_bucket)." },
      heatScore: { type: "number" },
    },
  },
} as const;

const schema = z.object({
  userId: z.string().optional(),
  action: z.enum(["append_leaf", "summarize_bucket"]).optional(),
  nodeId: z.string().optional(),
  kind: z.enum(KINDS).optional(),
  summaryMd: z.string().optional(),
  sourceChunkIds: z.array(z.string()).optional(),
  childIds: z.array(z.string()).optional(),
  heatScore: z.number().optional(),
});

export async function handleMemoryTreeWalk(args: any, options?: { defaultUserId?: string }) {
  try {
    const params = schema.parse(args ?? {});
    const userId = params.userId ?? options?.defaultUserId ?? "default";

    switch (params.action) {
      case "append_leaf": {
        if (!params.summaryMd) throw new Error("summaryMd is required for append_leaf");
        const node = memoryEngine.appendTreeLeaf(userId, params.kind ?? "source", params.summaryMd, params.sourceChunkIds ?? [], params.heatScore ?? 0);
        return toolResult({ node });
      }
      case "summarize_bucket": {
        if (!params.childIds || params.childIds.length === 0) throw new Error("childIds is required for summarize_bucket");
        const parent = memoryEngine.summarizeBucket(userId, params.childIds, params.kind ?? "topic");
        return toolResult({ parent });
      }
      default:
        return toolResult(memoryEngine.treeWalk(userId, params.nodeId, params.kind));
    }
  } catch (err) {
    return toolError("memory_tree_walk", err);
  }
}
