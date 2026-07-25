export const KNOWLEDGE_DOCUMENT_STATUSES = ["queued", "parsing", "ready", "failed"] as const;
export type KnowledgeDocumentStatus = (typeof KNOWLEDGE_DOCUMENT_STATUSES)[number];

export const KNOWLEDGE_INLINE_SOURCE_FORMATS = ["text", "markdown", "html"] as const;
export type KnowledgeInlineSourceFormat = (typeof KNOWLEDGE_INLINE_SOURCE_FORMATS)[number];

export const KNOWLEDGE_SOURCE_FORMATS = [...KNOWLEDGE_INLINE_SOURCE_FORMATS, "pdf", "docx"] as const;
export type KnowledgeSourceFormat = (typeof KNOWLEDGE_SOURCE_FORMATS)[number];

export const KNOWLEDGE_PARSE_VERSION = 1;
export const KNOWLEDGE_PARSE_JOB_KIND = `knowledge-parse-v${KNOWLEDGE_PARSE_VERSION}`;
export const MAX_KNOWLEDGE_TEXT_BYTES = 2 * 1024 * 1024;
export const MAX_KNOWLEDGE_HTML_BYTES = 1 * 1024 * 1024;
export const MAX_KNOWLEDGE_PDF_BYTES = 2 * 1024 * 1024;
export const MAX_KNOWLEDGE_PDF_BASE64_CHARS = 4 * Math.ceil(MAX_KNOWLEDGE_PDF_BYTES / 3);
export const MAX_KNOWLEDGE_DOCX_BYTES = 4 * 1024 * 1024;
export const MAX_KNOWLEDGE_DOCX_BASE64_CHARS = 4 * Math.ceil(MAX_KNOWLEDGE_DOCX_BYTES / 3);

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
  sourceFormat: KnowledgeInlineSourceFormat;
  content: string;
}

export interface IngestKnowledgePdfInput {
  title: string;
  sourceName?: string;
  /** Canonical padded base64 only; data URLs and local paths are rejected. */
  contentBase64: string;
}

export interface IngestKnowledgeDocxInput {
  title: string;
  sourceName?: string;
  /** Canonical padded base64 only; data URLs and local paths are rejected. */
  contentBase64: string;
}

export interface KnowledgeParseJobInput {
  orgId: string;
  projectId: string;
  baseId: string;
  documentId: string;
  parseVersion: number;
}

export interface KnowledgeChunkInput {
  chunkId: string;
  ordinal: number;
  content: string;
  contentSha256: string;
  tokenCount: number;
  charStart: number | null;
  charEnd: number | null;
  locator: Record<string, unknown>;
}

export interface KnowledgeChunkRecord extends KnowledgeChunkInput {
  documentId: string;
  baseId: string;
  orgId: string;
  projectId: string;
  createdAt: string;
}

export interface KnowledgeChunkEmbeddingInput {
  chunkId: string;
  embeddingModel: string;
  dimensions: number;
  embedding: number[];
}

export interface KnowledgeParseCommitResult {
  document: KnowledgeDocumentRecord;
  chunksWritten: number;
  alreadyReady: boolean;
}

export interface KnowledgeDocumentEnqueueResult {
  document: KnowledgeDocumentRecord;
  created: boolean;
  jobId: string | null;
}

export const KNOWLEDGE_PROCESSING_JOB_STATES = [
  "missing", "pending", "running", "done", "failed", "cancelled",
] as const;
export type KnowledgeProcessingJobState = (typeof KNOWLEDGE_PROCESSING_JOB_STATES)[number];

export interface KnowledgeDocumentProcessingRecord {
  document: KnowledgeDocumentRecord;
  jobState: KnowledgeProcessingJobState;
  attempts: number;
  maxAttempts: number;
  chunkCount: number;
  embeddingCount: number;
}

/** Content-free view safe for authenticated client transports. */
export interface KnowledgeDocumentStatusView {
  documentId: string;
  title: string;
  sourceName: string;
  sourceFormat: KnowledgeSourceFormat;
  status: KnowledgeDocumentStatus;
  statusMessage: string | null;
  parseVersion: number;
  updatedAt: string;
  readyAt: string | null;
  processing: {
    jobState: KnowledgeProcessingJobState;
    attempts: number;
    maxAttempts: number;
    retryable: boolean;
    chunkCount: number;
    embeddingCount: number;
  };
}

export interface KnowledgeDocumentRetryRecord {
  document: KnowledgeDocumentRecord;
  jobState: "pending" | "running";
  enqueued: boolean;
}

export interface KnowledgeDocumentRetryView {
  documentId: string;
  jobState: "pending" | "running";
  enqueued: boolean;
}

export type KnowledgeDocumentServiceFailure = {
  ok: false;
  code: "not_found" | "forbidden" | "invalid";
  field?: "baseId" | "title" | "sourceName" | "sourceFormat" | "content" | "contentBase64";
};

export type KnowledgeDocumentServiceResult<T> =
  | { ok: true; value: T }
  | KnowledgeDocumentServiceFailure;
