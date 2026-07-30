export const DEFAULT_KNOWLEDGE_SEARCH_LIMIT = 20;
export const MAX_KNOWLEDGE_SEARCH_LIMIT = 100;
export const MAX_KNOWLEDGE_SEARCH_BASES = 100;
export const MAX_KNOWLEDGE_SEARCH_QUERY_CHARS = 4_000;
export const KNOWLEDGE_SEARCH_RRF_K = 60;

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

export interface SearchKnowledgeInput {
  query: string;
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

export interface KnowledgeSearchResultHit {
  content: string;
  score: number;
  matchedBy: Array<"lexical" | "vector">;
  citation: KnowledgeSearchCitation;
}

export interface KnowledgeSearchResult {
  mode: "lexical" | "vector" | "hybrid";
  hits: KnowledgeSearchResultHit[];
}

export type KnowledgeSearchServiceFailure = {
  ok: false;
  code: "not_found" | "forbidden" | "invalid";
  field?: "query" | "baseIds" | "limit";
};

export type KnowledgeSearchServiceResult<T> =
  | { ok: true; value: T }
  | KnowledgeSearchServiceFailure;
