import type {
  ActiveSessionFilters,
  ActiveSessionRecord,
  ActiveSessionUsage,
  SessionInboxFilters,
  SessionInboxKind,
  SessionInboxRecord,
  PendingDelegationRecord,
  PendingDelegationEnqueueInput,
  PendingDelegationFilters,
  MemoryJobRecord,
  MemoryJobEnqueueInput,
  MemoryJobListFilters,
  MemoryJobKindAggregate,
  MemoryJobProgressEvent,
  GraphEdge,
  GraphNode,
  ContradictionRecord,
  ImportResult,
  SensoryRecord,
  CognitiveFtsResult,
  CognitiveRecord,
  ContextualFocusRecord,
  CoreIdentityRecord,
  MemoryEvidence,
  MemoryExport,
  MemoryImport,
  ExtractionStatus,
  MemoryOperation,
  MemoryStatus,
  SchedulerState,
  SkillActivationRecord,
  SkillHintsRecord,
  StalledExtractionBacklog,
  UserRecord,
  VectorSearchResult,
} from "./memory.js";
import type { AtlasGraph } from "./atlas.js";

/** A tenant's stored Atlas workspace summary (REMOTE-BRAIN Phase 3). */
export interface AtlasWorkspaceSummary {
  /** Workspace identifier the graph was stored under (e.g. a path hash or name). */
  workspaceTag: string;
  /** Node count at store time (cheap list metadata, no graph parse). */
  nodeCount: number;
  /** ISO-8601 timestamp of the last upsert. */
  updatedAt: string;
}

/** HONK-H3.3 — a client-pushed fleet queue snapshot the brain stores + serves. */
export interface FleetSnapshotEntry {
  /** The fleet host that pushed this snapshot. */
  host: string;
  /** The opaque snapshot payload (the shape `summarizeFleet()` returns). */
  snapshot: unknown;
  /** Total job count at push time (cheap list metadata, no payload parse). */
  jobCount: number;
  /** ISO-8601 timestamp of the last push. */
  updatedAt: string;
}

export interface CursorPaginationOptions<TCursor = Record<string, unknown>> {
  cursor?: TCursor;
  limit: number;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface MemoryListFilters {
  query?: string;
  type?: string;
  scene?: string;
  skill?: string;
  archived?: boolean;
}

export interface MemoryListItem {
  recordId: string;
  content: string;
  type: string;
  priority: number;
  sceneName: string;
  skillTag: string;
  createdTime: string;
  citationCount: number;
  neverCitedCount: number;
  archived: boolean;
}

export interface EvidenceListFilters {
  recordId?: string;
  kind?: string;
}

export interface OperationLogFilters {
  operation?: string;
  sessionKey?: string;
  createdAfter?: string;
  createdBefore?: string;
}

/**
 * ADR-007 Phase 2 — the memory store is now async. Postgres (node-postgres) is
 * inherently Promise-based and there is no production synchronous Postgres driver
 * for Node, so every method returns a Promise. Callers `await` the engine, which
 * awaits the store. Structure is unchanged — same methods, same shapes, just async.
 */
export interface IMemoryStore {
  init(): Promise<void>;
  initVec(dimensions: number): Promise<void>;
  /** Close the underlying connection pool. Idempotent; the store must not be used after. */
  close(): Promise<void>;
  reembedStaleRecords(embedder: (text: string) => Promise<Float32Array>): Promise<number>;
  getSqliteVersion(): Promise<string>;
  upsertSensory(record: SensoryRecord): Promise<void>;
  getRecentSensoryMessages(userId: string, sessionKey: string, limit: number, afterIsoTime?: string): Promise<SensoryRecord[]>;
  getUnextractedSensoryCount(userId: string, sessionKey: string): Promise<number>;
  markSensoryExtracted(userId: string, sessionKey: string, recordIds: string[], extractedAt?: string): Promise<void>;
  upsertCognitive(record: CognitiveRecord, options?: { skipAudit?: boolean }): Promise<void>;
  /** Batch upsert with optional embedding vectors. Pass skipAudit to suppress per-record
   * cognitive_upsert noise when the caller will write a higher-level audit entry itself. */
  upsertCognitiveBatch(entries: Array<{ record: CognitiveRecord; embedding?: Float32Array }>, options?: { skipAudit?: boolean }): Promise<void>;
  invalidateCognitiveRecord(userId: string, recordId: string, supersededById: string): Promise<void>;
  getMemoryById(userId: string, recordId: string): Promise<CognitiveRecord | null>;
  getMemoriesByFilePath(userId: string, filePath: string, limit: number): Promise<CognitiveRecord[]>;
  updateCognitiveConfidence(userId: string, recordId: string, confidence: number, status: MemoryStatus): Promise<void>;
  insertEvidence(ev: MemoryEvidence): Promise<void>;
  getEvidenceByRecord(userId: string, recordId: string): Promise<MemoryEvidence[]>;
  listEvidence(
    userId: string,
    filters?: EvidenceListFilters,
    pagination?: CursorPaginationOptions<{ observedAt: string; id: string }>
  ): Promise<MemoryEvidence[]>;
  /** Write an audit operation. Kept on the interface because the engine layer needs to
   * correlate external events (memory_update, import) with store writes atomically.
   * It is NOT intended for use by any caller outside of SqliteMemoryStore or MemoryEngine. */
  insertOperation(op: MemoryOperation): Promise<void>;
  getOperationLog(
    userId: string,
    options?: CursorPaginationOptions<{ createdAt: string; id: string }>,
    filters?: OperationLogFilters
  ): Promise<MemoryOperation[]>;
  exportMemories(userId: string): Promise<MemoryExport>;
  importMemories(userId: string, data: MemoryImport): Promise<ImportResult>;
  hardDeleteMemory(userId: string, recordId: string, reason: string): Promise<void>;
  searchCognitiveFts(userId: string, query: string, limit: number): Promise<CognitiveFtsResult[]>;
  searchCognitiveFtsAsOf(userId: string, query: string, limit: number, asOf: string): Promise<CognitiveFtsResult[]>;
  /**
   * Federation Stage 1 (0.4.0) — batch lookup of `workspace_tag` for a
   * set of record ids. Used by the recall pipeline when a workspace
   * filter is set, to apply the NULL-tolerant scope after FTS / vector
   * / filepath candidate gathering. Missing record ids and NULL tags
   * both map to `null` in the returned map.
   */
  getWorkspaceTagsByRecordIds(userId: string, recordIds: string[]): Promise<Map<string, string | null>>;
  /** AUG-A1 (0.4.1) — batch project-tag lookup for the recall scope filter. */
  getProjectTagsByRecordIds(userId: string, recordIds: string[]): Promise<Map<string, string | null>>;

  /**
   * Federation Stage 2 (0.4.0) — active-session registry surface.
   *
   * - `registerActiveSession` upserts a row keyed by `(sessionKey, userId)`.
   *   On insert, `startedAt` is set to the provided value; on conflict it
   *   is preserved (so a re-register does not reset session start time).
   *   `lastHeartbeatAt` always advances to the provided value.
   * - `heartbeatActiveSession` updates `lastHeartbeatAt` (and optionally
   *   `usage`) for an existing row. Returns `true` when a row was
   *   updated, `false` when no matching session existed (callers can
   *   re-register on that signal). MUST NOT write to `operation_log`
   *   — heartbeats are 1/30s × N peers, audit volume would explode.
   * - `listActiveSessions` returns rows that match the filters. By
   *   default excludes sessions whose heartbeat is older than
   *   `staleThresholdMs` (2 min).
   * - `sweepActiveSessions` deletes rows older than the given threshold.
   *   Returns the count removed.
   */
  registerActiveSession(record: ActiveSessionRecord): Promise<ActiveSessionRecord>;
  heartbeatActiveSession(
    userId: string,
    sessionKey: string,
    at: string,
    usage?: ActiveSessionUsage | null,
  ): Promise<boolean>;
  /**
   * Federation Stage 2 follow-up: graceful unregister on clean CLI exit.
   * Returns `true` when a row was deleted, `false` when no matching row
   * existed (idempotent — safe to call multiple times). The 5-min
   * sweeper still acts as the safety net for hard kills.
   */
  unregisterActiveSession(userId: string, sessionKey: string): Promise<boolean>;
  listActiveSessions(filters: ActiveSessionFilters): Promise<ActiveSessionRecord[]>;
  sweepActiveSessions(olderThanMs: number): Promise<number>;

  /**
   * Federation Stage 3 (0.4.0) — cross-CLI messaging.
   *
   * - `sendSessionMessage` writes one row PER recipient. The caller
   *   passes the literal addressing string (`sessionKey`, `clientKind:*`,
   *   or `*`); the store resolves it against `active_sessions` at send
   *   time and fans out. Returns the persisted ids so the sender can
   *   surface "delivered to N peers" feedback.
   * - `readSessionInbox` returns undelivered rows for the given session
   *   (or all rows when `includeDelivered: true`). When called without
   *   `peek`, the caller will follow up with `ackSessionInbox` on the
   *   ids it accepted; this two-step shape lets a flaky reader replay
   *   on crash without losing messages.
   * - `ackSessionInbox` stamps `delivered_at = ?`. Idempotent.
   * - `sweepSessionInbox` deletes delivered rows older than the
   *   threshold (keeps the table from growing unbounded).
   */
  sendSessionMessage(record: Omit<SessionInboxRecord, "id" | "createdAt" | "deliveredAt">, options?: { idGenerator?: () => string; now?: string }): Promise<SessionInboxRecord[]>;
  readSessionInbox(filters: SessionInboxFilters): Promise<SessionInboxRecord[]>;
  ackSessionInbox(userId: string, toSessionKey: string, ids: string[], at: string): Promise<number>;
  sweepSessionInbox(olderThanMs: number): Promise<number>;

  /**
   * Federation Stage 5 (0.4.2) — FED-S5-T2 fallback queue. When
   * `delegate_task` finds no idle peer of the requested kind, the packet
   * is parked here as `pending` until a matching peer claims it.
   * - `enqueuePendingDelegation` parks a packet (status `pending`).
   * - `listPendingDelegations` lists by kind/status for a claimer.
   * - `claimPendingDelegation` atomically flips the oldest matching
   *   `pending` row to `claimed` for `toSessionKey` and returns it (or
   *   null if none). Idempotent racing claimers get distinct rows.
   */
  enqueuePendingDelegation(input: PendingDelegationEnqueueInput, options?: { idGenerator?: () => string; now?: string }): Promise<PendingDelegationRecord>;
  listPendingDelegations(filters: PendingDelegationFilters): Promise<PendingDelegationRecord[]>;
  claimPendingDelegation(userId: string, toAgentKind: string, toSessionKey: string, at: string): Promise<PendingDelegationRecord | null>;

  /**
   * BRAIN-P1 (0.4.1) — `memory_jobs` queue (BRAIN-DESIGN-T2). These
   * are raw persistence primitives; the scheduler layer
   * (`brainrouter/src/memory/scheduler/`) layers idempotency dedup +
   * exponential backoff on top.
   *
   * - `enqueueMemoryJob` inserts a `pending` row and returns it.
   * - `claimNextMemoryJob` atomically (BEGIN IMMEDIATE — cross-process
   *   safe under WAL) picks the highest-priority eligible `pending`
   *   job whose `runAfter` is past, flips it to `running`, stamps
   *   `lockedAt`, and returns it (or null when none are eligible).
   * - `completeMemoryJob` moves a `running` job to `done` with output.
   * - `failMemoryJob` increments `attempts`; re-arms to `pending` with
   *   `runAfter = now + backoffMs` while `attempts < maxAttempts`,
   *   else moves to `failed`.
   * - `retryMemoryJob` re-arms a `failed`/`cancelled` job (attempts→0,
   *   status→pending, runAfter→now). No-op for pending/running/done.
   * - `cancelMemoryJob` forces a job to `cancelled`.
   * - `sweepStuckMemoryJobs` cancels `running` jobs whose `lockedAt`
   *   is older than the cutoff (orphaned by a crashed runner).
   * - `getMemoryJobKindAggregates` rolls jobs up per `kind` for the
   *   `memory_agent_status` tool.
   */
  enqueueMemoryJob(input: MemoryJobEnqueueInput, options?: { idGenerator?: () => string; now?: string }): Promise<MemoryJobRecord>;
  getMemoryJob(id: string): Promise<MemoryJobRecord | null>;
  listMemoryJobs(filters?: MemoryJobListFilters): Promise<MemoryJobRecord[]>;
  appendJobProgress(id: string, event: MemoryJobProgressEvent): Promise<void>;
  claimNextMemoryJob(options?: { now?: string }): Promise<MemoryJobRecord | null>;
  /**
   * Transition a specific `pending` job to `running` (stamps
   * `lockedAt`). The "I already know the id" variant of
   * `claimNextMemoryJob` — used by the synchronous capture fast path
   * that enqueues a job and runs it immediately. Returns null when the
   * job is missing or not `pending`.
   */
  startMemoryJob(id: string, options?: { now?: string }): Promise<MemoryJobRecord | null>;
  completeMemoryJob(id: string, output: unknown, options?: { now?: string }): Promise<MemoryJobRecord | null>;
  failMemoryJob(id: string, error: string, options?: { now?: string; backoffMs?: number }): Promise<MemoryJobRecord | null>;
  retryMemoryJob(id: string, options?: { now?: string }): Promise<MemoryJobRecord | null>;
  cancelMemoryJob(id: string, options?: { now?: string; reason?: string }): Promise<MemoryJobRecord | null>;
  sweepStuckMemoryJobs(stuckMs: number, options?: { now?: string }): Promise<number>;
  getMemoryJobKindAggregates(options?: { now?: string }): Promise<MemoryJobKindAggregate[]>;
  upsertCognitiveVec(recordId: string, embedding: Float32Array): Promise<void>;
  searchCognitiveVec(userId: string, queryEmbedding: Float32Array, limit: number): Promise<VectorSearchResult[]>;
  upsertContradiction(data: {
    id: string;
    userId: string;
    recordIdA: string;
    recordIdB: string;
    reason: string;
    confidence: number;
    createdTime?: string;
  }): Promise<void>;
  getPendingContradictions(userId: string, pagination?: CursorPaginationOptions<{ confidence: number; id: string }>, statusFilter?: "pending" | "resolved" | "dismissed" | "all"): Promise<ContradictionRecord[]>;
  resolveContradiction(id: string, userId: string, status: "resolved" | "dismissed"): Promise<void>;
  upsertSkillHints(skillName: string, hints: string, sourceFile?: string): Promise<void>;
  listSkillHints(): Promise<SkillHintsRecord[]>;
  getSkillHints(skillName: string): Promise<string | null>;
  getSkillActivations(userId: string): Promise<SkillActivationRecord[]>;
  upsertSkillActivations(userId: string, activations: SkillActivationRecord[]): Promise<void>;
  upsertContextualFocus(record: ContextualFocusRecord): Promise<void>;
  getTopContextualFocus(userId: string, limit?: number, cursor?: { heatScore: number; id: string }): Promise<ContextualFocusRecord[]>;
  decayContextualFocusHeatScores(userId: string, decayFactor?: number): Promise<void>;
  boostContextualFocusHeatScore(userId: string, sceneName: string, boost?: number): Promise<void>;
  getCognitivesByFocus(userId: string, sceneName: string, limit?: number): Promise<any[]>;
  getContextualFocusCount(userId: string): Promise<number>;
  getColdContextualFocus(userId: string, limit: number): Promise<ContextualFocusRecord[]>;
  deleteContextualFocus(userId: string, sceneIds: string[]): Promise<void>;
  getContextualFocusByName(userId: string, sceneName: string): Promise<ContextualFocusRecord | null>;
  getDistinctSceneNames(userId: string): Promise<string[]>;
  renameFocusInCognitiveRecords(userId: string, oldName: string, canonicalName: string): Promise<void>;
  upsertCoreIdentity(record: CoreIdentityRecord): Promise<void>;
  getCoreIdentity(userId: string): Promise<CoreIdentityRecord | null>;
  getIdentityAndInstructionCognitives(userId: string, limit?: number): Promise<any[]>;
  getSchedulerState(userId: string): Promise<SchedulerState>;
  incrementSchedulerCognitiveCount(userId: string, count: number): Promise<void>;
  resetSchedulerFocusCount(userId: string): Promise<void>;
  resetSchedulerIdentityCount(userId: string): Promise<void>;
  recordExtractionFailure(userId: string, message: string): Promise<void>;
  resetExtractionFailures(userId: string): Promise<void>;
  getExtractionStatus(userId: string): Promise<ExtractionStatus>;
  sweepUnextractedBacklog(options: { olderThanMs: number; minUnextracted?: number; maxFailures?: number; limit?: number }): Promise<StalledExtractionBacklog[]>;
  getAllGraphNodes(userId: string): Promise<GraphNode[]>;
  upsertGraphNode(node: GraphNode): Promise<void>;
  upsertGraphEdge(edge: GraphEdge): Promise<void>;
  getGraphNodeByEntity(userId: string, entity: string): Promise<GraphNode | null>;
  getGraphNeighbors(userId: string, entityId: string, skillTag?: string, maxHops?: number): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }>;
  markCited(userId: string, recordIds: string[]): Promise<void>;
  incrementNeverCited(userId: string, recordIds: string[]): Promise<{ recordId: string; neverCitedCount: number }[]>;
  archiveCognitiveRecord(userId: string, recordId: string): Promise<void>;
  getRecentSkillContextCognitives(userId: string, limit: number): Promise<{ skillTag: string; createdTime: string }[]>;
  createUser(userId: string, apiKey: string, displayName?: string, isAdmin?: boolean): Promise<UserRecord>;
  getUserByApiKey(apiKey: string): Promise<UserRecord | null>;
  getUserByEmail(email: string): Promise<UserRecord | null>;
  getUserById(userId: string): Promise<UserRecord | null>;
  updateUserPassword(userId: string, passwordHash: string): Promise<void>;
  updateUserEmail(userId: string, email: string): Promise<void>;
  updateUserDisplayName(userId: string, displayName: string): Promise<void>;
  updateUserStatus(userId: string, status: "active" | "disabled"): Promise<void>;
  updateUserApiKey(userId: string, apiKey: string): Promise<void>;
  listUsers(pagination?: CursorPaginationOptions<{ createdAt: string; userId: string }>): Promise<UserRecord[]>;
  deleteUser(userId: string): Promise<void>;
  listMemories(
    userId: string,
    filters?: MemoryListFilters,
    pagination?: CursorPaginationOptions<{ createdTime: string; recordId: string }>
  ): Promise<MemoryListItem[]>;
  getMemoryStats(userId: string): Promise<{
    total: number;
    archived: number;
    byType: Record<string, number>;
    citationRate: number;
    lastRecallAt: string | null;
    /** Rows in sensory_stream — always written on capture, even when
     *  cognitive extraction hasn't run yet. Distinguishes "capture is
     *  firing but extractor lagging" from "nothing captured at all". */
    sensoryTotal: number;
    /** Sensory rows the cognitive extractor hasn't consumed yet. */
    sensoryUnextracted: number;
    /** Rows in contextual_focus for this user. */
    focusSceneTotal: number;
    extraction: ExtractionStatus;
  }>;
  upsertConnection(userId: string, sourceId: string, targetId: string, weight: number): Promise<void>;
  getConnectionsForSource(userId: string, sourceId: string): Promise<Array<{ targetId: string; weight: number }>>;
  strengthenConnectionsBatch(userId: string, pairs: Array<{ source: string; target: string }>, delta: number): Promise<void>;
  decayConnections(userId: string, decayFactor: number): Promise<void>;
  pruneConnections(userId: string, threshold: number): Promise<void>;
  getAllConnections(userId: string): Promise<Array<{ sourceId: string; targetId: string; weight: number; lastActivatedAt: string }>>;

  // ── Atlas graph persistence (REMOTE-BRAIN Phase 3) ──────────────────────
  // The brain stores a client-built Atlas graph per (tenant, workspace) so a
  // remote/cloud brain — or the dashboard as a remote client — can serve it
  // back. `build` stays client-side (it scans the filesystem); this is the
  // store-and-serve half. All methods are tenant-scoped by `userId`.
  /** Upsert a workspace's Atlas graph for a tenant (keyed by user + workspaceTag). */
  putAtlasGraph(userId: string, workspaceTag: string, graph: AtlasGraph): Promise<void>;
  /** Fetch a tenant's stored Atlas graph for a workspace, or null when absent. */
  getAtlasGraph(userId: string, workspaceTag: string): Promise<AtlasGraph | null>;
  /** List a tenant's stored Atlas workspaces, most-recently-updated first. */
  listAtlasWorkspaces(userId: string): Promise<AtlasWorkspaceSummary[]>;

  // HONK-H3.3 — fleet snapshot store-and-serve (the dashboard console reads these).
  /** Upsert a fleet host's queue snapshot for a tenant (keyed by user + host). */
  putFleetSnapshot(userId: string, host: string, snapshot: unknown, jobCount: number): Promise<void>;
  /** List a tenant's stored fleet snapshots (one per host), most-recent first. */
  getFleetSnapshots(userId: string): Promise<FleetSnapshotEntry[]>;
}
