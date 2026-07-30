import type {
  KnowledgeBaseRecord,
  UpdateKnowledgeBaseInput,
} from "./contracts/base.js";
import type {
  KnowledgeDocumentListFilters,
  KnowledgeDocumentEnqueueResult,
  KnowledgeDerivedDocumentInput,
  KnowledgeDerivedDocumentResult,
  KnowledgeDocumentRecord,
  KnowledgeDocumentStatusUpdate,
  KnowledgeDocumentProcessingRecord,
  KnowledgeDocumentRetryRecord,
  KnowledgeChunkInput,
  KnowledgeChunkEmbeddingInput,
  KnowledgeChunkRecord,
  KnowledgeParseCommitResult,
  KnowledgeParseJobInput,
} from "./contracts/document.js";
import type { KnowledgeProjectAccessStore } from "./services/project-access.js";
import type {
  KnowledgeLexicalSearchHit,
  KnowledgeSearchScope,
  KnowledgeVectorSearchHit,
  KnowledgeVectorSearchInput,
} from "./contracts/search.js";

export interface KnowledgeBaseStore extends KnowledgeProjectAccessStore {
  createKnowledgeBase(record: KnowledgeBaseRecord): Promise<void>;
  getKnowledgeBase(baseId: string, orgId: string, projectId: string): Promise<KnowledgeBaseRecord | null>;
  listKnowledgeBases(orgId: string, projectId: string): Promise<KnowledgeBaseRecord[]>;
  updateKnowledgeBase(
    baseId: string,
    orgId: string,
    projectId: string,
    patch: UpdateKnowledgeBaseInput & { updatedAt: string },
  ): Promise<KnowledgeBaseRecord | null>;
  deleteKnowledgeBase(baseId: string, orgId: string, projectId: string): Promise<boolean>;
}

export interface KnowledgeDocumentStore extends KnowledgeBaseStore {
  searchKnowledgeChunksByText(
    scope: KnowledgeSearchScope,
    query: string,
  ): Promise<KnowledgeLexicalSearchHit[]>;
  searchKnowledgeChunksByVector(
    scope: KnowledgeSearchScope,
    input: KnowledgeVectorSearchInput,
  ): Promise<KnowledgeVectorSearchHit[]>;
  enqueueKnowledgeDocument(
    record: KnowledgeDocumentRecord,
    jobId: string,
  ): Promise<KnowledgeDocumentEnqueueResult>;
  enqueueDerivedKnowledgeDocuments(
    inputs: KnowledgeDerivedDocumentInput[],
  ): Promise<KnowledgeDerivedDocumentResult[]>;
  markKnowledgeDocumentParsing(
    input: KnowledgeParseJobInput,
    updatedAt: string,
  ): Promise<KnowledgeDocumentRecord | null>;
  commitKnowledgeDocumentParse(
    input: KnowledgeParseJobInput,
    chunks: KnowledgeChunkInput[],
    readyAt: string,
  ): Promise<KnowledgeParseCommitResult | null>;
  failKnowledgeDocumentParse(
    input: KnowledgeParseJobInput,
    statusMessage: string,
    updatedAt: string,
  ): Promise<KnowledgeDocumentRecord | null>;
  listKnowledgeChunks(
    documentId: string,
    baseId: string,
    orgId: string,
    projectId: string,
  ): Promise<KnowledgeChunkRecord[]>;
  upsertKnowledgeChunkEmbeddings(
    input: KnowledgeParseJobInput,
    embeddings: KnowledgeChunkEmbeddingInput[],
    updatedAt: string,
  ): Promise<number>;
  getKnowledgeDocumentProcessing(
    input: KnowledgeParseJobInput,
  ): Promise<KnowledgeDocumentProcessingRecord | null>;
  retryKnowledgeDocumentProcessing(
    input: KnowledgeParseJobInput,
    jobId: string,
    now: string,
  ): Promise<KnowledgeDocumentRetryRecord | null>;
  createKnowledgeDocument(record: KnowledgeDocumentRecord): Promise<void>;
  getKnowledgeDocument(
    documentId: string,
    baseId: string,
    orgId: string,
    projectId: string,
  ): Promise<KnowledgeDocumentRecord | null>;
  listKnowledgeDocumentSourceIds(
    derivedDocumentId: string,
    baseId: string,
    orgId: string,
    projectId: string,
  ): Promise<string[]>;
  getKnowledgeDocumentByContentHash(
    contentSha256: string,
    baseId: string,
    orgId: string,
    projectId: string,
  ): Promise<KnowledgeDocumentRecord | null>;
  listKnowledgeDocuments(
    baseId: string,
    orgId: string,
    projectId: string,
    filters?: KnowledgeDocumentListFilters,
  ): Promise<KnowledgeDocumentRecord[]>;
  updateKnowledgeDocumentStatus(
    documentId: string,
    baseId: string,
    orgId: string,
    projectId: string,
    update: KnowledgeDocumentStatusUpdate,
  ): Promise<KnowledgeDocumentRecord | null>;
}
