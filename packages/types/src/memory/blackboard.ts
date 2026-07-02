/**
 * BrainRouter Memory Types — blackboard commit pipeline.
 *
 * Split out of the original `memory.ts` god file; re-exported from the
 * `../memory.js` barrel so the public surface is unchanged.
 */

import type { MemoryType } from "./records.js";

// ───────────────────────────────────────────────────────────────────────────
// Blackboard commit pipeline (MEM-4, 0.4.3) — extracted memory candidates are
// STAGED here, reconciled (dedup / score / conflict-check), then committed to
// cognitive records with an audit trail. Keeps low-quality extraction out of
// long-term memory until it's been reviewed.
// ───────────────────────────────────────────────────────────────────────────

export type BlackboardStatus =
  | "pending"     // freshly staged, not yet reconciled
  | "reconciled"  // survived reconcile, ready to commit
  | "duplicate"   // a higher-scored sibling already covers it
  | "committed"   // promoted to a cognitive record
  | "rejected";   // dropped (below threshold or by review)

/** The memory a candidate proposes — a subset of a CognitiveRecord. */
export interface BlackboardCandidate {
  content: string;
  type: MemoryType;
  priority?: number;
  sceneName?: string;
  confidence?: number;
}

export interface BlackboardItem {
  id: string;
  userId: string;
  /** The source chunk this candidate was extracted from, when known. */
  sourceChunkId: string | null;
  candidate: BlackboardCandidate;
  score: number;
  status: BlackboardStatus;
  /** Ids of sibling items this one duplicates / conflicts with. */
  conflictIds: string[];
  createdAt: string;
  /** Set once committed — the cognitive record id this produced. */
  committedRecordId: string | null;
}

/** Input shape for staging — id/status/createdAt assigned by the store. */
export interface BlackboardItemInput {
  sourceChunkId?: string | null;
  candidate: BlackboardCandidate;
  score?: number;
}
