export const KNOWLEDGE_DOCUMENT_STATUSES = ["queued", "parsing", "ready", "failed"] as const;
export type KnowledgeDocumentStatus = (typeof KNOWLEDGE_DOCUMENT_STATUSES)[number];

export const KNOWLEDGE_SOURCE_FORMATS = ["text", "markdown"] as const;
export type KnowledgeSourceFormat = (typeof KNOWLEDGE_SOURCE_FORMATS)[number];

export const KNOWLEDGE_PARSE_VERSION = 1;
export const KNOWLEDGE_PARSE_JOB_KIND = `knowledge-parse-v${KNOWLEDGE_PARSE_VERSION}`;
export const MAX_KNOWLEDGE_TEXT_BYTES = 2 * 1024 * 1024;

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

export interface IngestKnowledgeTextInput {
  title: string;
  sourceName?: string;
  sourceFormat: KnowledgeSourceFormat;
  content: string;
}

export interface KnowledgeParseJobInput {
  orgId: string;
  projectId: string;
  baseId: string;
  documentId: string;
  parseVersion: number;
}

export interface KnowledgeDocumentEnqueueResult {
  document: KnowledgeDocumentRecord;
  created: boolean;
  jobId: string | null;
}

export type KnowledgeDocumentServiceFailure = {
  ok: false;
  code: "not_found" | "forbidden" | "invalid";
  field?: "baseId" | "title" | "sourceName" | "sourceFormat" | "content";
};

export type KnowledgeDocumentServiceResult<T> =
  | { ok: true; value: T }
  | KnowledgeDocumentServiceFailure;
