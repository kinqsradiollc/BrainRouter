import { z } from "zod";
import { memoryEngine } from "../memory/engine.js";

/**
 * MEM-32b (0.4.4) — `memory_reflect`: synthesize cross-memory insights (patterns
 * spanning multiple memories) and record them as reinforcing lessons. Returns
 * {reflected, insights}; reflected=0 when there's no genuine cross-cutting
 * insight or too few memories to reflect over.
 */

function toolResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function toolError(toolName: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text" as const, text: `${toolName} failed: ${message}` }] };
}

export const memoryReflectToolSchema = {
  name: "memory_reflect",
  description:
    "Reflect across recent memories to synthesize non-obvious, cross-cutting insights (patterns that span multiple entries), recording each as a reinforcing lesson. Returns {reflected, insights}. Use periodically to consolidate scattered memories into durable lessons.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string" },
      limit: { type: "number", description: "How many recent memories to reflect over (default 25, max 50)." },
    },
  },
} as const;

const schema = z.object({
  userId: z.string().optional(),
  limit: z.number().int().min(3).max(50).optional(),
});

export async function handleMemoryReflect(args: any, options?: { defaultUserId?: string }) {
  try {
    const params = schema.parse(args ?? {});
    const userId = params.userId ?? options?.defaultUserId ?? "default";
    const result = await memoryEngine.reflect(userId, { limit: params.limit });
    return toolResult(result);
  } catch (err) {
    return toolError("memory_reflect", err);
  }
}
