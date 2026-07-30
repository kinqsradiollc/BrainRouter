export interface KnowledgeBaseRecord {
  baseId: string;
  orgId: string;
  projectId: string;
  name: string;
  description: string;
  createdBy: string;
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

export type KnowledgeServiceFailure = {
  ok: false;
  code: "not_found" | "forbidden" | "invalid" | "conflict";
  field?: "name" | "description" | "baseId" | "patch";
};

export type KnowledgeServiceResult<T> = { ok: true; value: T } | KnowledgeServiceFailure;
