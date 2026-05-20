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
  /** IDs of memory nodes that triggered/sparked during spreading activation. */
  sparkedNodes?: string[];
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

export interface CaptureResult {
  /** Number of Sensory messages recorded. */
  sensoryRecordedCount: number;
  /** Whether Cognitive extraction was triggered this turn. */
  cognitiveExtractionTriggered: boolean;
  /** Number of Cognitive memories extracted (if triggered). */
  cognitiveExtractedCount: number;
}

// ============================
// Services
// ============================

export interface EmbeddingServiceConfig {
  endpoint?: string;
  apiKey?: string;
  model?: string;
  dimensions?: number;
}

export interface RerankerServiceConfig {
  endpoint?: string;
  apiKey?: string;
  model?: string;
  topN?: number;
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
