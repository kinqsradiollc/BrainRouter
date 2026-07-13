/**
 * BrainRouter Memory Types — brain-agent registry, job queue, blackboard.
 *
 * Split out of the original `memory.ts` god file; re-exported from the
 * `../memory.js` barrel so the public surface is unchanged.
 */

// ─── Brain-side design pass (0.4.0 — design only, no execution) ──────────
//
// The interfaces below capture the brain-agent registry + job-queue
// surface the brain-side roadmap depends on. They are type
// stubs — no implementation lives in 0.4.0; Phase 1 (0.4.1) fleshes
// them out. Lifted here so MCP tool drafts, dashboard surfaces, and
// CLI consumers can already share the same shape.
//
// Tracking:
//   - BRAIN-DESIGN-T1 — this `BrainAgent` interface.
//   - BRAIN-DESIGN-T2 — `MemoryJobRecord` + status enum.
//   - BRAIN-DESIGN-T3 — MCP tool schemas (`brainrouter-docs/brain-agents.md`).
//   - BRAIN-DESIGN-T4 — `MemoryBlackboardItem` + lifecycle.

/**
 * The five model classes a brain agent might need. `none` means the
 * agent does no LLM work (e.g. a pure embedder or a graph extractor
 * that runs on heuristics). The class drives provider routing, tier
 * ladder, and cache-stats grouping.
 */
export type BrainAgentModelClass =
  | "extraction"
  | "synthesis"
  | "judge"
  | "embedding"
  | "none";

/**
 * A brain-side specialist. Each agent owns one stage of the memory
 * pipeline (extract, dedup, contradiction-check, graph-extract,
 * focus-distill, relevance-judge, identity-distill, source-chunk,
 * tree-summarise, situation-report). The registry is data-driven
 * so Phase 1 can swap implementations without touching call sites.
 *
 * **Brain boundary:** every field the CLI / dashboard should be
 * able to inspect lives here. Things that are pure internal runtime
 * concerns (LLM clients, semaphores) stay outside the type.
 */
export interface BrainAgent {
  /** Stable identifier; matches the registry key. */
  id: string;
  /** Short human-readable purpose. */
  description: string;
  /**
   * JSON Schema (or a structurally compatible shape) describing the
   * inputs the agent expects. Stored as `unknown` so callers don't
   * pull a schema validator at this layer; the registry validates.
   */
  inputSchema: unknown;
  /** JSON Schema for the output the agent writes back to the job. */
  outputSchema: unknown;
  modelClass: BrainAgentModelClass;
  /** Default 3. Per-job overrides allowed via `MemoryJobRecord.maxAttempts`. */
  maxAttempts: number;
  /** Default 90_000 ms. Per-job overrides allowed. */
  timeoutMs: number;
  /** How many sensory / memory items the agent processes per run. */
  batchSize: number;
  /**
   * Pure function of `input` that returns a stable string the
   * registry uses to dedupe in-flight jobs. Empty = no dedup.
   */
  idempotencyKey: (input: unknown) => string;
  /**
   * Tables / record kinds this agent READS. Used for the dashboard
   * "what does this agent depend on" view and (eventually) for
   * scheduler ordering.
   */
  reads: string[];
  /** Tables / record kinds this agent WRITES. */
  writes: string[];
  /**
   * Event names this agent emits (e.g. `MemoryChunkStored`,
   * `MemoryExtractionRequested`). Drives the future event-bus
   * routing; today these are documentation only.
   */
  emits: string[];
  /**
   * IDs of brain agents that must complete before this one runs.
   * Used for chained pipelines (e.g. graph_extractor depends on
   * cognitive_extractor). Empty = root agent.
   */
  dependsOn: string[];
}

/**
 * Public, dashboard-readable status of a brain agent. Returned by
 * the `memory_agent_status` MCP tool (BRAIN-DESIGN-T3).
 */
export interface BrainAgentStatus {
  id: string;
  description: string;
  modelClass: BrainAgentModelClass;
  /** Most recent job's status; `idle` when the queue is empty. */
  lastJobStatus: MemoryJobStatus | "idle";
  lastJobCompletedAt: string | null;
  /** Rolling success rate over the last N jobs. `null` until enough history. */
  successRate24h: number | null;
  /** Number of pending jobs waiting on this agent. */
  pendingJobs: number;
}

/**
 * Lifecycle states for a `memory_jobs` row. The scheduler advances
 * `pending → running → done|failed|cancelled`. `failed` jobs that
 * still have `attempts < maxAttempts` get re-armed (back to
 * `pending`) by the retry pass.
 */
export type MemoryJobStatus = "pending" | "running" | "done" | "failed" | "cancelled";

/** Best-effort, append-only activity emitted by long-running jobs. */
export interface MemoryJobProgressEvent {
  ts: string;
  kind: string;
  msg: string;
  data?: Record<string, unknown>;
}

/**
 * One row in the brain's `memory_jobs` table. The scheduler picks
 * the highest-priority `pending` job whose `runAfter` is in the
 * past, locks it (sets `lockedAt`), runs the bound agent, and
 * stamps `output` / `status` on completion.
 *
 * Phase 1 implementation lives in
 * `brainrouter/src/memory/scheduler/` (does not exist yet);
 * `brain-agents.md` traces the exact lifecycle.
 */
export interface MemoryJobRecord {
  id: string;
  /** Brain agent id (FK to `BrainAgent.id`). */
  kind: string;
  status: MemoryJobStatus;
  /** Higher = sooner. Default 50. */
  priority: number;
  attempts: number;
  maxAttempts: number;
  /** ISO timestamp. Jobs with `runAfter > now` are not eligible. */
  runAfter: string;
  /** ISO timestamp of the most recent `pending → running` transition. NULL when not running. */
  lockedAt: string | null;
  /** Parent job id when this was spawned by another job's chain. NULL for top-level. */
  parentJobId: string | null;
  input: unknown;
  output: unknown;
  /** Ordered timeline events for dashboard polling. */
  progress: MemoryJobProgressEvent[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * BRAIN-DESIGN-T4 — `memory_blackboard_items` row. The "candidate
 * memory" layer between raw extraction and the cognitive store.
 * Lets the dedup / contradiction / evidence agents argue about a
 * record before it lands. Phase 5 wires the commit pipeline that
 * walks blackboard items into either `cognitive_records` (committed)
 * or `superseded` (merged into another candidate).
 */
export type MemoryBlackboardKind =
  | "candidate_record"
  | "claim"
  | "critique"
  | "needs_evidence"
  | "summary_node"
  | "routing_decision"
  | "verification_result";

export type MemoryBlackboardStatus =
  | "pending"
  | "merged"
  | "committed"
  | "rejected"
  | "superseded";

export interface MemoryBlackboardItem {
  id: string;
  kind: MemoryBlackboardKind;
  /** Job that produced this item (FK to `memory_jobs.id`). */
  sourceJobId: string;
  /** Existing cognitive record this item refines / contradicts / merges into. NULL for fresh candidates. */
  parentRecordId: string | null;
  payload: Record<string, unknown>;
  confidence: number;
  /**
   * References to source-of-truth artefacts that back this item
   * (file path + line range, command output id, tool result id, …).
   * Same shape `memory_evidence.ref` carries.
   */
  evidenceRefs: string[];
  status: MemoryBlackboardStatus;
  createdAt: string;
  /** ISO timestamp when the item left `pending`. NULL while still pending. */
  decidedAt: string | null;
}

// ─────────────────────────────────────────────────────────────────────────
// BRAIN-P1 (0.4.1) — job-queue store surface.
//
// The `memory_jobs` table (BRAIN-DESIGN-T2) is global to a brain
// instance (single-tenant per API key — OQ-3). Per-user routing lives
// in `MemoryJobRecord.input`, never in a table column. These helper
// types describe the store's CRUD surface; the scheduler layer
// (`brainrouter/src/memory/scheduler/`) owns idempotency dedup + backoff.
// ─────────────────────────────────────────────────────────────────────────

/** New-job parameters for `enqueueMemoryJob`. `kind` is a brain-agent id. */
export interface MemoryJobEnqueueInput {
  kind: string;
  input: unknown;
  /** Higher runs sooner. Defaults to 50. */
  priority?: number;
  /** Per-job override of the agent's `maxAttempts`. Defaults to 3. */
  maxAttempts?: number;
  /** ISO timestamp; job is ineligible until past this. Defaults to now. */
  runAfter?: string;
  /** Parent job id when spawned by another job's chain. */
  parentJobId?: string | null;
}

/** Filters for `listMemoryJobs`. */
export interface MemoryJobListFilters {
  /** Restrict to a single brain-agent id. */
  kind?: string;
  /** One or more lifecycle states. */
  status?: MemoryJobStatus | MemoryJobStatus[];
  /** Max rows. Defaults to 100. */
  limit?: number;
}

/**
 * Per-kind rollup the `memory_agent_status` tool joins against the
 * registry. One row per distinct `kind` that has at least one job.
 */
export interface MemoryJobKindAggregate {
  kind: string;
  /** Most recent job's status by `updatedAt`. */
  lastStatus: MemoryJobStatus;
  /** `updatedAt` of the most recent `done` job, else null. */
  lastCompletedAt: string | null;
  /** Count of `pending` jobs for this kind. */
  pendingJobs: number;
  /**
   * done / (done + failed) over jobs updated in the last 24h. `null`
   * when no terminal jobs landed in the window.
   */
  successRate24h: number | null;
}
