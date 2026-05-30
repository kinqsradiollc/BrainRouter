import { z } from "zod";
import { memoryEngine } from "../memory/engine.js";

/**
 * DASH-1 (0.4.4) — `memory_graph_analytics`: analytics lenses over the cognitive
 * graph. Returns PageRank centrality (most load-bearing entities), broker/bridge
 * entities (articulation points), a namespace overview (counts by type), and —
 * when `from` + `to` are given — the shortest connection path ("how is A related
 * to B"). Read-only; powers dashboard intelligence views.
 */

function toolResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function toolError(toolName: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text" as const, text: `${toolName} failed: ${message}` }] };
}

export const memoryGraphAnalyticsToolSchema = {
  name: "memory_graph_analytics",
  description:
    "Analytics over the cognitive graph: PageRank centrality, broker/bridge entities (articulation points), namespace overview (counts by type), and an optional shortest connection path between two entities (pass `from` + `to`). Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string" },
      topN: { type: "number", description: "How many top central / bridge entities to return (default 10, max 50)." },
      from: { type: "string", description: "Entity to start a shortest-path query from (use with `to`)." },
      to: { type: "string", description: "Entity to find a shortest path to (use with `from`)." },
    },
  },
} as const;

const schema = z.object({
  userId: z.string().optional(),
  topN: z.number().int().min(1).max(50).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

export async function handleMemoryGraphAnalytics(args: any, options?: { defaultUserId?: string }) {
  try {
    const params = schema.parse(args ?? {});
    const userId = params.userId ?? options?.defaultUserId ?? "default";
    const result = memoryEngine.graphAnalytics(userId, { topN: params.topN, from: params.from, to: params.to });
    return toolResult(result);
  } catch (err) {
    return toolError("memory_graph_analytics", err);
  }
}
