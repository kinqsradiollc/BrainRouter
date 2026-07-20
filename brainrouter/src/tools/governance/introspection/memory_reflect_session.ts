import { z } from "zod";
import { memoryEngine } from "../../../memory/engine.js";

/**
 * ADR-020 D3 — `memory_reflect_session`: at session end/idle, run ONE bounded pass
 * over the session and crystallize the durable signal into typed, first-class
 * memories — mistakes, anti-patterns, lessons, decisions, preferences, reusable
 * workflows — each tagged `reflection` and linked to the session. Complements the
 * general `memory_reflect` (cross-cutting insights) and `memory_extract_skill`
 * (SOP distillation); share the same session-end hook. Returns {reflected, elements}.
 */

function toolResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function toolError(toolName: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text" as const, text: `${toolName} failed: ${message}` }] };
}

export const memoryReflectSessionToolSchema = {
  name: "memory_reflect_session",
  description:
    "Reflect on a finished session and store its mistakes / anti-patterns / lessons / decisions / preferences / reusable-workflows as first-class memories tagged `reflection` (ADR-020 D3). Pass a `sessionSummary` of what happened. Returns {reflected, elements}; reflected=0 for trivial/exploratory sessions. Call at session end alongside memory_extract_skill.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string" },
      sessionSummary: { type: "string", description: "What the session did — decisions, mistakes, outcomes." },
      sessionKey: { type: "string" },
    },
    required: ["sessionSummary"],
  },
} as const;

const schema = z.object({
  userId: z.string().optional(),
  sessionSummary: z.string().min(20),
  sessionKey: z.string().optional(),
});

export async function handleMemoryReflectSession(args: any, options?: { defaultUserId?: string }) {
  try {
    const params = schema.parse(args ?? {});
    const userId = params.userId ?? options?.defaultUserId ?? "default";
    const result = await memoryEngine.reflectSession(userId, {
      sessionSummary: params.sessionSummary,
      sessionKey: params.sessionKey,
    });
    return toolResult(result);
  } catch (err) {
    return toolError("memory_reflect_session", err);
  }
}
