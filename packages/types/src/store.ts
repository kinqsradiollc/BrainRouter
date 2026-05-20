import type {
  GraphEdge,
  GraphNode,
  ContradictionRecord,
  ImportResult,
  L0Record,
  L1FtsResult,
  L1Record,
  L2SceneRecord,
  L3PersonaRecord,
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
  upsertL0(record: L0Record): void;
  getRecentL0Messages(userId: string, sessionKey: string, limit: number, afterIsoTime?: string): L0Record[];
  getUnextractedL0Count(userId: string, sessionKey: string): number;
  markL0Extracted(userId: string, sessionKey: string, recordIds: string[], extractedAt?: string): void;
  upsertL1(record: L1Record, options?: { skipAudit?: boolean }): void;
  /** Batch upsert with optional embedding vectors. Pass skipAudit to suppress per-record
   * l1_upsert noise when the caller will write a higher-level audit entry itself. */
  upsertL1Batch(entries: Array<{ record: L1Record; embedding?: Float32Array }>, options?: { skipAudit?: boolean }): void;
  invalidateL1Record(userId: string, recordId: string, supersededById: string): void;
  getMemoryById(userId: string, recordId: string): L1Record | null;
  getMemoriesByFilePath(userId: string, filePath: string, limit: number): L1Record[];
  updateL1Confidence(userId: string, recordId: string, confidence: number, status: MemoryStatus): void;
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
  searchL1Fts(userId: string, query: string, limit: number): L1FtsResult[];
  searchL1FtsAsOf(userId: string, query: string, limit: number, asOf: string): L1FtsResult[];
  upsertL1Vec(recordId: string, embedding: Float32Array): void;
  searchL1Vec(userId: string, queryEmbedding: Float32Array, limit: number): VectorSearchResult[];
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
  upsertL2Scene(record: L2SceneRecord): void;
  getTopL2Scenes(userId: string, limit?: number, cursor?: { heatScore: number; id: string }): L2SceneRecord[];
  decayL2HeatScores(userId: string, decayFactor?: number): void;
  boostL2HeatScore(userId: string, sceneName: string, boost?: number): void;
  getL1sByScene(userId: string, sceneName: string, limit?: number): any[];
  getL2SceneCount(userId: string): number;
  getColdL2Scenes(userId: string, limit: number): L2SceneRecord[];
  deleteL2Scenes(userId: string, sceneIds: string[]): void;
  getL2SceneByName(userId: string, sceneName: string): L2SceneRecord | null;
  getDistinctSceneNames(userId: string): string[];
  renameSceneInL1Records(userId: string, oldName: string, canonicalName: string): void;
  upsertL3Persona(record: L3PersonaRecord): void;
  getL3Persona(userId: string): L3PersonaRecord | null;
  getPersonaAndInstructionL1s(userId: string, limit?: number): any[];
  getSchedulerState(userId: string): SchedulerState;
  incrementSchedulerL1Count(userId: string, count: number): void;
  resetSchedulerL2Count(userId: string): void;
  resetSchedulerL3Count(userId: string): void;
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
  archiveL1Record(userId: string, recordId: string): void;
  getRecentSkillContextL1s(userId: string, limit: number): { skillTag: string; createdTime: string }[];
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
    extraction: ExtractionStatus;
  };
}
