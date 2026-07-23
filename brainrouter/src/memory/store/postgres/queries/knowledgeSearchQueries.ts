import type {
  KnowledgeChunkSearchHit,
  KnowledgeLexicalSearchHit,
  KnowledgeSearchScope,
  KnowledgeVectorSearchHit,
  KnowledgeVectorSearchInput,
} from "../../../../knowledge/contracts/search.js";
import {
  DEFAULT_KNOWLEDGE_SEARCH_LIMIT,
  MAX_KNOWLEDGE_SEARCH_BASES,
  MAX_KNOWLEDGE_SEARCH_LIMIT,
  MAX_KNOWLEDGE_SEARCH_QUERY_CHARS,
} from "../../../../knowledge/contracts/search.js";
import { asNumber, ftsHasTerms, toVectorLiteral } from "../converters.js";
import type { Executor } from "./executor.js";

interface NormalizedScope {
  orgId: string;
  projectId: string;
  baseIds: string[] | null;
  limit: number;
}

function normalizeScope(scope: KnowledgeSearchScope): NormalizedScope | null {
  const orgId = scope.orgId.trim();
  const projectId = scope.projectId.trim();
  if (!orgId || !projectId) return null;

  const baseIds = [...new Set((scope.baseIds ?? []).map((value) => value.trim()).filter(Boolean))];
  if (baseIds.length > MAX_KNOWLEDGE_SEARCH_BASES) return null;

  const requestedLimit = scope.limit ?? DEFAULT_KNOWLEDGE_SEARCH_LIMIT;
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(MAX_KNOWLEDGE_SEARCH_LIMIT, Math.trunc(requestedLimit)))
    : DEFAULT_KNOWLEDGE_SEARCH_LIMIT;
  return { orgId, projectId, baseIds: baseIds.length > 0 ? baseIds : null, limit };
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function rowToHit(row: any): KnowledgeChunkSearchHit {
  return {
    chunkId: String(row.chunk_id),
    documentId: String(row.document_id),
    baseId: String(row.base_id),
    orgId: String(row.org_id),
    projectId: String(row.project_id),
    documentTitle: String(row.document_title),
    sourceName: String(row.source_name),
    ordinal: Number(row.ordinal),
    content: String(row.content),
    tokenCount: row.token_count == null ? null : Number(row.token_count),
    charStart: row.char_start == null ? null : Number(row.char_start),
    charEnd: row.char_end == null ? null : Number(row.char_end),
    locator: jsonObject(row.locator_json),
  };
}

const HIT_COLUMNS = `chunk.chunk_id, chunk.document_id, chunk.base_id,
  chunk.org_id, chunk.project_id, document.title AS document_title,
  document.source_name, chunk.ordinal, chunk.content, chunk.token_count,
  chunk.char_start, chunk.char_end, chunk.locator_json`;

const SCOPED_HIT_COLUMNS = `scoped.chunk_id, scoped.document_id, scoped.base_id,
  scoped.org_id, scoped.project_id, scoped.document_title, scoped.source_name,
  scoped.ordinal, scoped.content, scoped.token_count, scoped.char_start,
  scoped.char_end, scoped.locator_json`;

export async function searchKnowledgeChunksByText(
  exec: Executor,
  scope: KnowledgeSearchScope,
  query: string,
): Promise<KnowledgeLexicalSearchHit[]> {
  const normalized = normalizeScope(scope);
  const text = query.trim();
  if (!normalized || !ftsHasTerms(text) || text.length > MAX_KNOWLEDGE_SEARCH_QUERY_CHARS) return [];

  const rows = await exec.rows(
    `SELECT ${HIT_COLUMNS},
            ts_rank_cd(chunk.content_tsv, plainto_tsquery('english', $4)) AS text_rank
       FROM knowledge_chunks chunk
       JOIN knowledge_documents document
         ON document.document_id = chunk.document_id
        AND document.base_id = chunk.base_id
        AND document.org_id = chunk.org_id
        AND document.project_id = chunk.project_id
      WHERE chunk.org_id = $1 AND chunk.project_id = $2
        AND ($3::text[] IS NULL OR chunk.base_id = ANY($3::text[]))
        AND document.status = 'ready'
        AND chunk.content_tsv @@ plainto_tsquery('english', $4)
      ORDER BY text_rank DESC, chunk.document_id ASC, chunk.ordinal ASC, chunk.chunk_id ASC
      LIMIT $5`,
    [normalized.orgId, normalized.projectId, normalized.baseIds, text, normalized.limit],
  );
  return rows.map((row: any) => ({ ...rowToHit(row), textRank: asNumber(row.text_rank) }));
}

export async function searchKnowledgeChunksByVector(
  exec: Executor,
  scope: KnowledgeSearchScope,
  input: KnowledgeVectorSearchInput,
): Promise<KnowledgeVectorSearchHit[]> {
  const normalized = normalizeScope(scope);
  const embeddingModel = input.embeddingModel.trim();
  const embedding = Array.from(input.embedding);
  if (
    !normalized
    || !embeddingModel
    || embeddingModel.length > 256
    || !Number.isInteger(input.dimensions)
    || input.dimensions < 1
    || input.dimensions > 16_000
    || embedding.length !== input.dimensions
    || embedding.some((value) => !Number.isFinite(value))
  ) return [];

  const rows = await exec.rows(
    `WITH scoped AS MATERIALIZED (
       SELECT ${HIT_COLUMNS}, embedding.embedding
         FROM knowledge_chunk_embeddings embedding
         JOIN knowledge_chunks chunk
           ON chunk.chunk_id = embedding.chunk_id
          AND chunk.document_id = embedding.document_id
          AND chunk.base_id = embedding.base_id
          AND chunk.org_id = embedding.org_id
          AND chunk.project_id = embedding.project_id
         JOIN knowledge_documents document
           ON document.document_id = chunk.document_id
          AND document.base_id = chunk.base_id
          AND document.org_id = chunk.org_id
          AND document.project_id = chunk.project_id
        WHERE embedding.org_id = $1 AND embedding.project_id = $2
          AND ($3::text[] IS NULL OR embedding.base_id = ANY($3::text[]))
          AND embedding.embedding_model = $4 AND embedding.dimensions = $5
          AND document.status = 'ready'
     )
     SELECT ${SCOPED_HIT_COLUMNS},
            (scoped.embedding <=> $6::vector) AS distance
       FROM scoped
      ORDER BY distance ASC, document_id ASC, ordinal ASC, chunk_id ASC
      LIMIT $7`,
    [
      normalized.orgId,
      normalized.projectId,
      normalized.baseIds,
      embeddingModel,
      input.dimensions,
      toVectorLiteral(embedding),
      normalized.limit,
    ],
  );
  return rows.map((row: any) => ({
    ...rowToHit(row),
    vectorScore: 1 - asNumber(row.distance, 1),
  }));
}
