import { z } from "zod";
import { memoryEngine } from "../memory/engine.js";

/**
 * MEM-30 (0.4.4) — `memory_reindex_source`: keep the code index fresh. Pass a
 * file path + its current content; BrainRouter hashes it and, if it drifted
 * from what's indexed, marks the stale document (kept for provenance, excluded
 * from find_related) and re-chunks the fresh content. A no-op when unchanged,
 * so it's cheap to call on every file read/edit. Callers can gate with a
 * size/mtime stat before sending content to avoid shipping unchanged bytes.
 */

function toolResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function toolError(toolName: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text" as const, text: `${toolName} failed: ${message}` }] };
}

export const memoryReindexSourceToolSchema = {
  name: "memory_reindex_source",
  description:
    "Refresh the code index for a file: pass `file` + its current `content`; if it drifted from the indexed version, the stale copy is excluded from recall and the fresh content is re-chunked (a no-op when unchanged). Returns {status: fresh|reindexed, chunks, staleMarked}.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string" },
      file: { type: "string", description: "File path (used as the document URI)." },
      content: { type: "string", description: "Current full file content." },
      language: { type: "string", description: "Optional language/extension hint for chunking (e.g. ts, python)." },
    },
    required: ["file", "content"],
  },
} as const;

const schema = z.object({
  userId: z.string().optional(),
  file: z.string().min(1),
  content: z.string(),
  language: z.string().optional(),
});

export async function handleMemoryReindexSource(args: any, options?: { defaultUserId?: string }) {
  try {
    const params = schema.parse(args ?? {});
    const userId = params.userId ?? options?.defaultUserId ?? "default";
    const result = memoryEngine.reindexCodeSource(userId, {
      filePath: params.file,
      content: params.content,
      language: params.language,
    });
    return toolResult(result);
  } catch (err) {
    return toolError("memory_reindex_source", err);
  }
}
