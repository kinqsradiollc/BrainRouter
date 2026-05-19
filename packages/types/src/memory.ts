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

export interface L0Record {
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

export interface L1Record {
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
  memories: L1Record[];
  evidence: MemoryEvidence[];
  operations: MemoryOperation[];
}

export interface MemoryImport {
  version: 1;
  memories: L1Record[];
  evidence?: MemoryEvidence[];
  operations?: MemoryOperation[];
}

export interface ImportResult {
  importedMemories: number;
  importedEvidence: number;
  importedOperations: number;
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


export interface L1FtsResult {
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

export interface RecallResult {
  /** L1 relevant memories — prepended to user prompt text (dynamic, per-turn). */
  prependContext?: string;
  /** Stable recall context appended to system prompt (persona, scene nav, tools guide). */
  appendSystemContext?: string;
  /** Recalled L1 memories with scores (for metrics/debugging). */
  recalledL1Memories?: RecalledMemory[];
  /** Strategy used. Phase 1 = keyword. */
  recallStrategy: string;
  /** L3 persona markdown (for metrics/debugging). */
  personaSummary?: string;
  /** Current most active scene name (for metrics/debugging). */
  activeScene?: string;
}

export interface CaptureResult {
  /** Number of L0 messages recorded. */
  l0RecordedCount: number;
  /** Whether L1 extraction was triggered this turn. */
  l1ExtractionTriggered: boolean;
  /** Number of L1 memories extracted (if triggered). */
  l1ExtractedCount: number;
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

export interface L2SceneRecord {
  id: string;
  userId: string;
  sceneName: string;
  summaryMd: string;
  heatScore: number;
  lastActiveTime: string;
  createdTime: string;
  updatedTime: string;
}

export interface L3PersonaRecord {
  userId: string;
  personaMd: string;
  l1CountAtGeneration: number;
  createdTime: string;
  updatedTime: string;
}

export interface SchedulerState {
  l1CountSinceLastL2: number;
  l1CountSinceLastL3: number;
  totalL1Count: number;
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
