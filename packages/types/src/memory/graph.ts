/**
 * BrainRouter Memory Types — GraphRAG nodes/edges + analytics.
 *
 * Split out of the original `memory.ts` god file; re-exported from the
 * `../memory.js` barrel so the public surface is unchanged.
 */

import type { SourceChunk } from "./source.js";

// ============================
// GraphRAG Types
// ============================

export interface GraphNode {
  id: string;
  userId: string;
  entity: string;
  entityType: string;
  skillTag: string;
  confidence: number;
  sourceRecordId: string;
  createdTime: string;
}

export interface GraphEdge {
  id: string;
  userId: string;
  fromNodeId: string;
  toNodeId: string;
  relation: string;
  skillTag: string;
  confidence: number;
  sourceRecordId: string;
  createdTime: string;
}

/**
 * DASH-1 (0.4.4) — graph analytics lenses over the cognitive graph: PageRank
 * centrality, broker/bridge entities (articulation points), namespace overview,
 * and an optional shortest connection path between two entities.
 */
export interface GraphAnalytics {
  nodeCount: number;
  edgeCount: number;
  topCentral: Array<{ entity: string; entityType: string; score: number }>;
  bridges: Array<{ entity: string; entityType: string }>;
  namespaces: Record<string, number>;
  path?: { from: string; to: string; found: boolean; entities: string[] };
}

/**
 * MEM-29 (0.4.4) — one ranked `find_related` hit: a source chunk plus the score
 * that ordered it and a short human reason (which signals fired). `score` is a
 * normalized 0..1 relevance after code-aware reranking (higher = better).
 */
export interface RelatedChunkHit {
  chunk: SourceChunk;
  score: number;
  reason: string;
}
