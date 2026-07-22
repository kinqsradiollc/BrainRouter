export const KNOWLEDGE_DOCUMENT_STATUSES = ["queued", "parsing", "ready", "failed"] as const;
export type KnowledgeDocumentStatus = (typeof KNOWLEDGE_DOCUMENT_STATUSES)[number];

export const KNOWLEDGE_SOURCE_FORMATS = ["text", "markdown"] as const;
export type KnowledgeSourceFormat = (typeof KNOWLEDGE_SOURCE_FORMATS)[number];

export interface KnowledgeDocumentRecord {
  documentId: string;
  baseId: string;
  orgId: string;
  projectId: string;
  title: string;
  sourceName: string;
  sourceFormat: KnowledgeSourceFormat;
  /** Normalized and redacted content only; raw ingest payloads are never stored. */
  contentText: string;
  contentSha256: string;
  status: KnowledgeDocumentStatus;
  statusMessage: string | null;
  parseVersion: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  readyAt: string | null;
}

export interface KnowledgeDocumentListFilters {
  status?: KnowledgeDocumentStatus;
  limit?: number;
}

export interface KnowledgeDocumentStatusUpdate {
  status: KnowledgeDocumentStatus;
  statusMessage: string | null;
  updatedAt: string;
  readyAt: string | null;
}
