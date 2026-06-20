import { z } from "zod";
import { memoryEngine } from "../memory/engine.js";

const HASH_PATTERN = /^[a-f0-9]{24}$/;

function toolResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

interface CompressionReader {
  retrieveCompressionEntry(
    userId: string,
    hash: string,
    query?: string,
  ): { kind: "full" | "subset"; originalContent?: string; results?: unknown[] } | null;
}

export const memoryRetrieveToolSchema = {
  name: "memory_retrieve",
  description: "Recover an original payload from a reversible compression reference. Supply query to return only relevant rows from a JSON array.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string" },
      hash: { type: "string", description: "A 24-character lowercase hexadecimal compression reference." },
      query: { type: "string", description: "Optional query for a relevant JSON-array subset." },
    },
    required: ["hash"],
  },
} as const;

const schema = z.object({ userId: z.string().optional(), hash: z.string(), query: z.string().optional() });

export async function handleMemoryRetrieve(args: unknown, options?: { defaultUserId?: string }) {
  const params = schema.parse(args ?? {});
  if (!HASH_PATTERN.test(params.hash)) {
    return toolResult({
      error: "Invalid compression reference.",
      hash: params.hash,
      hint: "Use the 24-character lowercase hexadecimal hash returned by memory_compress.",
    });
  }
  const userId = params.userId ?? options?.defaultUserId ?? "default";
  const result = (memoryEngine.store as unknown as CompressionReader).retrieveCompressionEntry(userId, params.hash, params.query);
  if (!result) {
    return toolResult({
      error: "Compression reference was not found or has expired.",
      hash: params.hash,
      hint: "Run memory_compress again if the source content is still available.",
    });
  }
  if (result.kind === "subset") {
    const results = result.results ?? [];
    return toolResult({ hash: params.hash, query: params.query, results, count: results.length });
  }
  return toolResult({ hash: params.hash, original_content: result.originalContent ?? "" });
}
