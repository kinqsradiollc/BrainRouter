import type {
  ActiveSessionFilters,
  ActiveSessionRecord,
  ActiveSessionUsage,
  SessionInboxFilters,
  SessionInboxKind,
  SessionInboxRecord,
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

export interface IMemoryStore {
  init(): void;
  initVec(dimensions: number): void;
  reembedStaleRecords(embedder: (text: string) => Promise<Float32Array>): Promise<number>;
  getSqliteVersion(): string;
  upsertSensory(record: SensoryRecord): void;
  getRecentSensoryMessages(userId: string, sessionKey: string, limit: number, afterIsoTime?: string): SensoryRecord[];
  getUnextractedSensoryCount(userId: string, sessionKey: string): number;
  markSensoryExtracted(userId: string, sessionKey: string, recordIds: string[], extractedAt?: string): void;
  upsertCognitive(record: CognitiveRecord, options?: { skipAudit?: boolean }): void;
  /** Batch upsert with optional embedding vectors. Pass skipAudit to suppress per-record
   * cognitive_upsert noise when the caller will write a higher-level audit entry itself. */
  upsertCognitiveBatch(entries: Array<{ record: CognitiveRecord; embedding?: Float32Array }>, options?: { skipAudit?: boolean }): void;
  invalidateCognitiveRecord(userId: string, recordId: string, supersededById: string): void;
  getMemoryById(userId: string, recordId: string): CognitiveRecord | null;
  getMemoriesByFilePath(userId: string, filePath: string, limit: number): CognitiveRecord[];
  updateCognitiveConfidence(userId: string, recordId: string, confidence: number, status: MemoryStatus): void;
  insertEvidence(ev: MemoryEvidence): void;
  getEvidenceByRecord(userId: string, recordId: string): MemoryEvidence[];
  listEvidence(
    userId: string,
    filters?: EvidenceListFilters,
    pagination?: CursorPaginationOptions<{ observedAt: string; id: string }>
  ): MemoryEvidence[];
  /** Write an audit operation. Kept on the interface because the engine layer needs to
   * correlate external events (memory_update, import) with store writes atomically.
   * It is NOT intended for use by any caller outside of SqliteMemoryStore or MemoryEngine. */
  insertOperation(op: MemoryOperation): void;
  getOperationLog(
    userId: string,
    options?: CursorPaginationOptions<{ createdAt: string; id: string }>,
    filters?: OperationLogFilters
  ): MemoryOperation[];
  exportMemories(userId: string): MemoryExport;
  importMemories(userId: string, data: MemoryImport): ImportResult;
  hardDeleteMemory(userId: string, recordId: string, reason: string): void;
  searchCognitiveFts(userId: string, query: string, limit: number): CognitiveFtsResult[];
  searchCognitiveFtsAsOf(userId: string, query: string, limit: number, asOf: string): CognitiveFtsResult[];
  /**
   * Federation Stage 1 (0.4.0) — batch lookup of `workspace_tag` for a
   * set of record ids. Used by the recall pipeline when a workspace
   * filter is set, to apply the NULL-tolerant scope after FTS / vector
   * / filepath candidate gathering. Missing record ids and NULL tags
   * both map to `null` in the returned map.
   */
  getWorkspaceTagsByRecordIds(userId: string, recordIds: string[]): Map<string, string | null>;

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
  registerActiveSession(record: ActiveSessionRecord): ActiveSessionRecord;
  heartbeatActiveSession(
    userId: string,
    sessionKey: string,
    at: string,
    usage?: ActiveSessionUsage | null,
  ): boolean;
  /**
   * Federation Stage 2 follow-up: graceful unregister on clean CLI exit.
   * Returns `true` when a row was deleted, `false` when no matching row
   * existed (idempotent — safe to call multiple times). The 5-min
   * sweeper still acts as the safety net for hard kills.
   */
  unregisterActiveSession(userId: string, sessionKey: string): boolean;
  listActiveSessions(filters: ActiveSessionFilters): ActiveSessionRecord[];
  sweepActiveSessions(olderThanMs: number): number;

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
  sendSessionMessage(record: Omit<SessionInboxRecord, "id" | "createdAt" | "deliveredAt">, options?: { idGenerator?: () => string; now?: string }): SessionInboxRecord[];
  readSessionInbox(filters: SessionInboxFilters): SessionInboxRecord[];
  ackSessionInbox(userId: string, toSessionKey: string, ids: string[], at: string): number;
  sweepSessionInbox(olderThanMs: number): number;
  upsertCognitiveVec(recordId: string, embedding: Float32Array): void;
  searchCognitiveVec(userId: string, queryEmbedding: Float32Array, limit: number): VectorSearchResult[];
  upsertContradiction(data: {
    id: string;
    userId: string;
    recordIdA: string;
    recordIdB: string;
    reason: string;
    confidence: number;
    createdTime?: string;
  }): void;
  getPendingContradictions(userId: string, pagination?: CursorPaginationOptions<{ confidence: number; id: string }>): ContradictionRecord[];
  resolveContradiction(id: string, userId: string, status: "resolved" | "dismissed"): void;
  upsertSkillHints(skillName: string, hints: string, sourceFile?: string): void;
  listSkillHints(): SkillHintsRecord[];
  getSkillHints(skillName: string): string | null;
  getSkillActivations(userId: string): SkillActivationRecord[];
  upsertSkillActivations(userId: string, activations: SkillActivationRecord[]): void;
  upsertContextualFocus(record: ContextualFocusRecord): void;
  getTopContextualFocus(userId: string, limit?: number, cursor?: { heatScore: number; id: string }): ContextualFocusRecord[];
  decayContextualFocusHeatScores(userId: string, decayFactor?: number): void;
  boostContextualFocusHeatScore(userId: string, sceneName: string, boost?: number): void;
  getCognitivesByFocus(userId: string, sceneName: string, limit?: number): any[];
  getContextualFocusCount(userId: string): number;
  getColdContextualFocus(userId: string, limit: number): ContextualFocusRecord[];
  deleteContextualFocus(userId: string, sceneIds: string[]): void;
  getContextualFocusByName(userId: string, sceneName: string): ContextualFocusRecord | null;
  getDistinctSceneNames(userId: string): string[];
  renameFocusInCognitiveRecords(userId: string, oldName: string, canonicalName: string): void;
  upsertCoreIdentity(record: CoreIdentityRecord): void;
  getCoreIdentity(userId: string): CoreIdentityRecord | null;
  getIdentityAndInstructionCognitives(userId: string, limit?: number): any[];
  getSchedulerState(userId: string): SchedulerState;
  incrementSchedulerCognitiveCount(userId: string, count: number): void;
  resetSchedulerFocusCount(userId: string): void;
  resetSchedulerIdentityCount(userId: string): void;
  recordExtractionFailure(userId: string, message: string): void;
  resetExtractionFailures(userId: string): void;
  getExtractionStatus(userId: string): ExtractionStatus;
  sweepUnextractedBacklog(options: { olderThanMs: number; minUnextracted?: number; maxFailures?: number; limit?: number }): StalledExtractionBacklog[];
  getAllGraphNodes(userId: string): GraphNode[];
  upsertGraphNode(node: GraphNode): void;
  upsertGraphEdge(edge: GraphEdge): void;
  getGraphNodeByEntity(userId: string, entity: string): GraphNode | null;
  getGraphNeighbors(userId: string, entityId: string, skillTag?: string, maxHops?: number): { nodes: GraphNode[]; edges: GraphEdge[] };
  markCited(userId: string, recordIds: string[]): void;
  incrementNeverCited(userId: string, recordIds: string[]): { recordId: string; neverCitedCount: number }[];
  archiveCognitiveRecord(userId: string, recordId: string): void;
  getRecentSkillContextCognitives(userId: string, limit: number): { skillTag: string; createdTime: string }[];
  createUser(userId: string, apiKey: string, displayName?: string, isAdmin?: boolean): UserRecord;
  getUserByApiKey(apiKey: string): UserRecord | null;
  getUserByEmail(email: string): UserRecord | null;
  getUserById(userId: string): UserRecord | null;
  updateUserPassword(userId: string, passwordHash: string): void;
  updateUserEmail(userId: string, email: string): void;
  updateUserDisplayName(userId: string, displayName: string): void;
  updateUserStatus(userId: string, status: "active" | "disabled"): void;
  updateUserApiKey(userId: string, apiKey: string): void;
  listUsers(pagination?: CursorPaginationOptions<{ createdAt: string; userId: string }>): UserRecord[];
  deleteUser(userId: string): void;
  listMemories(
    userId: string,
    filters?: MemoryListFilters,
    pagination?: CursorPaginationOptions<{ createdTime: string; recordId: string }>
  ): MemoryListItem[];
  getMemoryStats(userId: string): {
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
  };
  upsertConnection(userId: string, sourceId: string, targetId: string, weight: number): void;
  getConnectionsForSource(userId: string, sourceId: string): Array<{ targetId: string; weight: number }>;
  strengthenConnectionsBatch(userId: string, pairs: Array<{ source: string; target: string }>, delta: number): void;
  decayConnections(userId: string, decayFactor: number): void;
  pruneConnections(userId: string, threshold: number): void;
  getAllConnections(userId: string): Array<{ sourceId: string; targetId: string; weight: number; lastActivatedAt: string }>;
}
