import { z } from "zod";
import { memoryEngine } from "../../memory/engine.js";
import { compress, type CompressionStore } from "../../memory/compression/router.js";

function toolResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function toolError(toolName: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text" as const, text: `${toolName} failed: ${message}` }] };
}

export const memoryCompressToolSchema = {
  name: "memory_compress",
  description: "Compress a large structured payload with a reversible reference when content is removed. Use memory_retrieve with the returned hash to recover the original content.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string" },
      content: { type: "string", description: "The complete content to compress." },
      strategy: { type: "string", enum: ["auto", "json", "log", "diff", "code", "text"], description: "Optional content kind override." },
    },
    required: ["content"],
  },
} as const;

const schema = z.object({
  userId: z.string().optional(),
  content: z.string().min(1),
  strategy: z.enum(["auto", "json", "log", "diff", "code", "text"]).optional(),
});

export async function handleMemoryCompress(args: unknown, options?: { defaultUserId?: string }) {
  try {
    const params = schema.parse(args ?? {});
    const userId = params.userId ?? options?.defaultUserId ?? "default";
    const result = await compress(params.content, {
      userId,
      store: memoryEngine.store as unknown as CompressionStore,
      strategy: params.strategy,
      toolName: "memory_compress",
    });
    return toolResult({
      compressed: result.compressed,
      hash: result.hash,
      kind: result.kind,
      strategy: result.strategy,
      original_tokens: result.originalTokens,
      compressed_tokens: result.compressedTokens,
      tokens_saved: result.tokensSaved,
      savings_percent: result.savingsPercent,
      note: result.hash
        ? "Original content is available through memory_retrieve with this hash."
        : "No content was removed.",
    });
  } catch (error) {
    return toolError("memory_compress", error);
  }
}
