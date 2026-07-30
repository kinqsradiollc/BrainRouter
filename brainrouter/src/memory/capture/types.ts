import type { BlackboardItem, BlackboardItemInput } from "@kinqs/brainrouter-types";

/**
 * MEM-2′ — minimum redacted-char length for a turn message to be worth
 * persisting as a source document (skips greetings / acks). ~30 tokens.
 */
export const MIN_SOURCE_CHARS = 120;

/**
 * MEM-3 — the store capability needed for batch-level provenance linking.
 * Structural (minimal shapes) so it stays decoupled from the concrete store
 * and is runtime-detected, like the source-ingest capability.
 */
export interface ProvenanceStore {
  getSourceDocumentByHash(
    userId: string,
    hash: string,
    scope?: { orgId?: string | null; projectId?: string | null; workspaceTag?: string | null },
  ): Promise<{ id: string } | null>;
  getSourceChunksByDocument(documentId: string): Promise<{ id: string; content: string }[]>;
  linkRecordSources(userId: string, recordId: string, chunkIds: string[]): Promise<void>;
}

/**
 * MEM-16 — the store capability needed to route extraction candidates through
 * the blackboard before they become cognitive records. Structural + runtime-
 * detected, like the source/provenance capabilities above.
 */
export interface BlackboardAdmissionStore {
  stageBlackboardItems(userId: string, items: BlackboardItemInput[]): Promise<BlackboardItem[]>;
  updateBlackboardItem(
    id: string,
    patch: { status?: BlackboardItem["status"]; conflictIds?: string[]; committedRecordId?: string | null },
  ): Promise<void>;
}
