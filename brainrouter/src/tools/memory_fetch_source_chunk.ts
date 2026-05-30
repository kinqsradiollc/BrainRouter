import { z } from "zod";
import { memoryEngine } from "../memory/engine.js";

/**
 * MEM-8 (0.4.3) — `memory_fetch_source_chunk`: recall drill-down. From a
 * compact provenance excerpt (the `sources[]` of `memory_verify`, or
 * `memory_provenance`), expand into the original source — the full chunk
 * content, its parent document, and optional neighbouring chunks for context.
 * Read-only; the assembly lives on the engine so the store capability stays
 * runtime-detected.
 */

function toolResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function toolError(toolName: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text" as const, text: `${toolName} failed: ${message}` }],
  };
}

export const memoryFetchSourceChunkToolSchema = {
  name: "memory_fetch_source_chunk",
  description:
    "Drill down from a memory's provenance into the original source: fetch a source chunk by id (full content) plus its parent document and optional neighbouring chunks for context. Read-only — pairs with the sources[] returned by memory_verify / memory_provenance.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string" },
      chunkId: { type: "string", description: "Source chunk id (from memory_verify sources / provenance)." },
      neighbors: {
        type: "number",
        description: "Include ±N neighbouring chunks from the same document for context (default 0, max 10).",
      },
    },
    required: ["chunkId"],
  },
} as const;

const schema = z.object({
  userId: z.string().optional(),
  chunkId: z.string().min(1),
  neighbors: z.number().int().min(0).max(10).optional().default(0),
});

export async function handleMemoryFetchSourceChunk(args: any, options?: { defaultUserId?: string }) {
  try {
    const params = schema.parse(args ?? {});
    const userId = params.userId ?? options?.defaultUserId ?? "default";
    const result = memoryEngine.fetchSourceChunk(userId, params.chunkId, params.neighbors);
    if (!result) return toolResult({ found: false, chunkId: params.chunkId });
    return toolResult({ found: true, ...result });
  } catch (err) {
    return toolError("memory_fetch_source_chunk", err);
  }
}
