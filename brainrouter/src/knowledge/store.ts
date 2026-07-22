import type {
  KnowledgeBaseRecord,
  UpdateKnowledgeBaseInput,
} from "./contracts/base.js";
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
