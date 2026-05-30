import { z } from "zod";
import { memoryEngine } from "../memory/engine.js";

/**
 * MEM (0.4.3) — `memory_prune_sources`: bound the unbounded growth of
 * auto-ingested per-turn transcripts. Deletes `transcript` source documents
 * older than `olderThanDays` EXCEPT any whose chunks are still referenced by a
 * live memory's provenance (cognitive_source_links), so memory_verify /
 * memory_provenance drill-down never breaks. Non-transcript source kinds are
 * never touched. Read-write maintenance tool; safe to re-run.
 */

function toolResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function toolError(toolName: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text" as const, text: `${toolName} failed: ${message}` }] };
}

export const memoryPruneSourcesToolSchema = {
  name: "memory_prune_sources",
  description:
    "Prune old conversation-transcript source documents to bound storage growth. Deletes transcripts older than olderThanDays (default 30) UNLESS their chunks are still cited by a live memory's provenance — so memory_verify/provenance never breaks. Only the 'transcript' kind is affected. Returns { prunedDocs, prunedChunks, olderThanDays }.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string" },
      olderThanDays: {
        type: "number",
        description: "Delete transcripts older than this many days (default 30, min 0).",
      },
    },
  },
} as const;

const schema = z.object({
  userId: z.string().optional(),
  olderThanDays: z.number().min(0).optional().default(30),
});

export async function handleMemoryPruneSources(args: any, options?: { defaultUserId?: string }) {
  try {
    const params = schema.parse(args ?? {});
    const userId = params.userId ?? options?.defaultUserId ?? "default";
    const result = memoryEngine.pruneTranscriptSources(userId, params.olderThanDays);
    return toolResult({ ...result, olderThanDays: params.olderThanDays });
  } catch (err) {
    return toolError("memory_prune_sources", err);
  }
}
