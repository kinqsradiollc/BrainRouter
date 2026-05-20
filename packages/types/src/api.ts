import type {
  EvidenceKind,
  ContradictionRecord,
  DiagnosticsBundle,
  ImportResult,
  L1Record,
  L2SceneRecord,
  MemoryEvidence,
  MemoryExport,
  MemoryImport,
  MemoryOperation,
  MemoryStatus,
  RecallResult,
} from "./memory.js";
import type { MemoryListItem } from "./store.js";
import { PublicUserRecord } from "./memory.js";

export interface SigninRequest {
  email: string;
  password?: string;
}

export interface SigninResponse {
  jwt: string;
  userId: string;
  isAdmin: boolean;
  displayName: string;
  apiKey: string;
}

export interface SignupRequest {
  email: string;
  password?: string;
  displayName?: string;
}

export interface SignupResponse {
  jwt: string;
  userId: string;
  isAdmin: boolean;
  displayName: string;
}

export interface MeResponse extends PublicUserRecord {
  apiKey: string;
  mcpPath?: string;
}

export interface UserStatusRequest {
  status: "active" | "disabled";
}

export interface UserResetKeyResponse {
  apiKey: string;
}

export interface CursorPaginationParams {
  cursor?: string;
  limit?: number;
}

export interface CursorPaginatedResponse<T> {
  nextCursor: string | null;
  limit: number;
  hasMore: boolean;
  data: T[];
}

export interface NamedCursorPaginatedResponse<T, K extends string> {
  nextCursor: string | null;
  limit: number;
  hasMore: boolean;
  [key: string]: T[] | string | number | boolean | null;
}

export interface MemoryStatsResponse {
  total: number;
  archived: number;
  byType: Record<string, number>;
  citationRate: number;
  lastRecallAt: string | null;
  extraction: unknown;
}

export type MemoriesResponse = {
  memories: MemoryListItem[];
  nextCursor: string | null;
  limit: number;
  hasMore: boolean;
};

export type OperationsResponse = {
  operations: MemoryOperation[];
  nextCursor: string | null;
  limit: number;
  hasMore: boolean;
};

export type EvidenceResponse = {
  evidence: MemoryEvidence[];
  nextCursor: string | null;
  limit: number;
  hasMore: boolean;
};

export type ScenesResponse = {
  scenes: L2SceneRecord[];
  nextCursor: string | null;
  limit: number;
  hasMore: boolean;
};

export type ContradictionsResponse = {
  contradictions: ContradictionRecord[];
  nextCursor: string | null;
  limit: number;
  hasMore: boolean;
};

export type DiagnosticsResponse = DiagnosticsBundle;

export interface MemoryWithEvidenceResponse {
  memory: L1Record;
  evidence: MemoryEvidence[];
}

export interface MemoryEvidenceByRecordResponse {
  evidence: MemoryEvidence[];
  total?: number;
}

export interface UpdateMemoryRequest {
  content?: string;
  status?: MemoryStatus;
  confidence?: number;
  verificationStatus?: L1Record["verificationStatus"];
  note?: string;
}

export interface AddEvidenceRequest {
  kind: EvidenceKind;
  ref: string;
  excerpt?: string;
  metadata?: Record<string, unknown>;
}

export interface AddEvidenceResponse {
  evidence: MemoryEvidence;
}

export interface ExplainRecallRequest {
  query: string;
  sessionKey?: string;
  activeSkill?: string;
  userId?: string;
}

export type ExplainRecallResponse = RecallResult;

export interface WorkingStep {
  nodeId: string;
  title: string;
  summary: string;
  kind: string;
  createdAt: string;
  refPath?: string;
  tokenEstimate: number;
}

export type TokenPressureLevel = "none" | "mild" | "aggressive";

export interface WorkingMemoryState {
  sessionKey: string;
  workDir: string;
  pressureLevel: TokenPressureLevel;
  contextWindowTokens: number;
  estimatedTokens: number;
  injectedState: {
    currentNode?: WorkingStep;
    recentSteps: WorkingStep[];
    refs: Array<{ nodeId: string; refPath?: string; title: string }>;
    rawPayloadsIncluded: false;
  };
  updatedAt: string;
}

export interface WorkingContextRequest extends CursorPaginationParams {
  workspacePath?: string;
  userId?: string;
  sessionKey: string;
  nodeId?: string;
  activeNodeId?: string;
  contextWindowTokens?: number;
  estimatedTokens?: number;
}

export interface WorkingContextResponse {
  sessionKey: string;
  workDir: string;
  canvas: string;
  annotatedCanvas?: string;
  state: WorkingMemoryState;
  steps: WorkingStep[];
  ref?: {
    nodeId: string;
    path: string;
    content: string;
  };
}

export interface WorkingOffloadRequest {
  workspacePath?: string;
  userId?: string;
  sessionKey: string;
  payload: string;
  title?: string;
  summary?: string;
  kind?: string;
  contextWindowTokens?: number;
  estimatedTokens?: number;
  forceAggressive?: boolean;
}

export interface WorkingOffloadResponse {
  nodeId: string;
  refPath: string;
  pressureLevel: TokenPressureLevel;
  canvas: string;
  state: WorkingMemoryState;
}

export interface WorkingResetRequest {
  workspacePath?: string;
  userId?: string;
  sessionKey: string;
}

export interface WorkingResetResponse {
  deleted: boolean;
  workDir: string;
}

export type HostHookSource = "claude-code" | "codex" | "generic-mcp";

export interface RegisteredHook {
  id: string;
  userId: string;
  source: HostHookSource | string;
  events: string[];
  sessionKey?: string;
  workspacePath?: string;
  registeredAt: string;
  lastSeenAt: string | null;
  lastEvent: string | null;
  metadata: Record<string, unknown>;
}

export interface HookRegisterRequest {
  source: HostHookSource;
  events?: string[];
  userId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspacePath?: string;
  event?: string;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface HookRegisterResponse {
  registered: RegisteredHook;
  captureResult?: {
    hookId: string;
    l0RecordedCount: number;
    l0RecordId: string;
    flushedWorkingMemory: boolean;
  };
}

export interface HookStatusParams {
  source?: HostHookSource;
  userId?: string;
}

export interface HookStatusResponse {
  hooks: RegisteredHook[];
}

export type ExportMemoriesResponse = MemoryExport;
export type ImportMemoriesRequest = MemoryImport;
export type ImportMemoriesResponse = ImportResult;

export interface ActiveSessionInfo {
  sessionKey: string;
  workspaceId: string;
  updatedAt: string;
}

export interface ActiveSessionsResponse {
  sessions: ActiveSessionInfo[];
}
