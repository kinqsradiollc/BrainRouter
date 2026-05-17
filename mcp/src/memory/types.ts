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

export type MemoryType = "persona" | "episodic" | "instruction" | "skill_context";

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
  timestampStr: string;
  timestampStart: string;
  timestampEnd: string;
  createdTime: string;
  updatedTime: string;
  metadata: Record<string, unknown>;
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
}

export interface RecalledMemory {
  content: string;
  score: number;
  type: string;
  recordId: string;
  skillTag?: string;
}

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
}
