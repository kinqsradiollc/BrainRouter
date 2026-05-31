import { z } from "zod";
import { memoryEngine } from "../memory/engine.js";

/**
 * MEM-33 (0.4.4) — `memory_extract_skill`: distill a reusable SOP/skill from a
 * successful session summary. Call after a multi-step task succeeds; the LLM
 * gate returns nothing for exploratory/trivial runs. A real skill is stored as
 * a durable `lesson` (kind: "skill") that reinforces on re-extraction and
 * surfaces in future recall/briefings.
 */

function toolResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function toolError(toolName: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text" as const, text: `${toolName} failed: ${message}` }] };
}

export const memoryExtractSkillToolSchema = {
  name: "memory_extract_skill",
  description:
    "Distill a reusable skill (SOP) from a successful session and store it for future recall. Pass a `sessionSummary` of what was accomplished and how. Returns {extracted, skill?, recordId?}; extracted=false for exploratory/trivial sessions with no reusable procedure.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string" },
      sessionSummary: { type: "string", description: "What the session accomplished and the steps taken." },
      sessionKey: { type: "string" },
      activeSkill: { type: "string", description: "Optional active skill/scene tag." },
    },
    required: ["sessionSummary"],
  },
} as const;

const schema = z.object({
  userId: z.string().optional(),
  sessionSummary: z.string().min(20),
  sessionKey: z.string().optional(),
  activeSkill: z.string().optional(),
});

export async function handleMemoryExtractSkill(args: any, options?: { defaultUserId?: string }) {
  try {
    const params = schema.parse(args ?? {});
    const userId = params.userId ?? options?.defaultUserId ?? "default";
    const result = await memoryEngine.extractSkillFromSession(userId, {
      sessionSummary: params.sessionSummary,
      sessionKey: params.sessionKey,
      activeSkill: params.activeSkill,
    });
    return toolResult(result);
  } catch (err) {
    return toolError("memory_extract_skill", err);
  }
}
