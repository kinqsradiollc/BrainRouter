import { z } from "zod";
import { memoryEngine } from "../memory/engine.js";

/**
 * MEM-32 (0.4.4) — `memory_record_lesson`: capture a durable lesson/insight that
 * strengthens on corroboration. The lesson is dedup-fingerprinted; recording the
 * same lesson again reinforces it (higher confidence + corroboration count)
 * rather than duplicating. Stored as a `lesson` cognitive record, so it flows
 * through normal recall + briefings.
 */

function toolResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function toolError(toolName: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text" as const, text: `${toolName} failed: ${message}` }] };
}

export const memoryRecordLessonToolSchema = {
  name: "memory_record_lesson",
  description:
    "Record a durable lesson/insight (e.g. 'always run the migration before seeding'). Dedup-fingerprinted: recording the same lesson again reinforces it (confidence + corroboration count) instead of duplicating. Surfaces in future recall/briefings. Returns {recordId, reinforced, confidence, corroborations}.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string" },
      text: { type: "string", description: "The lesson, stated as a reusable rule or insight." },
      evidence: { type: "string", description: "Optional supporting evidence / where it was learned." },
      sessionKey: { type: "string" },
      activeSkill: { type: "string", description: "Optional active skill/scene tag." },
      priority: { type: "number", description: "Recall priority 0-100 (default 80)." },
    },
    required: ["text"],
  },
} as const;

const schema = z.object({
  userId: z.string().optional(),
  text: z.string().min(3),
  evidence: z.string().optional(),
  sessionKey: z.string().optional(),
  activeSkill: z.string().optional(),
  priority: z.number().int().min(0).max(100).optional(),
});

export async function handleMemoryRecordLesson(args: any, options?: { defaultUserId?: string }) {
  try {
    const params = schema.parse(args ?? {});
    const userId = params.userId ?? options?.defaultUserId ?? "default";
    const result = memoryEngine.recordLesson(userId, params.text, {
      evidence: params.evidence,
      sessionKey: params.sessionKey,
      activeSkill: params.activeSkill,
      priority: params.priority,
    });
    return toolResult(result);
  } catch (err) {
    return toolError("memory_record_lesson", err);
  }
}
