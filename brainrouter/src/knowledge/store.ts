import type {
  KnowledgeBaseRecord,
  UpdateKnowledgeBaseInput,
} from "./contracts/base.js";
import type {
  KnowledgeDocumentListFilters,
  KnowledgeDocumentEnqueueResult,
  KnowledgeDocumentRecord,
  KnowledgeDocumentStatusUpdate,
  KnowledgeChunkInput,
  KnowledgeChunkRecord,
  KnowledgeParseCommitResult,
  KnowledgeParseJobInput,
} from "./contracts/document.js";
import type { KnowledgeProjectAccessStore } from "./services/project-access.js";

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
  enqueueKnowledgeDocument(
    record: KnowledgeDocumentRecord,
    jobId: string,
  ): Promise<KnowledgeDocumentEnqueueResult>;
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
  createKnowledgeDocument(record: KnowledgeDocumentRecord): Promise<void>;
  getKnowledgeDocument(
    documentId: string,
    baseId: string,
    orgId: string,
    projectId: string,
  ): Promise<KnowledgeDocumentRecord | null>;
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
