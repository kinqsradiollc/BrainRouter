import type { CognitiveRecord, MemoryEvidence } from "@kinqs/brainrouter-types";

/**
 * MAS-P6-T2 (0.4.2) — pure provenance assembly, kept free of any
 * `memoryEngine`/`node:sqlite` import so it unit-tests under vitest.
 */

export interface ProvenanceView {
  found: boolean;
  recordId: string;
  type?: string;
  status?: string;
  /** active status AND not superseded. */
  active?: boolean;
  sourceKind?: string;
  verificationStatus?: string;
  confidence?: number;
  citationCount?: number;
  createdTime?: string;
  contentPreview?: string;
  evidence: Array<{ kind: string; ref: string }>;
  supersededBy?: { recordId: string; preview: string } | null;
}

export function previewText(text: string, max = 160): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : t.slice(0, max - 1) + "…";
}

/** Assemble a provenance view from a record + its evidence + (optional) successor. */
export function buildProvenanceView(
  recordId: string,
  record: CognitiveRecord | null,
  evidence: MemoryEvidence[],
  successor: CognitiveRecord | null,
): ProvenanceView {
  if (!record) {
    return { found: false, recordId, evidence: [] };
  }
  return {
    found: true,
    recordId: record.id,
    type: record.type,
    status: record.status,
    active: record.status === "active" && !record.supersededBy,
    sourceKind: record.sourceKind || undefined,
    verificationStatus: record.verificationStatus || undefined,
    confidence: record.confidence,
    citationCount: record.citationCount,
    createdTime: record.createdTime,
    contentPreview: previewText(record.content),
    evidence: evidence.map((e) => ({ kind: e.kind, ref: e.ref })),
    supersededBy: record.supersededBy
      ? { recordId: record.supersededBy, preview: successor ? previewText(successor.content) : "(successor not found)" }
      : null,
  };
}
