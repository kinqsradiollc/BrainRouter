import { z } from "zod";
import { memoryEngine } from "../memory/engine.js";

/**
 * §ARTIFACT-LINK (0.4.15) — `memory_capture_artifact`: capture an Artifact
 * Record (design note, sketch, prototype, report, verification/review export)
 * into BrainRouter memory as a first-class cognitive record, symmetric with
 * `memory_create_requirement`. The artifact's provenance ids
 * (artifactId/requirementId/taskId/workflowId) ride in the persisted `metadata`
 * bag (kind:'artifact'), so a later recall can trace a memory back to the
 * artifact it came from with no schema migration. The CLI/desktop artifact store
 * links the returned `recordId` into the artifact's `linkedMemoryIds`.
 *
 * SESSION-SCOPED: the record is stamped with the originating `sessionKey`; the
 * recall pipeline confines kind:'artifact' records to their origin session so an
 * artifact made in one chat does not surface in another session's briefing.
 */

function toolResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function toolError(toolName: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text" as const, text: `${toolName} failed: ${message}` }] };
}

export const memoryCaptureArtifactToolSchema = {
  name: "memory_capture_artifact",
  description:
    "Capture an artifact (design note, sketch, prototype, report, review/verification export) into BrainRouter memory so it flows through recall/briefings. Pass provenance ids (artifactId/requirementId/taskId/workflowId) to link the memory back to the artifact and the work it belongs to. The record is session-scoped (stamped with sessionKey). Returns {recordId, artifactId, provenance}.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string" },
      title: { type: "string", description: "The artifact title." },
      summary: { type: "string", description: "Optional short summary / content excerpt." },
      artifactKind: { type: "string", description: "Artifact kind (design-note, sketch, html-prototype, markdown-report, …)." },
      format: { type: "string", description: "Render format (markdown, html, svg, mermaid, code, …)." },
      status: { type: "string", description: "Artifact status (draft, final, archived)." },
      artifactId: { type: "string", description: "Artifact record id (provenance)." },
      requirementId: { type: "string", description: "Requirement id this artifact supports (provenance)." },
      workflowId: { type: "string", description: "Workflow id this artifact belongs to (provenance)." },
      taskId: { type: "string", description: "Plan/task id this artifact relates to (provenance)." },
      sessionKey: { type: "string", description: "Originating session — scopes recall to this session." },
      activeSkill: { type: "string", description: "Optional active skill/scene tag." },
      priority: { type: "number", description: "Recall priority 0-100 (default 75)." },
    },
    required: ["title"],
  },
} as const;

const schema = z.object({
  userId: z.string().optional(),
  title: z.string().min(1),
  summary: z.string().optional(),
  artifactKind: z.string().optional(),
  format: z.string().optional(),
  status: z.string().optional(),
  artifactId: z.string().optional(),
  requirementId: z.string().optional(),
  workflowId: z.string().optional(),
  taskId: z.string().optional(),
  sessionKey: z.string().optional(),
  activeSkill: z.string().optional(),
  priority: z.number().int().min(0).max(100).optional(),
});

/** Build the durable content blob from the artifact's parts. */
function buildContent(p: z.infer<typeof schema>): string {
  const tags = [p.artifactKind, p.format, p.status].map((t) => t?.trim()).filter(Boolean);
  const lines = [`Artifact: ${p.title.trim()}${tags.length ? ` (${tags.join(" · ")})` : ""}`];
  if (p.summary?.trim()) lines.push("", p.summary.trim());
  return lines.join("\n");
}

/** Drop undefined provenance keys so the metadata bag only carries set ids. */
function provenance(p: z.infer<typeof schema>): Record<string, string> {
  const out: Record<string, string> = {};
  if (p.artifactId) out.artifactId = p.artifactId;
  if (p.requirementId) out.requirementId = p.requirementId;
  if (p.workflowId) out.workflowId = p.workflowId;
  if (p.taskId) out.taskId = p.taskId;
  return out;
}

export async function handleMemoryCaptureArtifact(args: any, options?: { defaultUserId?: string }) {
  try {
    const params = schema.parse(args ?? {});
    const userId = params.userId ?? options?.defaultUserId ?? "default";
    const prov = provenance(params);
    const record = memoryEngine.upsertEngineeringMemory({
      userId,
      sessionKey: params.sessionKey,
      type: "artifact_reference",
      content: buildContent(params),
      priority: params.priority ?? 75,
      activeSkill: params.activeSkill,
      sourceKind: "model_inference",
      // Provenance + the artifact's display tags ride in the persisted metadata
      // bag. `kind:'artifact'` marks this as a session-scoped artifact record so
      // the recall pipeline confines it to its origin session.
      metadata: {
        kind: "artifact",
        ...prov,
        ...(params.artifactKind ? { artifactKind: params.artifactKind } : {}),
        ...(params.format ? { format: params.format } : {}),
        ...(params.status ? { status: params.status } : {}),
      },
    });
    return toolResult({ recordId: record.id, artifactId: params.artifactId ?? null, provenance: prov });
  } catch (err) {
    return toolError("memory_capture_artifact", err);
  }
}
