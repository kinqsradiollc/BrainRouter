/**
 * Full-text (tsvector + GIN) and vector (pgvector) search SQL — verbatim
 * extraction from `PostgresMemoryStore`.
 *
 * The vector methods reach back into the store's `vecReady`/`vecDimensions`
 * state and can trigger a re-`initVec`; that mutable state is threaded through a
 * tiny `VecContext` so behaviour is identical to the inline versions.
 */

import type {
  CognitiveFtsResult,
  VectorSearchResult,
} from "@kinqs/brainrouter-types";
import {
  toVectorLiteral,
  ftsHasTerms,
  tsRankToScore,
  asNumber,
} from "../converters.js";
import type { Executor } from "./executor.js";

/** Read/refresh access to the store's pgvector runtime state. */
export interface VecContext {
  readonly vecReady: boolean;
  readonly vecDimensions: number;
  initVec(dimensions: number): Promise<void>;
}

export async function searchCognitiveFts(exec: Executor, userId: string, query: string, limit: number, orgId?: string): Promise<CognitiveFtsResult[]> {
  if (!ftsHasTerms(query)) return [];
  // ADR-010 P5b — when the caller's org is known, ALSO retrieve org-shared records
  // (visibility='org') from that org, not just the caller's own. GATED: without
  // orgId the WHERE is unchanged (byte-identical to the user-only path). Final
  // per-member visibility is enforced in applyFilters (orgVisibilityAllows).
  const scope = orgId ? `(r.user_id = $1 OR (r.org_id = $4 AND r.visibility = 'org'))` : `r.user_id = $1`;
  const params = orgId ? [userId, query, limit, orgId] : [userId, query, limit];
  const rows = await exec.rows<any>(
    `SELECT r.record_id, r.user_id, r.org_id, r.visibility, r.content, r.type, r.priority, r.scene_name, r.skill_tag,
            r.session_key, r.timestamp_str, r.created_time, r.citation_count,
            ts_rank(r.content_tsv, plainto_tsquery('english', $2)) AS rank
       FROM cognitive_records r
      WHERE ${scope} AND r.content_tsv @@ plainto_tsquery('english', $2)
        AND r.invalid_at IS NULL AND r.archived = 0
      ORDER BY rank DESC
      LIMIT $3`,
    params,
  );
  return rows.map((r) => {
    const out: CognitiveFtsResult = {
      record_id: r.record_id, user_id: r.user_id, content: r.content, type: r.type,
      priority: asNumber(r.priority, 50), scene_name: r.scene_name, skill_tag: r.skill_tag,
      score: tsRankToScore(asNumber(r.rank)), timestamp_str: r.timestamp_str,
      timestamp_start: "", timestamp_end: "", session_key: r.session_key, session_id: "",
      metadata_json: "{}", created_time: r.created_time, citation_count: asNumber(r.citation_count),
    };
    // Attach org scope for applyFilters (not on the shared type — read via cast).
    (out as unknown as Record<string, unknown>).org_id = r.org_id ?? null;
    (out as unknown as Record<string, unknown>).visibility = r.visibility ?? null;
    return out;
  });
}

export async function searchCognitiveFtsAsOf(exec: Executor, userId: string, query: string, limit: number, asOf: string): Promise<CognitiveFtsResult[]> {
  if (!ftsHasTerms(query)) return [];
  const rows = await exec.rows<any>(
    `SELECT r.record_id, r.user_id, r.content, r.type, r.priority, r.scene_name, r.skill_tag,
            r.session_key, r.timestamp_str, r.created_time,
            ts_rank(r.content_tsv, plainto_tsquery('english', $2)) AS rank
       FROM cognitive_records r
      WHERE r.user_id = $1 AND r.content_tsv @@ plainto_tsquery('english', $2)
        AND r.created_time <= $3
        AND (r.invalid_at IS NULL OR r.invalid_at > $3)
        AND r.archived = 0
      ORDER BY rank DESC
      LIMIT $4`,
    [userId, query, asOf, limit],
  );
  return rows.map((r) => ({
    record_id: r.record_id, user_id: r.user_id, content: r.content, type: r.type,
    priority: asNumber(r.priority, 50), scene_name: r.scene_name, skill_tag: r.skill_tag,
    score: tsRankToScore(asNumber(r.rank)), timestamp_str: r.timestamp_str,
    timestamp_start: "", timestamp_end: "", session_key: r.session_key, session_id: "",
    metadata_json: "{}", created_time: r.created_time,
  }));
}

export async function upsertCognitiveVec(exec: Executor, vec: VecContext, recordId: string, embedding: Float32Array): Promise<void> {
  if (!vec.vecReady) return;
  if (vec.vecDimensions !== embedding.length) {
    await vec.initVec(embedding.length);
  }
  if (!vec.vecReady) return;
  await exec.run(
    `INSERT INTO cognitive_vec (record_id, embedding) VALUES ($1, $2::vector)
     ON CONFLICT (record_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
    [recordId, toVectorLiteral(embedding)],
  );
}

export async function searchCognitiveVec(exec: Executor, vec: VecContext, userId: string, queryEmbedding: Float32Array, limit: number, orgId?: string): Promise<VectorSearchResult[]> {
  if (!vec.vecReady) return [];
  if (vec.vecDimensions !== queryEmbedding.length) {
    await vec.initVec(queryEmbedding.length);
  }
  if (!vec.vecDimensions) return [];
  try {
    // ADR-010 P5b — gated org-shared union (see searchCognitiveFts). Without orgId
    // this is the unchanged user-only path.
    const scope = orgId ? `(r.user_id = $2 OR (r.org_id = $4 AND r.visibility = 'org'))` : `r.user_id = $2`;
    const params = orgId
      ? [toVectorLiteral(queryEmbedding), userId, limit, orgId]
      : [toVectorLiteral(queryEmbedding), userId, limit];
    const rows = await exec.rows<any>(
      `SELECT v.record_id, (v.embedding <=> $1::vector) AS distance,
              r.user_id, r.org_id, r.visibility, r.content, r.type, r.priority, r.scene_name, r.skill_tag,
              r.session_key, r.timestamp_str, r.created_time
         FROM cognitive_vec v
         JOIN cognitive_records r ON v.record_id = r.record_id
        WHERE ${scope} AND r.invalid_at IS NULL AND r.archived = 0
        ORDER BY v.embedding <=> $1::vector
        LIMIT $3`,
      params,
    );
    return rows.map((r) => {
      const out: VectorSearchResult = {
        record_id: r.record_id, user_id: r.user_id, content: r.content, type: r.type,
        priority: asNumber(r.priority, 50), scene_name: r.scene_name, skill_tag: r.skill_tag,
        score: 1 - asNumber(r.distance), timestamp_str: r.timestamp_str,
        timestamp_start: "", timestamp_end: "", session_key: r.session_key, session_id: "",
        metadata_json: "{}", created_time: r.created_time,
      };
      (out as unknown as Record<string, unknown>).org_id = r.org_id ?? null;
      (out as unknown as Record<string, unknown>).visibility = r.visibility ?? null;
      return out;
    });
  } catch (e) {
    console.error("[BrainRouter] Vector search failed:", e);
    return [];
  }
}
