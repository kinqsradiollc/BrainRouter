import { createHash } from "node:crypto";
import type {
  ConnectorDocumentRecord,
  CognitiveRecord,
  MemoryVisibility,
  SourceDocumentKind,
} from "@kinqs/brainrouter-types";
import { connectorMemoryId } from "@kinqs/brainrouter-core/connectors";
import { ingestSource, type SourceIngestStore } from "../memory/source/ingest.js";
import { expandImportRecord, readImportChunkChars } from "../memory/pipeline/ingest/chunk-import.js";

export interface ConnectorKnowledgeScope {
  connectorId: string;
  userId: string;
  orgId?: string | null;
  visibility: MemoryVisibility;
  projectId?: string | null;
  workspaceTag?: string | null;
}

export interface ConnectorSourceStore extends SourceIngestStore {
  linkRecordSources(userId: string, recordId: string, chunkIds: string[]): Promise<void> | void;
}

function sourceKind(document: ConnectorDocumentRecord): SourceDocumentKind {
  return document.kind === "file" ? "file" : "imported_doc";
}

function sourceUri(document: ConnectorDocumentRecord): string | null {
  if (document.url?.trim()) return document.url.trim();
  return typeof document.metadata.path === "string" && document.metadata.path.trim()
    ? document.metadata.path.trim()
    : null;
}

function sourceHash(document: ConnectorDocumentRecord): string {
  // Include the external document id so two distinct issues/files with the same
  // text remain separately citable, while an unchanged document is idempotent.
  return createHash("sha256").update(`${document.id}\0${document.text}`).digest("hex");
}

/** Resolve the record ids importMemories will actually persist after chunking. */
export function connectorRecordIdsByDocument(
  memories: CognitiveRecord[],
  maxChars = readImportChunkChars(),
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const memory of memories) {
    const documentId = memory.metadata?.connectorDocumentId;
    if (typeof documentId !== "string" || !documentId) continue;
    result.set(documentId, expandImportRecord(memory, maxChars).map((record) => record.id));
  }
  return result;
}

/**
 * Mirror connector documents into the citable source layer, in the exact same
 * tenant scope as their imported cognitive records, then link each cognitive
 * record to the chunks created from its source document.
 */
export async function ingestConnectorSources(
  store: ConnectorSourceStore,
  documents: ConnectorDocumentRecord[],
  scope: ConnectorKnowledgeScope,
  memoryRecordIds?: ReadonlyMap<string, readonly string[]>,
): Promise<{ documents: number; chunks: number; links: number }> {
  let documentCount = 0;
  let chunkCount = 0;
  let linkCount = 0;

  for (const document of documents) {
    const result = await ingestSource(store, {
      userId: scope.userId,
      orgId: scope.orgId ?? null,
      projectId: scope.projectId ?? null,
      workspaceTag: scope.workspaceTag ?? null,
      kind: sourceKind(document),
      uri: sourceUri(document),
      hash: sourceHash(document),
      title: document.title,
      metadata: {
        connectorId: scope.connectorId,
        connectorDocumentId: document.id,
        connectorRuntimeId: document.connectorId,
        connectorSource: document.source,
        connectorKind: document.kind,
        repository: document.repository ?? null,
        visibility: scope.visibility,
      },
    }, document.text);

    documentCount += 1;
    chunkCount += result.chunks.length;
    if (result.chunks.length > 0) {
      const recordIds = memoryRecordIds?.get(document.id) ?? [connectorMemoryId(document.id)];
      for (const recordId of recordIds) {
        await store.linkRecordSources(
          scope.userId,
          recordId,
          result.chunks.map((chunk) => chunk.id),
        );
        linkCount += 1;
      }
    }
  }

  return { documents: documentCount, chunks: chunkCount, links: linkCount };
}
