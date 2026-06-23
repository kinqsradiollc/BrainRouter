import { memoryEngine } from "../memory/engine.js";

function toolResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

interface CompressionStatsReader {
  getCompressionStats(userId: string): Promise<{
    compressions: number;
    retrievals: number;
    totalTokensSaved: number;
    savingsPercent: number;
    estimatedCostSavedUsd: number;
    recentEvents: unknown[];
    store: { entries: number; maxEntries: number };
  }>;
}

export const memoryStatsToolSchema = {
  name: "memory_stats",
  description: "Show user-scoped reversible compression counts, token savings, retrieval activity, and recent events.",
  inputSchema: {
    type: "object",
    properties: { userId: { type: "string" } },
  },
} as const;

export async function handleMemoryStats(args: unknown, options?: { defaultUserId?: string }) {
  const userId = typeof args === "object" && args && "userId" in args && typeof (args as { userId?: unknown }).userId === "string"
    ? (args as { userId: string }).userId
    : options?.defaultUserId ?? "default";
  const stats = await (memoryEngine.store as unknown as CompressionStatsReader).getCompressionStats(userId);
  return toolResult({
    compressions: stats.compressions,
    retrievals: stats.retrievals,
    total_tokens_saved: stats.totalTokensSaved,
    savings_percent: stats.savingsPercent,
    estimated_cost_saved_usd: stats.estimatedCostSavedUsd,
    recent_events: stats.recentEvents,
    store: { entries: stats.store.entries, max_entries: stats.store.maxEntries },
  });
}
