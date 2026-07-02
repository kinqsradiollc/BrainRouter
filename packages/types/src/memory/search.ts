/**
 * BrainRouter Memory Types — vector/FTS search, recall, and capture results.
 *
 * Split out of the original `memory.ts` god file; re-exported from the
 * `../memory.js` barrel so the public surface is unchanged.
 */

// ============================
// Vector & FTS Search Results
// ============================

export interface VectorSearchResult {
  record_id: string;
  user_id: string;
  content: string;
  type: string;
  priority: number;
  scene_name: string;
  skill_tag: string;
  score: number; // Cosine similarity score
  timestamp_str: string;
  timestamp_start: string;
  timestamp_end: string;
  session_key: string;
  session_id: string;
  metadata_json: string;
  created_time: string;
  /** Federation Stage 1 (0.4.0) — workspace hash; NULL on legacy rows. */
  workspace_tag?: string | null;
}


export interface CognitiveFtsResult {
  record_id: string;
  user_id: string;
  content: string;
  type: string;
  priority: number;
  scene_name: string;
  skill_tag: string;
  score: number; // BM25 rank converted to 0-1
  timestamp_str: string;
  timestamp_start: string;
  timestamp_end: string;
  session_key: string;
  session_id: string;
  metadata_json: string;
  created_time: string;
  /** ACE feedback: number of times this memory was cited by the agent. */
  citation_count?: number;
  /** Federation Stage 1 (0.4.0) — workspace hash; NULL on legacy rows. */
  workspace_tag?: string | null;
}

export interface RecalledMemory {
  content: string;
  score: number;
  type: string;
  recordId: string;
  skillTag?: string;
  /**
   * MEM-17 — source chunk ids this record was distilled from (precise post
   * MEM-15). Drill in with `memory_fetch_source_chunk`. Omitted when the record
   * has no linked provenance.
   */
  sourceChunkIds?: string[];
  /**
   * MEM-17 — a memory-tree node whose sealed bucket covers this record's source,
   * when known. Walk it with `memory_tree_walk`. Omitted when none.
   */
  treeNodeId?: string | null;
  /**
   * MEM-ACCURACY (0.4.7) — true when the source code this record was derived
   * from has changed since capture (its provenance document is now stale). The
   * record is down-ranked and flagged "verify against current code"; treat its
   * code claims as a hint to re-check, not ground truth. Omitted when fresh.
   */
  staleVsCode?: boolean;
}

export type MemoryTaskIntent =
  | "build"
  | "debug"
  | "review"
  | "test"
  | "plan"
  | "refactor"
  | "security"
  | "performance"
  | "release";

// ============================
// Result Types
// ============================

// ============================
// Recall Explainability (Phase 3)
// ============================

export interface RecallExplanation {
  /** Number of FTS5 BM25 hits returned before RRF merge. */
  ftsHits: number;
  /** Number of vector search hits returned before RRF merge. */
  vecHits: number;
  /** Number of file-path expansion hits. */
  filePathHits: number;
  /** Top RRF fusion score (pre-decay). */
  rrfTopScore: number;
  /** Task intent detected from the query. */
  intentDetected: MemoryTaskIntent | "none";
  /** Memory types that received an intent boost (type → multiplier). */
  typeBoosts: Record<string, number>;
  /** Whether the active skill triggered a 1.2× skill boost. */
  skillBoostApplied: boolean;
  /** Whether the neural reranker was used in Stage 3. */
  rerankerUsed: boolean;
  /**
   * 0.4.3 — whether the local lexical-relevance + MMR-diversity selection ran
   * (Stage 3b). True on the default no-cross-encoder path when
   * BRAINROUTER_RECALL_DIVERSITY is on: off-topic boilerplate is demoted and
   * near-duplicate records are collapsed before the final top-K. Mutually
   * exclusive with `rerankerUsed` (the cross-encoder path wins when a key is set).
   */
  diversityApplied?: boolean;
  /** Whether the LLM relevance judge was used in Stage 4. */
  judgeUsed?: boolean;
  /** How many candidates the judge approved as relevant. */
  judgeApproved?: number;
  /** How many candidates the judge rejected as not relevant. */
  judgeRejected?: number;
  /** Per-candidate verdicts (index, relevant, reason) for audit/tuning. */
  judgeVerdicts?: RelevanceVerdict[];
  /** Whether graph context expansion was appended. */
  graphExpansion: boolean;
  /** Per-record citation boost contribution (recordId → boost). */
  citationBoosts: Record<string, number>;
  /** Total recall pipeline duration in milliseconds. */
  durationMs: number;
  /** Number of candidates sent to reranker (pre-filter). */
  rerankerCandidates: number;
  /** Final ranked records (recordId → finalScore). */
  scoredRecords: Array<{ recordId: string; finalScore: number; type: string }>;
  /**
   * Per-node trace of the neural-spark spreading activation pass.
   *
   * Each entry carries the node id, its final potential (clamped to [0, 1]),
   * whether it crossed the firing threshold, and human-readable label fields
   * so the UI can show "codebase_fact · the cli uses sqlite for…" instead of
   * an opaque record id. The full id stays on the entry for click-through.
   *
   * Order is: initial seeds first (whether or not they fired), then propagated
   * nodes that fired via 2-hop excitation.
   */
  sparkedNodes?: Array<{
    id: string;
    potential: number;
    fired: boolean;
    /** Memory type, e.g. "codebase_fact", "instruction". */
    type?: string;
    /** Optional short content preview (≤ 100 chars, single-line). */
    preview?: string;
    /** Optional focus-scene name the memory belongs to. */
    sceneName?: string;
  }>;
}

export interface RecallResult {
  /** Cognitive relevant memories — prepended to user prompt text (dynamic, per-turn). */
  prependContext?: string;
  /** Stable recall context appended to system prompt (core identity, focus nav, tools guide). */
  appendSystemContext?: string;
  /** Recalled Cognitive memories with scores (for metrics/debugging). */
  recalledCognitiveMemories?: RecalledMemory[];
  /** Strategy used. Phase 1 = keyword. */
  recallStrategy: string;
  /** Core identity markdown (for metrics/debugging). */
  coreIdentitySummary?: string;
  /** Current most active focus scene name (for metrics/debugging). */
  activeFocusName?: string;
  /** Full recall pipeline explanation (populated in explain mode or always). */
  recallExplanation?: RecallExplanation;
}

/**
 * Outcome of the cognitive extraction step for a single capture call. Lets
 * the CLI distinguish "the LLM said nothing notable here" (ok, zero records)
 * from "the LLM call itself failed" (failed) from "extraction wasn't tried
 * this turn" (skipped — below the every-N-turns threshold) from "extraction was
 * dispatched to run in the BACKGROUND so capture could reply immediately"
 * (deferred — the records will be extracted by the background runner; treat it
 * as success, not a warning).
 */
export type CognitiveExtractionStatus = "ok" | "failed" | "skipped" | "deferred";

export interface CaptureResult {
  /** Number of Sensory messages recorded. */
  sensoryRecordedCount: number;
  /** Whether Cognitive extraction was triggered this turn. */
  cognitiveExtractionTriggered: boolean;
  /** Number of Cognitive memories extracted (if triggered). */
  cognitiveExtractedCount: number;
  /**
   * Status of the extraction LLM call. `ok` means it ran and returned a
   * (possibly empty) list of records. `failed` means the LLM call itself
   * errored. `skipped` means we didn't try this turn. Callers should only
   * surface a warning to the user on `failed`.
   */
  cognitiveExtractionStatus?: CognitiveExtractionStatus;
  /** Error string when status === "failed", for diagnostic display. */
  cognitiveExtractionError?: string;
}

export interface RelevanceVerdict {
  /** Index into the candidate list passed to the judge. */
  index: number;
  /** Whether the judge approves this candidate as relevant to the query. */
  relevant: boolean;
  /** Short justification from the judge (for audit + tuning). */
  reason: string;
}
