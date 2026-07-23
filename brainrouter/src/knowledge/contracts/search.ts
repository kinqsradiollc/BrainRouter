export const DEFAULT_KNOWLEDGE_SEARCH_LIMIT = 20;
export const MAX_KNOWLEDGE_SEARCH_LIMIT = 100;
export const MAX_KNOWLEDGE_SEARCH_BASES = 100;
export const MAX_KNOWLEDGE_SEARCH_QUERY_CHARS = 4_000;

export interface KnowledgeSearchScope {
  orgId: string;
  projectId: string;
  /** Omit or pass an empty list to search every base in the Project. */
  baseIds?: readonly string[];
  limit?: number;
}

export interface KnowledgeChunkSearchHit {
  chunkId: string;
  documentId: string;
  baseId: string;
  orgId: string;
  projectId: string;
  documentTitle: string;
  sourceName: string;
  ordinal: number;
  content: string;
  tokenCount: number | null;
  charStart: number | null;
  charEnd: number | null;
  locator: Record<string, unknown>;
}

export interface KnowledgeLexicalSearchHit extends KnowledgeChunkSearchHit {
  textRank: number;
}

export interface KnowledgeVectorSearchHit extends KnowledgeChunkSearchHit {
  vectorScore: number;
}

export interface KnowledgeVectorSearchInput {
  embeddingModel: string;
  dimensions: number;
  embedding: ReadonlyArray<number> | Float32Array;
}
