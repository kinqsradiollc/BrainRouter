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

export async function searchCognitiveFts(exec: Executor, userId: string, query: string, limit: number): Promise<CognitiveFtsResult[]> {
  if (!ftsHasTerms(query)) return [];
  const rows = await exec.rows<any>(
    `SELECT r.record_id, r.user_id, r.content, r.type, r.priority, r.scene_name, r.skill_tag,
            r.session_key, r.timestamp_str, r.created_time, r.citation_count,
            ts_rank(r.content_tsv, plainto_tsquery('english', $2)) AS rank
       FROM cognitive_records r
      WHERE r.user_id = $1 AND r.content_tsv @@ plainto_tsquery('english', $2)
        AND r.invalid_at IS NULL AND r.archived = 0
      ORDER BY rank DESC
      LIMIT $3`,
    [userId, query, limit],
  );
  return rows.map((r) => ({
    record_id: r.record_id, user_id: r.user_id, content: r.content, type: r.type,
    priority: asNumber(r.priority, 50), scene_name: r.scene_name, skill_tag: r.skill_tag,
    score: tsRankToScore(asNumber(r.rank)), timestamp_str: r.timestamp_str,
    timestamp_start: "", timestamp_end: "", session_key: r.session_key, session_id: "",
    metadata_json: "{}", created_time: r.created_time, citation_count: asNumber(r.citation_count),
  }));
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

export async function searchCognitiveVec(exec: Executor, vec: VecContext, userId: string, queryEmbedding: Float32Array, limit: number): Promise<VectorSearchResult[]> {
  if (!vec.vecReady) return [];
  if (vec.vecDimensions !== queryEmbedding.length) {
    await vec.initVec(queryEmbedding.length);
  }
  if (!vec.vecDimensions) return [];
  try {
    const rows = await exec.rows<any>(
      `SELECT v.record_id, (v.embedding <=> $1::vector) AS distance,
              r.user_id, r.content, r.type, r.priority, r.scene_name, r.skill_tag,
              r.session_key, r.timestamp_str, r.created_time
         FROM cognitive_vec v
         JOIN cognitive_records r ON v.record_id = r.record_id
        WHERE r.user_id = $2 AND r.invalid_at IS NULL AND r.archived = 0
        ORDER BY v.embedding <=> $1::vector
        LIMIT $3`,
      [toVectorLiteral(queryEmbedding), userId, limit],
    );
    return rows.map((r) => ({
      record_id: r.record_id, user_id: r.user_id, content: r.content, type: r.type,
      priority: asNumber(r.priority, 50), scene_name: r.scene_name, skill_tag: r.skill_tag,
      score: 1 - asNumber(r.distance), timestamp_str: r.timestamp_str,
      timestamp_start: "", timestamp_end: "", session_key: r.session_key, session_id: "",
      metadata_json: "{}", created_time: r.created_time,
    }));
  } catch (e) {
    console.error("[BrainRouter] Vector search failed:", e);
    return [];
  }
}
