import { z } from "zod";
import { memoryEngine } from "../../memory/engine.js";

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
    "Record a durable lesson/insight (e.g. 'always run the migration before seeding'). Dedup-fingerprinted: recording the same lesson again reinforces it (confidence + corroboration count) instead of duplicating. Pass `supersedes` with the recordId(s) of a prior lesson this one replaces (e.g. a reversed decision) to invalidate them in the same call. Surfaces in future recall/briefings. Returns {recordId, reinforced, confidence, corroborations, supersededIds}.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string" },
      text: { type: "string", description: "The lesson, stated as a reusable rule or insight." },
      evidence: { type: "string", description: "Optional supporting evidence / where it was learned." },
      sessionKey: { type: "string" },
      activeSkill: { type: "string", description: "Optional active skill/scene tag." },
      priority: { type: "number", description: "Recall priority 0-100 (default 80)." },
      supersedes: {
        oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        description: "Optional recordId(s) of prior lesson(s) this one replaces — they are invalidated (stop surfacing in recall) and point to this record via superseded_by.",
      },
    },
    required: ["text"],
  },
} as const;

const baseSchema = z.object({
  userId: z.string().optional(),
  text: z.string().min(3),
  evidence: z.string().optional(),
  sessionKey: z.string().optional(),
  activeSkill: z.string().optional(),
  priority: z.number().int().min(0).max(100).optional(),
  supersedes: z.union([z.string(), z.array(z.string())]).optional(),
}).strict();

const learnedSchema = z.object({
    schemaVersion: z.literal(1),
    itemId: z.string().min(1).max(200),
    // Automatic host reflection can mint only evidence. The authenticated
    // human correction endpoint is the sole authority for instruction tier.
    tier: z.literal("evidence"),
    origin: z.literal("model-inferred"),
    form: z.enum(["lesson", "procedure"]),
    falsifier: z.string().max(400),
    expectation: z.string().max(400),
    status: z.enum(["active", "demoted", "retired", "reverted"]),
    statusReason: z.string().max(400).optional(),
    statusChangedAt: z.string().max(80).optional(),
    createdAt: z.string().max(80),
    updatedAt: z.string().max(80),
    provenance: z.object({
      sessionKey: z.string().max(200),
      capturedAt: z.string().max(80),
      checkpoint: z.enum(["turn-end", "compaction", "session-end"]),
      evidence: z.array(z.string().max(240)).max(6),
      corroboratingActionIds: z.array(z.string().max(160)).max(8).optional(),
      sawUntrustedContent: z.boolean(),
      gateReasoning: z.string().max(400),
    }).strict(),
    outcome: z.object({
      retrievals: z.number().int().min(0),
      confirmations: z.number().int().min(0),
      contradictions: z.number().int().min(0),
      lastRetrievedAt: z.string().max(80).optional(),
      lastConfirmedAt: z.string().max(80).optional(),
      lastContradictedAt: z.string().max(80).optional(),
    }).strict(),
    skillId: z.string().max(160).optional(),
    allowedTools: z.array(z.string().max(120)).max(32).optional(),
    memoryLifecycle: z.object({
      status: z.enum(["record-pending", "active", "archive-pending", "archived"]),
      updatedAt: z.string().max(80),
      attempts: z.number().int().min(0),
      lastError: z.string().max(240).optional(),
    }).strict().optional(),
  }).strict();

async function recordLesson(
  params: z.infer<typeof baseSchema> & { learned?: z.infer<typeof learnedSchema> },
  options?: { defaultUserId?: string; defaultOrgId?: string },
) {
  const userId = options?.defaultUserId ?? params.userId ?? "default";
  return memoryEngine.recordLesson(userId, params.text, {
    evidence: params.evidence,
    sessionKey: params.sessionKey,
    activeSkill: params.activeSkill,
    priority: params.priority,
    supersedes: params.supersedes,
    orgId: options?.defaultOrgId?.trim() || null,
    learned: params.learned,
  });
}

export async function handleMemoryRecordLesson(
  args: any,
  options?: { defaultUserId?: string; defaultOrgId?: string },
) {
  try {
    const params = baseSchema.parse(args ?? {});
    // `recordLesson` is async (the engine is Postgres-backed). Without the
    // await this returned `{}` — JSON.stringify of a pending Promise — so every
    // caller got a result with no `recordId`, `reinforced` or `confidence` and
    // no error to explain it. ADR-032 relies on that id to link a learned item
    // to its memory record, which is how the omission was found.
    const result = await recordLesson(params, options);
    return toolResult(result);
  } catch (err) {
    return toolError("memory_record_lesson", err);
  }
}

/** Host-only learned projection capture. Reached only through the custom MCP
 * host request; tools/call has no learned mutation path. */
export async function handleMemoryRecordLearned(
  args: unknown,
  options?: { defaultUserId?: string; defaultOrgId?: string },
) {
  try {
    const params = baseSchema.extend({ learned: learnedSchema }).parse(args ?? {});
    return toolResult(await recordLesson(params, options));
  } catch (err) {
    return toolError("memory_record_learned", err);
  }
}
