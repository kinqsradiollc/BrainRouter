import { z } from "zod";
import { memoryEngine } from "../../memory/engine.js";

/**
 * §ANNOTATION-LINK (0.4.15) — `memory_capture_annotation`: capture an Annotation
 * Record (a code-anchored note / review comment / artifact annotation) into
 * BrainRouter memory as a first-class cognitive record, symmetric with
 * `memory_create_requirement` / `memory_capture_artifact`. Provenance ids
 * (annotationId, the anchored targetKind/targetId, artifactId/requirementId/
 * taskId) + the anchor's file:line ride in the persisted `metadata` bag
 * (kind:'annotation'), so recall can trace a memory back to the annotation and
 * the file under discussion. The CLI/desktop annotation store links the returned
 * `recordId` into the annotation's `linkedMemoryIds`.
 *
 * SESSION-SCOPED: stamped with the originating `sessionKey`; the recall pipeline
 * confines kind:'annotation' records to their origin session.
 */

function toolResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function toolError(toolName: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text" as const, text: `${toolName} failed: ${message}` }] };
}

export const memoryCaptureAnnotationToolSchema = {
  name: "memory_capture_annotation",
  description:
    "Capture an annotation (a code-anchored note / review comment / artifact annotation) into BrainRouter memory so it flows through recall/briefings. Pass provenance ids (annotationId, targetKind/targetId, artifactId/requirementId/taskId) and the anchor file:line to link the memory back. The record is session-scoped (stamped with sessionKey). Returns {recordId, annotationId, provenance}.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string" },
      title: { type: "string", description: "Short summary of the annotation." },
      body: { type: "string", description: "Optional annotation body / the note text." },
      annotationId: { type: "string", description: "Annotation record id (provenance)." },
      targetKind: { type: "string", description: "What it anchors to (code, artifact, requirement, …)." },
      targetId: { type: "string", description: "Target id (e.g. artifact id, requirement id)." },
      artifactId: { type: "string", description: "Artifact id this annotation relates to (provenance)." },
      requirementId: { type: "string", description: "Requirement id (provenance)." },
      taskId: { type: "string", description: "Plan/task id (provenance)." },
      filePath: { type: "string", description: "Anchored file path, when code-anchored." },
      startLine: { type: "number", description: "Anchor start line." },
      endLine: { type: "number", description: "Anchor end line." },
      severity: { type: "string", description: "Optional severity (info, warning, blocker, …)." },
      status: { type: "string", description: "Annotation status (open, resolved, …)." },
      sessionKey: { type: "string", description: "Originating session — scopes recall to this session." },
      activeSkill: { type: "string", description: "Optional active skill/scene tag." },
      priority: { type: "number", description: "Recall priority 0-100 (default 70)." },
    },
    required: ["title"],
  },
} as const;

const schema = z.object({
  userId: z.string().optional(),
  title: z.string().min(1),
  body: z.string().optional(),
  annotationId: z.string().optional(),
  targetKind: z.string().optional(),
  targetId: z.string().optional(),
  artifactId: z.string().optional(),
  requirementId: z.string().optional(),
  taskId: z.string().optional(),
  filePath: z.string().optional(),
  startLine: z.number().int().optional(),
  endLine: z.number().int().optional(),
  severity: z.string().optional(),
  status: z.string().optional(),
  sessionKey: z.string().optional(),
  activeSkill: z.string().optional(),
  priority: z.number().int().min(0).max(100).optional(),
});

/** Build the durable content blob from the annotation's parts. */
function buildContent(p: z.infer<typeof schema>): string {
  const anchor = p.filePath
    ? `${p.filePath}${typeof p.startLine === "number" ? `:${p.startLine}${typeof p.endLine === "number" && p.endLine !== p.startLine ? `-${p.endLine}` : ""}` : ""}`
    : p.targetKind && p.targetId
      ? `${p.targetKind} ${p.targetId}`
      : "";
  const head = `Annotation: ${p.title.trim()}${anchor ? ` @ ${anchor}` : ""}${p.severity ? ` [${p.severity}]` : ""}`;
  const lines = [head];
  if (p.body?.trim()) lines.push("", p.body.trim());
  return lines.join("\n");
}

/** Drop undefined provenance keys so the metadata bag only carries set ids. */
function provenance(p: z.infer<typeof schema>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (p.annotationId) out.annotationId = p.annotationId;
  if (p.targetKind) out.targetKind = p.targetKind;
  if (p.targetId) out.targetId = p.targetId;
  if (p.artifactId) out.artifactId = p.artifactId;
  if (p.requirementId) out.requirementId = p.requirementId;
  if (p.taskId) out.taskId = p.taskId;
  if (p.filePath) out.filePath = p.filePath;
  if (typeof p.startLine === "number") out.startLine = p.startLine;
  if (typeof p.endLine === "number") out.endLine = p.endLine;
  if (p.severity) out.severity = p.severity;
  if (p.status) out.status = p.status;
  return out;
}

export async function handleMemoryCaptureAnnotation(args: any, options?: { defaultUserId?: string }) {
  try {
    const params = schema.parse(args ?? {});
    const userId = params.userId ?? options?.defaultUserId ?? "default";
    const prov = provenance(params);
    const record = await memoryEngine.upsertEngineeringMemory({
      userId,
      sessionKey: params.sessionKey,
      type: "review_comment",
      content: buildContent(params),
      priority: params.priority ?? 70,
      activeSkill: params.activeSkill,
      sourceKind: "model_inference",
      filePaths: params.filePath ? [params.filePath] : [],
      // Provenance + anchor ride in the persisted metadata bag. `kind:'annotation'`
      // marks this as a session-scoped annotation record so the recall pipeline
      // confines it to its origin session.
      metadata: { kind: "annotation", ...prov },
    });
    return toolResult({ recordId: record.id, annotationId: params.annotationId ?? null, provenance: prov });
  } catch (err) {
    return toolError("memory_capture_annotation", err);
  }
}
