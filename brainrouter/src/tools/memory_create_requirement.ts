import { z } from "zod";
import { memoryEngine } from "../memory/engine.js";

/**
 * §2 (0.4.15) — `memory_create_requirement`: capture a structured requirement
 * (a unit of intent) directly into BrainRouter memory, so the requirement is
 * part of the cognitive graph and flows through recall/briefings like any other
 * durable record. BrainRouter memory stays the single source of truth — this is
 * the MCP-tool path the CLI/SDK use; the CLI requirement store links the
 * returned recordId back into the requirement's `linkedMemoryIds`.
 *
 * PROVENANCE ID-LINKING: the record carries the ids that link it to the rest of
 * the workflow — `requirementId`, `workflowId`, `taskId`, `artifactId` — in the
 * cognitive record's persisted `metadata` bag (the flexible, already-stored
 * field), so a later recall can trace a memory back to the requirement / task /
 * workflow / artifact it came from with no schema migration.
 */

function toolResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function toolError(toolName: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text" as const, text: `${toolName} failed: ${message}` }] };
}

export const memoryCreateRequirementToolSchema = {
  name: "memory_create_requirement",
  description:
    "Record a requirement (a structured unit of intent — title, optional description + acceptance criteria) into BrainRouter memory so it flows through recall/briefings. Pass provenance ids (requirementId/workflowId/taskId/artifactId) to link the memory back to the requirement record, workflow, task, and artifact it relates to. Returns {recordId, requirementId, provenance}.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string" },
      title: { type: "string", description: "The requirement, stated as a unit of intent." },
      description: { type: "string", description: "Optional fuller description / rationale." },
      acceptanceCriteria: { type: "array", items: { type: "string" }, description: "Optional acceptance criteria." },
      requirementId: { type: "string", description: "The requirement record id this memory represents (provenance)." },
      workflowId: { type: "string", description: "Workflow id this requirement belongs to (provenance)." },
      taskId: { type: "string", description: "Plan/task id this requirement seeded (provenance)." },
      artifactId: { type: "string", description: "Artifact id this requirement produced/relates to (provenance)." },
      sessionKey: { type: "string" },
      activeSkill: { type: "string", description: "Optional active skill/scene tag." },
      priority: { type: "number", description: "Recall priority 0-100 (default 80)." },
    },
    required: ["title"],
  },
} as const;

const schema = z.object({
  userId: z.string().optional(),
  title: z.string().min(3),
  description: z.string().optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  requirementId: z.string().optional(),
  workflowId: z.string().optional(),
  taskId: z.string().optional(),
  artifactId: z.string().optional(),
  sessionKey: z.string().optional(),
  activeSkill: z.string().optional(),
  priority: z.number().int().min(0).max(100).optional(),
});

/** Build the durable content blob from the requirement's parts. */
function buildContent(p: z.infer<typeof schema>): string {
  const lines = [`Requirement: ${p.title.trim()}`];
  if (p.description?.trim()) lines.push("", p.description.trim());
  const criteria = (p.acceptanceCriteria ?? []).map((c) => c.trim()).filter(Boolean);
  if (criteria.length) {
    lines.push("", "Acceptance criteria:");
    for (const c of criteria) lines.push(`- ${c}`);
  }
  return lines.join("\n");
}

/** Drop undefined provenance keys so the metadata bag only carries set ids. */
function provenance(p: z.infer<typeof schema>): Record<string, string> {
  const out: Record<string, string> = {};
  if (p.requirementId) out.requirementId = p.requirementId;
  if (p.workflowId) out.workflowId = p.workflowId;
  if (p.taskId) out.taskId = p.taskId;
  if (p.artifactId) out.artifactId = p.artifactId;
  return out;
}

export async function handleMemoryCreateRequirement(args: any, options?: { defaultUserId?: string }) {
  try {
    const params = schema.parse(args ?? {});
    const userId = params.userId ?? options?.defaultUserId ?? "default";
    const prov = provenance(params);
    const record = memoryEngine.upsertEngineeringMemory({
      userId,
      sessionKey: params.sessionKey,
      type: "task_state",
      content: buildContent(params),
      priority: params.priority ?? 80,
      activeSkill: params.activeSkill,
      sourceKind: "user_instruction",
      // Provenance ids ride in the persisted metadata bag — they LINK this
      // memory to the requirement/workflow/task/artifact it came from.
      metadata: { kind: "requirement", ...prov },
    });
    return toolResult({ recordId: record.id, requirementId: params.requirementId ?? null, provenance: prov });
  } catch (err) {
    return toolError("memory_create_requirement", err);
  }
}
