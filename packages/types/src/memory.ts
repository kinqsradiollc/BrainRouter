/**
 * BrainRouter Memory Types
 *
 * Defines the types and boundaries for the BrainRouter memory engine.
 * Inspired by the reference architecture but scoped explicitly for MCP + Multi-tenant.
 */

// ============================
// Runtime Context (Multi-Tenant)
// ============================

export interface BrainRouterMemoryContext {
  /** User identifier — REQUIRED. Enables multi-tenant isolation. */
  userId: string;
  /** Session identifier (unique per conversation session). */
  sessionKey: string;
  /** Sub-session identifier (optional). */
  sessionId?: string;
  /** Which BrainRouter skill is currently active (if any) */
  activeSkill?: string;
}

// ============================
// Record Types
// ============================

export interface SensoryRecord {
  id: string;
  userId: string;
  sessionKey: string;
  sessionId: string;
  role: string;
  messageText: string;
  recordedAt: string;
  timestamp: number;
  skillTag: string;
}

export type MemoryType =
  | "persona"
  | "episodic"
  | "instruction"
  | "skill_context"
  | "tool_preference"
  | "codebase_fact"
  | "api_contract"
  | "data_model"
  | "dependency_constraint"
  | "environment_constraint"
  | "architecture_decision"
  | "implementation_decision"
  | "design_constraint"
  | "security_policy"
  | "performance_baseline"
  | "bug_finding"
  | "debug_trace"
  | "fix_summary"
  | "verification_result"
  | "failed_attempt"
  | "regression_risk"
  | "task_state"
  | "handover_note"
  | "blocked_reason"
  | "review_comment"
  | "release_note"
  | "source_evidence"
  | "artifact_reference"
  | "file_history"
  | "command_knowledge";

export type MemoryStatus = "active" | "superseded" | "archived" | "needs_verification";

export type MemorySourceKind =
  | ""
  | "user_instruction"
  | "source_file"
  | "command_output"
  | "test_result"
  | "model_inference"
  | "prior_memory";

export type MemoryVerificationStatus = "" | "verified" | "unverified" | "stale";

export type EvidenceKind = "file" | "command" | "url" | "test" | "benchmark" | "memory" | "other";

export interface EvidenceRef {
  kind: EvidenceKind;
  ref: string;
}

export interface CognitiveRecord {
  id: string;
  userId: string;
  sessionKey: string;
  sessionId: string;
  content: string;
  type: MemoryType;
  priority: number;
  sceneName: string;
  skillTag: string;
  halfLifeDays: number | null; // null = never decays (e.g. instruction)
  supersededBy: string | null;
  invalidAt?: string | null;
  timestampStr: string;
  timestampStart: string;
  timestampEnd: string;
  createdTime: string;
  updatedTime: string;
  metadata: Record<string, unknown>;
  confidence: number;
  status: MemoryStatus;
  sourceKind: MemorySourceKind;
  verificationStatus: MemoryVerificationStatus;
  repoPaths: string[];
  filePaths: string[];
  commands: string[];
  // ACE Feedback Loop
  citationCount: number;
  lastCitedAt: string | null;
  neverCitedCount: number;
  archived: boolean;
  /**
   * Federation Stage 1 (0.4.0) — optional workspace identifier the
   * record was captured under. Default is a stable hash of the
   * workspace root path (see `workspaceTagFromPath`). NULL means
   * "no workspace context known at capture time" — recall filters
   * are NULL-tolerant on either side so legacy records keep
   * surfacing across all workspaces until they're re-captured.
   */
  workspaceTag?: string | null;
}

import { createHash } from "node:crypto";

/**
 * Compute the canonical workspace tag from a workspace root path —
 * a 16-char hex SHA-256 prefix. The same root always hashes to the
 * same tag, so the BrainRouter CLI and any peer MCP client agree on
 * the identifier without coordinating.
 *
 * Empty/missing input returns `null` rather than a hash of an empty
 * string, so callers can pass an unresolved workspace through without
 * accidentally tagging records with a synthetic constant.
 */
export function workspaceTagFromPath(workspaceRoot: string | undefined | null): string | null {
  if (!workspaceRoot || workspaceRoot.trim() === "") return null;
  return createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
}

/**
 * Federation Stage 2 (0.4.0) — registry row for a CLI / MCP client that
 * is currently attached to the brain. Identity is the composite
 * `(sessionKey, userId)` so a misbehaving client can't accidentally
 * stomp another user's session by reusing the same key.
 */
export interface ActiveSessionRecord {
  sessionKey: string;
  userId: string;
  /**
   * Client self-report. Known kinds: `brainrouter-cli`, `claude-code`,
   * `codex`, `cursor`, `gemini-cli`. Falls back to `http-unknown` when
   * a client connects over HTTP without identifying itself.
   */
  clientKind: string;
  workspaceRoot: string;
  /** ISO timestamp; never updated after registration. */
  startedAt: string;
  /** ISO timestamp; bumped on every heartbeat. */
  lastHeartbeatAt: string;
  metadata: Record<string, unknown>;
  /**
   * Optional usage snapshot (FED-S2-T8). Last-write-wins on heartbeat;
   * NULL when the client doesn't report telemetry. Same shape the CLI
   * surfaces via `/tokens`.
   */
  usage?: ActiveSessionUsage | null;
}

export interface ActiveSessionUsage {
  promptTokens?: number;
  completionTokens?: number;
  cachedPromptTokens?: number;
  totalUsd?: number;
  cacheSavingsUsd?: number;
  /** ISO timestamp of the snapshot the client sent. */
  updatedAt: string;
}

/**
 * Federation Stage 3 (0.4.0) — cross-CLI messaging payload kinds.
 *
 * `text` is the only kind a Stage 3 CLI consumer renders today (via
 * `/dm` and `/broadcast`). The other four are schema-reserved so
 * Stage 4 (cross-vendor delegate) and CLI Multi-Agent Phase 2
 * (goal handoff between sessions) can carry richer payloads without
 * a schema migration.
 */
export type SessionInboxKind =
  | "text"
  | "tool-result"
  | "memory-ref"
  | "goal-handoff"
  | "delegate";

/**
 * One row in the brain's `session_inbox` table. Owned by the
 * recipient's user — the sending session puts a message in the
 * recipient's inbox, the recipient pulls or peeks.
 *
 * `toSessionKey` accepts three address shapes:
 *   - exact `sessionKey`            — point-to-point
 *   - `clientKind:*` (e.g. `codex:*`) — pattern broadcast
 *   - `*`                           — broadcast to every active session
 *                                     under the sender's userId
 *
 * The store fans out broadcast forms into one row per matched
 * recipient at send time. Each recipient sees a unique inbox id
 * and acks independently.
 */
export interface SessionInboxRecord {
  id: string;
  userId: string;
  fromSessionKey: string;
  toSessionKey: string;
  kind: SessionInboxKind;
  payload: Record<string, unknown>;
  createdAt: string;
  /** ISO timestamp when the recipient's last non-peek read covered this id. NULL until then. */
  deliveredAt: string | null;
}

export interface SessionInboxFilters {
  userId: string;
  toSessionKey: string;
  /** When `true`, include rows already marked delivered. Default `false`. */
  includeDelivered?: boolean;
  /** Cap the page size. Default 50. */
  limit?: number;
}

export interface ActiveSessionFilters {
  userId?: string;
  clientKind?: string;
  workspaceRoot?: string;
  /**
   * When false (default), exclude rows whose lastHeartbeatAt is older
   * than `staleThresholdMs` (default 120000 = 2 min). When true, return
   * everything in the table — useful for diagnostics + the sweeper.
   */
  includeStale?: boolean;
  staleThresholdMs?: number;
  /** When true, include the `usage` field in returned rows (FED-S2-T8). */
  includeUsage?: boolean;
}

export interface MemoryEvidence {
  id: string;
  userId: string;
  recordId: string;
  kind: EvidenceKind;
  ref: string;
  excerpt: string;
  observedAt: string;
  metadata: Record<string, unknown>;
}

export interface MemoryOperation {
  id: string;
  userId: string;
  recordId: string | null;
  operation: string;
  actor: string;
  sessionKey: string;
  reason: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface MemoryExport {
  version: 1;
  exportedAt: string;
  userId: string;
  memories: CognitiveRecord[];
  evidence: MemoryEvidence[];
  operations: MemoryOperation[];
}

export interface MemoryImport {
  version: 1;
  memories: CognitiveRecord[];
  evidence?: MemoryEvidence[];
  operations?: MemoryOperation[];
}

export interface ImportResult {
  importedMemories: number;
  importedEvidence: number;
  importedOperations: number;
}

export interface DiagnosticsBundle {
  timestamp: string;
  sqliteVersion: string;
  nodeVersion: string;
  databaseStats: {
    userStats: {
      total: number;
      archived: number;
      byType: Record<string, number>;
      citationRate: number;
      lastRecallAt: string | null;
      /** Rows in sensory_stream — always written on capture; useful when
       *  `total` is 0 but capture is firing (cognitive extraction hasn't run yet). */
      sensoryTotal: number;
      /** Sensory rows the cognitive extractor hasn't consumed yet. */
      sensoryUnextracted: number;
      /** Rows in contextual_focus for this user. */
      focusSceneTotal: number;
      extraction: ExtractionStatus;
    };
  };
  envKeys: string[];
  recentErrors: MemoryOperation[];
}

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
 * this turn" (skipped — below the every-N-turns threshold).
 */
export type CognitiveExtractionStatus = "ok" | "failed" | "skipped";

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

// ============================
// Services
// ============================

export interface EmbeddingServiceConfig {
  endpoint?: string;
  apiKey?: string;
  model?: string;
  dimensions?: number;
  timeoutMs?: number;
}

export interface RerankerServiceConfig {
  endpoint?: string;
  apiKey?: string;
  model?: string;
  topN?: number;
  timeoutMs?: number;
}

export interface RelevanceJudgeServiceConfig {
  /** Enable flag — when false, the judge stage is skipped entirely. */
  enabled?: boolean;
  /** OpenAI-compatible chat-completions endpoint. Falls back to BRAINROUTER_LLM_ENDPOINT. */
  endpoint?: string;
  /** API key. Falls back to BRAINROUTER_LLM_API_KEY. */
  apiKey?: string;
  /** Model id for the judge. Defaults to a fast/cheap model. */
  model?: string;
  /** Max candidates sent to the judge in a single batched call. Default 10. */
  maxCandidates?: number;
  /** Per-call timeout in ms. Default 15000. */
  timeoutMs?: number;
}

export interface RelevanceVerdict {
  /** Index into the candidate list passed to the judge. */
  index: number;
  /** Whether the judge approves this candidate as relevant to the query. */
  relevant: boolean;
  /** Short justification from the judge (for audit + tuning). */
  reason: string;
}

export interface SkillHintsRecord {
  skillName: string;
  hints: string;
  sourceFile: string;
  registeredAt: string;
}

export interface SkillActivationRecord {
  skillName: string;
  potential: number;
  lastDecayTime: string;
}

export interface UserRecord {
  userId: string;
  apiKey: string;
  passwordHash: string | null;
  displayName: string;
  email: string;
  isAdmin: boolean;
  status: "active" | "disabled";
  createdAt: string;
}

export interface PublicUserRecord {
  userId: string;
  displayName: string;
  email: string;
  isAdmin: boolean;
  status: "active" | "disabled";
  createdAt: string;
}

// ============================
// LLM Runner
// ============================

export interface LLMRunParams {
  prompt: string;
  systemPrompt?: string;
  taskId: string;
  timeoutMs?: number;
}

export interface LLMRunner {
  run(params: LLMRunParams): Promise<string>;
}

// ============================
// L2 / L3 / Scheduler Types
// ============================

export interface ContextualFocusRecord {
  id: string;
  userId: string;
  sceneName: string;
  summaryMd: string;
  heatScore: number;
  lastActiveTime: string;
  createdTime: string;
  updatedTime: string;
}

export interface CoreIdentityRecord {
  userId: string;
  personaMd: string;
  cognitiveCountAtGeneration: number;
  createdTime: string;
  updatedTime: string;
}

export interface ContradictionRecord {
  id: string;
  user_id?: string;
  userId?: string;
  record_id_a?: string;
  recordIdA?: string;
  record_id_b?: string;
  recordIdB?: string;
  reason: string;
  confidence: number;
  status?: "pending" | "resolved" | "dismissed";
  created_time?: string;
  createdTime?: string;
  content_a?: string;
  contentA?: string;
  content_b?: string;
  contentB?: string;
}

export interface SchedulerState {
  cognitiveCountSinceLastFocus: number;
  cognitiveCountSinceLastIdentity: number;
  totalCognitiveCount: number;
  extractionErrors: number;
  lastErrorMessage: string | null;
  lastErrorAt: string | null;
}

export interface StalledExtractionBacklog {
  userId: string;
  sessionKey: string;
  sessionId: string;
  unextractedCount: number;
  latestRecordedAt: string;
  extractionErrors: number;
  lastErrorMessage: string | null;
}

export interface ExtractionStatus {
  extractionErrors: number;
  lastErrorMessage: string | null;
  lastErrorAt: string | null;
  syncPaused: boolean;
}

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
