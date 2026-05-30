import type { SourceDocument, SourceChunk } from "@kinqs/brainrouter-types";
import { chunkSource, type ChunkOptions } from "./chunker.js";

/**
 * 0.4.3 Brain Phase 2 (MEM-2) — ingest a source in one call: create (or reuse,
 * by user+hash) the source document, then chunk its text and store the chunks.
 *
 * Store-agnostic (structural interface) so it's decoupled from the SQLite
 * store and unit-testable with a fake. Idempotent: re-ingesting a document
 * that already has chunks returns the existing ones rather than duplicating —
 * this is what makes re-capture / vault re-sync safe.
 */
export interface SourceIngestStore {
  createSourceDocument(
    input: Omit<SourceDocument, "id" | "createdAt"> & { id?: string; createdAt?: string },
  ): SourceDocument;
  getSourceChunksByDocument(documentId: string): SourceChunk[];
  addSourceChunks(documentId: string, chunks: ReturnType<typeof chunkSource>): SourceChunk[];
}

export function ingestSource(
  store: SourceIngestStore,
  doc: Omit<SourceDocument, "id" | "createdAt"> & { id?: string; createdAt?: string },
  text: string,
  opts?: ChunkOptions,
): { document: SourceDocument; chunks: SourceChunk[] } {
  const document = store.createSourceDocument(doc);
  // Idempotent: if this document already has chunks (re-ingest of identical
  // content via the user+hash dedup), reuse them — don't double-chunk.
  const existing = store.getSourceChunksByDocument(document.id);
  if (existing.length > 0) return { document, chunks: existing };
  const chunks = store.addSourceChunks(document.id, chunkSource(text, opts));
  return { document, chunks };
}
