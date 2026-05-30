import { z } from "zod";
import { memoryEngine } from "../memory/engine.js";

/**
 * MEM-29 (0.4.4) — `memory_find_related`: exploration-driven code recall. Seed
 * from a source chunk id (from provenance / memory_fetch_source_chunk) or a
 * `file` + `line`, and get the nearest code-chunk neighbours by symbol /
 * identifier overlap — language-scoped, seed excluded, ranked by code-aware
 * relevance. Unlike memory_fetch_source_chunk (±N positional neighbours in one
 * document), this crosses files to surface callers / callees / similar
 * definitions. Read-only. Returns compact hits (chunkId + location + preview);
 * call memory_fetch_source_chunk on a chunkId for the full body.
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

export const memoryFindRelatedToolSchema = {
  name: "memory_find_related",
  description:
    "Find code chunks related to a seed (by symbol/identifier overlap, language-scoped) — exploration-driven recall across files. Seed with `chunkId` (from provenance) OR `file`+`line`. Read-only; returns compact ranked hits (chunkId, file:line, symbol, score, preview). Use memory_fetch_source_chunk on a returned chunkId for the full body.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string" },
      chunkId: { type: "string", description: "Seed source chunk id (mutually exclusive with file+line)." },
      file: { type: "string", description: "Seed file path (use with `line`). Absolute or workspace-relative." },
      line: { type: "number", description: "1-based line within `file` to seed from." },
      limit: { type: "number", description: "Max related chunks to return (default 10, max 50)." },
      sameLanguage: {
        type: "boolean",
        description: "Restrict results to the seed's language family (default true).",
      },
    },
  },
} as const;

const schema = z
  .object({
    userId: z.string().optional(),
    chunkId: z.string().min(1).optional(),
    file: z.string().min(1).optional(),
    line: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    sameLanguage: z.boolean().optional(),
  })
  .refine((v) => !!v.chunkId || (!!v.file && typeof v.line === "number"), {
    message: "provide either `chunkId` or both `file` and `line`",
  });

function preview(content: string, max = 200): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export async function handleMemoryFindRelated(args: any, options?: { defaultUserId?: string }) {
  try {
    const params = schema.parse(args ?? {});
    const userId = params.userId ?? options?.defaultUserId ?? "default";
    const result = memoryEngine.findRelatedChunks(
      userId,
      { chunkId: params.chunkId, filePath: params.file, line: params.line },
      { limit: params.limit, sameLanguage: params.sameLanguage },
    );
    if (!result.found) return toolResult({ found: false });
    return toolResult({
      found: true,
      seed: result.seed,
      count: result.related.length,
      related: result.related.map((r) => ({
        chunkId: r.chunk.id,
        filePath: r.chunk.filePath,
        symbol: r.chunk.symbol,
        startLine: r.chunk.startLine,
        endLine: r.chunk.endLine,
        score: Math.round(r.score * 1000) / 1000,
        reason: r.reason,
        preview: preview(r.chunk.content),
      })),
    });
  } catch (err) {
    return toolError("memory_find_related", err);
  }
}
