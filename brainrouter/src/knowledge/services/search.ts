import { canUseKnowledge } from "../contracts/actor.js";
import type { KnowledgeActor } from "../contracts/actor.js";
import type {
  KnowledgeChunkSearchHit,
  KnowledgeLexicalSearchHit,
  KnowledgeSearchResult,
  KnowledgeSearchResultHit,
  KnowledgeSearchServiceFailure,
  KnowledgeSearchServiceResult,
  KnowledgeVectorSearchHit,
  SearchKnowledgeInput,
} from "../contracts/search.js";
import {
  DEFAULT_KNOWLEDGE_SEARCH_LIMIT,
  KNOWLEDGE_SEARCH_RRF_K,
  MAX_KNOWLEDGE_SEARCH_BASES,
  MAX_KNOWLEDGE_SEARCH_LIMIT,
  MAX_KNOWLEDGE_SEARCH_QUERY_CHARS,
} from "../contracts/search.js";
import type { KnowledgeDocumentStore } from "../store.js";
import type { KnowledgeEmbeddingProvider } from "./parse-processor.js";
import { resolveKnowledgeProject } from "./project-access.js";

const NOT_FOUND: KnowledgeSearchServiceFailure = { ok: false, code: "not_found" };
const FORBIDDEN: KnowledgeSearchServiceFailure = { ok: false, code: "forbidden" };
const MAX_SCOPE_ID_LENGTH = 512;
const MAX_EMBEDDING_DIMENSIONS = 16_000;
const MAX_LOCATOR_STRING_LENGTH = 500;
const SAFE_LOCATOR_KEYS = new Set([
  "sourceFormat",
  "section",
  "heading",
  "sheet",
  "page",
  "pageStart",
  "pageEnd",
  "startLine",
  "endLine",
]);

export interface KnowledgeSearchServiceOptions {
  resolveEmbeddingProvider?: (orgId: string) => Promise<KnowledgeEmbeddingProvider | null>;
}

interface NormalizedSearch {
  query: string;
  baseIds: string[];
  limit: number;
  candidateLimit: number;
}

interface FusedCandidate {
  hit: KnowledgeChunkSearchHit;
  score: number;
  bestRank: number;
  lexical: boolean;
  vector: boolean;
}

export class KnowledgeSearchService {
  readonly #resolveEmbeddingProvider?: KnowledgeSearchServiceOptions["resolveEmbeddingProvider"];

  constructor(
    private readonly store: KnowledgeDocumentStore,
    options: KnowledgeSearchServiceOptions = {},
  ) {
    this.#resolveEmbeddingProvider = options.resolveEmbeddingProvider;
  }

  async search(
    actor: KnowledgeActor,
    projectId: string,
    input: SearchKnowledgeInput,
  ): Promise<KnowledgeSearchServiceResult<KnowledgeSearchResult>> {
    const project = await resolveKnowledgeProject(actor, projectId, this.store);
    if (!project) return NOT_FOUND;
    if (!canUseKnowledge(actor, "read")) return FORBIDDEN;

    const normalized = normalizeSearch(input);
    if (!normalized.ok) return normalized;
    if (normalized.value.baseIds.length > 0) {
      const bases = await this.store.listKnowledgeBases(actor.orgId, project.projectId);
      const available = new Set(bases.map((base) => base.baseId));
      if (normalized.value.baseIds.some((baseId) => !available.has(baseId))) return NOT_FOUND;
    }

    const scope = {
      orgId: actor.orgId,
      projectId: project.projectId,
      baseIds: normalized.value.baseIds,
      limit: normalized.value.candidateLimit,
    };
    const [lexical, vector] = await Promise.all([
      this.store.searchKnowledgeChunksByText(scope, normalized.value.query),
      this.#vectorCandidates(actor.orgId, scope, normalized.value.query),
    ]);
    return {
      ok: true,
      value: {
        mode: retrievalMode(lexical, vector),
        hits: fuseCandidates(lexical, vector, normalized.value.limit),
      },
    };
  }

  async #vectorCandidates(
    orgId: string,
    scope: { orgId: string; projectId: string; baseIds: string[]; limit: number },
    query: string,
  ): Promise<KnowledgeVectorSearchHit[]> {
    if (!this.#resolveEmbeddingProvider) return [];
    try {
      const provider = await this.#resolveEmbeddingProvider(orgId);
      if (!provider) return [];
      const embeddingModel = provider.model.trim();
      const embedding = await provider.embed(query);
      if (!embeddingModel || embeddingModel.length > 256
        || embedding.length < 1 || embedding.length > MAX_EMBEDDING_DIMENSIONS
        || Array.from(embedding).some((value) => !Number.isFinite(value))) {
        return [];
      }
      return await this.store.searchKnowledgeChunksByVector(scope, {
        embeddingModel,
        dimensions: embedding.length,
        embedding,
      });
    } catch {
      return [];
    }
  }
}

function normalizeSearch(
  input: SearchKnowledgeInput,
): KnowledgeSearchServiceResult<NormalizedSearch> {
  if (typeof input.query !== "string") {
    return { ok: false, code: "invalid", field: "query" };
  }
  const query = input.query.trim();
  if (!query || query.length > MAX_KNOWLEDGE_SEARCH_QUERY_CHARS) {
    return { ok: false, code: "invalid", field: "query" };
  }
  if (input.baseIds !== undefined && !Array.isArray(input.baseIds)) {
    return { ok: false, code: "invalid", field: "baseIds" };
  }
  const baseIds: string[] = [];
  const seen = new Set<string>();
  for (const value of input.baseIds ?? []) {
    if (typeof value !== "string") {
      return { ok: false, code: "invalid", field: "baseIds" };
    }
    const baseId = value.trim();
    if (!baseId || baseId.length > MAX_SCOPE_ID_LENGTH) {
      return { ok: false, code: "invalid", field: "baseIds" };
    }
    if (!seen.has(baseId)) {
      seen.add(baseId);
      baseIds.push(baseId);
    }
  }
  if (baseIds.length > MAX_KNOWLEDGE_SEARCH_BASES) {
    return { ok: false, code: "invalid", field: "baseIds" };
  }

  const requestedLimit = input.limit ?? DEFAULT_KNOWLEDGE_SEARCH_LIMIT;
  if (!Number.isInteger(requestedLimit)
    || requestedLimit < 1
    || requestedLimit > MAX_KNOWLEDGE_SEARCH_LIMIT) {
    return { ok: false, code: "invalid", field: "limit" };
  }
  const limit = requestedLimit;
  const candidateLimit = Math.min(MAX_KNOWLEDGE_SEARCH_LIMIT, Math.max(20, limit * 4));
  return { ok: true, value: { query, baseIds, limit, candidateLimit } };
}

export function fuseCandidates(
  lexical: KnowledgeLexicalSearchHit[],
  vector: KnowledgeVectorSearchHit[],
  limit: number,
): KnowledgeSearchResultHit[] {
  const fused = new Map<string, FusedCandidate>();
  addRanked(fused, lexical, "lexical");
  addRanked(fused, vector, "vector");
  return [...fused.values()]
    .sort((left, right) => right.score - left.score
      || left.bestRank - right.bestRank
      || left.hit.documentId.localeCompare(right.hit.documentId)
      || left.hit.ordinal - right.hit.ordinal
      || left.hit.chunkId.localeCompare(right.hit.chunkId))
    .slice(0, Math.max(0, limit))
    .map(toResultHit);
}

function addRanked(
  fused: Map<string, FusedCandidate>,
  hits: Array<KnowledgeLexicalSearchHit | KnowledgeVectorSearchHit>,
  source: "lexical" | "vector",
): void {
  hits.forEach((hit, index) => {
    const rank = index + 1;
    const existing = fused.get(hit.chunkId);
    if (existing) {
      existing.score += 1 / (KNOWLEDGE_SEARCH_RRF_K + rank);
      existing.bestRank = Math.min(existing.bestRank, rank);
      existing[source] = true;
      return;
    }
    fused.set(hit.chunkId, {
      hit,
      score: 1 / (KNOWLEDGE_SEARCH_RRF_K + rank),
      bestRank: rank,
      lexical: source === "lexical",
      vector: source === "vector",
    });
  });
}

function toResultHit(candidate: FusedCandidate): KnowledgeSearchResultHit {
  const { hit } = candidate;
  return {
    content: hit.content,
    score: candidate.score,
    matchedBy: [
      ...(candidate.lexical ? ["lexical" as const] : []),
      ...(candidate.vector ? ["vector" as const] : []),
    ],
    citation: {
      projectId: hit.projectId,
      baseId: hit.baseId,
      documentId: hit.documentId,
      chunkId: hit.chunkId,
      documentTitle: hit.documentTitle,
      sourceName: hit.sourceName,
      ordinal: hit.ordinal,
      charStart: hit.charStart,
      charEnd: hit.charEnd,
      locator: safeCitationLocator(hit.locator),
    },
  };
}

function safeCitationLocator(locator: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(locator)) {
    if (!SAFE_LOCATOR_KEYS.has(key)) continue;
    if (typeof value === "string") {
      const normalized = value.trim();
      if (normalized && normalized.length <= MAX_LOCATOR_STRING_LENGTH) safe[key] = normalized;
    } else if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
      safe[key] = value;
    }
  }
  return safe;
}

function retrievalMode(
  lexical: KnowledgeLexicalSearchHit[],
  vector: KnowledgeVectorSearchHit[],
): KnowledgeSearchResult["mode"] {
  if (lexical.length > 0 && vector.length > 0) return "hybrid";
  return vector.length > 0 ? "vector" : "lexical";
}
