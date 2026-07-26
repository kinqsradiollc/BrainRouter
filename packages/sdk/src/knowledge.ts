export interface BrainRouterRequestOptions {
  signal?: AbortSignal;
}

export type KnowledgeDocumentStatus = "queued" | "parsing" | "ready" | "failed";
export type KnowledgeInlineSourceFormat = "text" | "markdown" | "html";
export type KnowledgeSourceFormat = KnowledgeInlineSourceFormat | "pdf" | "docx";
export type KnowledgeDocumentOrigin = "source" | "derived";
export type KnowledgeProcessingJobState =
  | "missing"
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "cancelled";
export type KnowledgeSearchMode = "lexical" | "vector" | "hybrid";
export type KnowledgeSearchMatch = "lexical" | "vector";

export interface KnowledgeBase {
  baseId: string;
  projectId: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateKnowledgeBaseInput {
  name: string;
  description?: string;
}

export interface UpdateKnowledgeBaseInput {
  name?: string;
  description?: string;
}

export interface KnowledgeDocumentSummary {
  documentId: string;
  title: string;
  sourceName: string;
  sourceFormat: KnowledgeSourceFormat;
  origin: KnowledgeDocumentOrigin;
  status: KnowledgeDocumentStatus;
  statusMessage: string | null;
  parseVersion: number;
  createdAt: string;
  updatedAt: string;
  readyAt: string | null;
}

export interface ListKnowledgeDocumentsInput {
  status?: KnowledgeDocumentStatus;
  origin?: KnowledgeDocumentOrigin;
  limit?: number;
}

export interface IngestKnowledgeTextInput {
  title: string;
  sourceName?: string;
  sourceFormat: KnowledgeInlineSourceFormat;
  content: string;
}

export interface IngestKnowledgeBinaryInput {
  title: string;
  sourceName?: string;
  /** Canonical padded base64 without a data-URL prefix. */
  contentBase64: string;
}

export interface KnowledgeDocumentEnqueueView {
  documentId: string;
  title: string;
  sourceName: string;
  sourceFormat: KnowledgeSourceFormat;
  status: KnowledgeDocumentStatus;
  statusMessage: string | null;
  parseVersion: number;
  updatedAt: string;
  readyAt: string | null;
}

export interface KnowledgeDocumentStatusView extends KnowledgeDocumentEnqueueView {
  processing: {
    jobState: KnowledgeProcessingJobState;
    attempts: number;
    maxAttempts: number;
    retryable: boolean;
    chunkCount: number;
    embeddingCount: number;
  };
}

export interface KnowledgeDocumentRetryView {
  documentId: string;
  jobState: "pending" | "running";
  enqueued: boolean;
}

export interface SearchKnowledgeInput {
  query: string;
  /** Omit or pass an empty list to search every base in the Project. */
  baseIds?: readonly string[];
  limit?: number;
}

export interface KnowledgeSearchCitation {
  projectId: string;
  baseId: string;
  documentId: string;
  chunkId: string;
  documentTitle: string;
  sourceName: string;
  ordinal: number;
  charStart: number | null;
  charEnd: number | null;
  locator: Record<string, unknown>;
}

export interface KnowledgeSearchHit {
  content: string;
  score: number;
  matchedBy: KnowledgeSearchMatch[];
  citation: KnowledgeSearchCitation;
}

export interface KnowledgeSearchResult {
  mode: KnowledgeSearchMode;
  hits: KnowledgeSearchHit[];
}

export interface KnowledgeBasesResponse {
  bases: KnowledgeBase[];
}

export interface KnowledgeBaseResponse {
  base: KnowledgeBase;
}

export interface KnowledgeDocumentsResponse {
  documents: KnowledgeDocumentSummary[];
}

export interface KnowledgeDocumentEnqueueResponse {
  document: KnowledgeDocumentEnqueueView;
  created: boolean;
}

export interface KnowledgeDocumentStatusResponse {
  document: KnowledgeDocumentStatusView;
}

export interface KnowledgeDocumentRetryResponse {
  retry: KnowledgeDocumentRetryView;
}

export interface KnowledgeSearchResponse {
  search: KnowledgeSearchResult;
}
