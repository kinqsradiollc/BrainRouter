import { z } from "zod";
import { memoryEngine } from "../memory/engine.js";
import { buildProvenanceView } from "./provenance-view.js";
export { buildProvenanceView, type ProvenanceView } from "./provenance-view.js";

/**
 * MAS-P6-T2 (0.4.2) — `memory_provenance`: the "why does this memory
 * exist?" trail for one cognitive record. Powers the CLI's `/brain why
 * <memoryId>` (read-only — the CLI never reconstructs provenance locally).
 *
 * Assembles, from the record itself:
 *   - what it is (type / status / confidence / verification),
 *   - where it came from (sourceKind + supporting evidence refs),
 *   - whether it's still current (active = active status AND not superseded),
 *   - and, if superseded, a pointer + preview of the successor record.
 *
 * The assembly (`buildProvenanceView`) is pure so it unit-tests without a
 * live store; the handler is the thin store-read wrapper.
 */

function toolResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function toolError(toolName: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text" as const, text: `${toolName} failed: ${message}` }],
  };
}

export const memoryProvenanceToolSchema = {
  name: "memory_provenance",
  description:
    "Return the provenance trail for one cognitive memory record: what it is, where it came from (sourceKind + supporting evidence), whether it's still current, and the successor record if it was superseded. Read-only — powers `/brain why`.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string" },
      memoryId: { type: "string", description: "The cognitive record id to trace." },
    },
    required: ["memoryId"],
  },
} as const;

const schema = z.object({ userId: z.string().optional(), memoryId: z.string().min(1) });

export async function handleMemoryProvenance(args: any, options?: { defaultUserId?: string }) {
  try {
    const params = schema.parse(args ?? {});
    const userId = params.userId ?? options?.defaultUserId ?? "default";
    const record = memoryEngine.store.getMemoryById(userId, params.memoryId);
    const evidence = record ? memoryEngine.store.getEvidenceByRecord(userId, params.memoryId) : [];
    const successor = record?.supersededBy
      ? memoryEngine.store.getMemoryById(userId, record.supersededBy)
      : null;
    return toolResult(buildProvenanceView(params.memoryId, record, evidence, successor));
  } catch (err) {
    return toolError("memory_provenance", err);
  }
}
