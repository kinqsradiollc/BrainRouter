/**
 * Shared types + leaf helpers for the useAgentEvents hook and its extracted
 * event / query-result handlers. Split out of useAgentEvents.ts byte-identically
 * so the handler modules and the hook shell reference one canonical definition
 * (no import cycle — this module imports nothing from its siblings).
 */
import type React from 'react';
import type { InteractionRequest } from '@kinqs/brainrouter-agent-protocol';
import type { AttachmentUpload, PlanItem, ToolItem, ChatRow, ChangesetFile, SessionRow, FleetRow, TaskViewState, WorkflowDetail } from '../../../types.js';
import type { TrackProject, WorkItem, Sprint, Module, SavedView, AutomationRule, ProjectMember } from '@kinqs/brainrouter-types';
import type { GitTrackContext, SyncConfig, SyncResult, TrackPrStatus } from '../../../track/TrackView.js';
import type { SearchHit, ReviewFindingView, GrepHit } from '../../../panels/index.js';
import type { ScheduleRecordView } from '../../schedule/scheduleView.js';
import type { PlanDecisionView } from '../../plan/planReviewView.js';
import type { RequirementRecord, AnnotationRecord, ArtifactRecord, AtlasGraph } from '@kinqs/brainrouter-types';
import type { CommandsCatalog } from '../../commands/commands.js';
import type { ConfigSnapshot, UsageHistory } from '../../../settings.js';
import { type WorktreeEntry } from '../../worktree/worktreeParser.js';
import { type ProjectSessionsByRoot } from '../../session/workspaces/projectSessionsView.js';

export type InfoState = { sessionKey?: string; model?: string; workspaceRoot?: string; username?: string };
export type GitInfoState = { repo: string; branch: string | null; insertions: number; deletions: number; gitRoot?: string | null; repoRelativePath?: string; isSubdir?: boolean } | null;
export type HomeStatsState = {
  sessions: number; turns: number; activeDays: number; currentStreak: number;
  longestStreak: number; model: string; perDay: Record<string, number>;
} | null;
export type BranchesState = { current: string | null; branches: string[]; loading?: boolean };
export type ReviewView = { findings: ReviewFindingView[]; summary: string; files: number };
export type GateView = { status: string; blocked: boolean; reason: string };
const WORKSPACE_SCOPED_REVIEW_QUERY_IDS = new Set(['q-review-diff', 'q-review-current', 'q-review-gate', 'q-review-fix']);

export function isWorkspaceScopedReviewQuery(id: string): boolean {
  return WORKSPACE_SCOPED_REVIEW_QUERY_IDS.has(id);
}

/** Tool enable/disable catalog (the `tool-catalog` query result). */
export interface ToolCatalog {
  builtin: Array<{ name: string; description: string; protected: boolean }>;
  mcp: Array<{ server: string; name: string }>;
}

export interface AgentEventsCtx {
  setRows: React.Dispatch<React.SetStateAction<ChatRow[]>>;
  setRunning: React.Dispatch<React.SetStateAction<boolean>>;
  setStopping: React.Dispatch<React.SetStateAction<boolean>>;
  setTurnStart: React.Dispatch<React.SetStateAction<number>>;
  setStatusLine: React.Dispatch<React.SetStateAction<string>>;
  setReasoningTail: React.Dispatch<React.SetStateAction<string>>;
  setLiveText: React.Dispatch<React.SetStateAction<string>>;
  setToolLog: React.Dispatch<React.SetStateAction<Array<{ id: number; tool: string; ok: boolean; summary: string }>>>;
  setLiveChildren: React.Dispatch<React.SetStateAction<Record<string, { childId: string; role: string; tool?: string; startedAt: number }>>>;
  setFinishedTasks: React.Dispatch<React.SetStateAction<Array<{ id: string; label: string; status: string }>>>;
  setLastPlan: React.Dispatch<React.SetStateAction<{ items: PlanItem[]; explanation?: string } | null>>;
  setGoalState: React.Dispatch<React.SetStateAction<import('../../../components/GoalBanner.js').GoalRecord | null>>;
  setPlanHistory: React.Dispatch<React.SetStateAction<PlanDecisionView[]>>;
  setTokens: React.Dispatch<React.SetStateAction<{ promptTokens: number; completionTokens: number; turns: number; cachedTokens?: number } | null>>;
  // LIVE per-call usage for the in-flight turn (cleared at turn-start/end) so the
  // Context panel's token total ticks up during the turn, not only at turn-end.
  setLiveTurn: React.Dispatch<React.SetStateAction<{ promptTokens: number; completionTokens: number; calls: number; cachedTokens?: number } | null>>;
  // Session efficiency counters (cache reuse rides on `tokens`; compaction + memory
  // recall are counted here from their events). Reset on session-changed.
  setEfficiency: React.Dispatch<React.SetStateAction<{ compactions: number; droppedMessages: number; memoriesRecalled: number }>>;
  // Track mode data (project + work items + sprints), fed by the host `track-*` queries.
  setTrack: React.Dispatch<React.SetStateAction<{ project: TrackProject | null; items: WorkItem[]; sprints: Sprint[]; modules: Module[]; views: SavedView[]; automations: AutomationRule[]; members: ProjectMember[]; sync: { config: SyncConfig | null; result: SyncResult | null }; git: GitTrackContext | null; pr: TrackPrStatus | null }>>;
  setInteraction: React.Dispatch<React.SetStateAction<InteractionRequest | null>>;
  setPicked: React.Dispatch<React.SetStateAction<string[]>>;
  setViewKey: React.Dispatch<React.SetStateAction<string>>;
  setTaskView: React.Dispatch<React.SetStateAction<TaskViewState | null>>;
  setWorkflowView: React.Dispatch<React.SetStateAction<WorkflowDetail | null>>;
  setInfo: React.Dispatch<React.SetStateAction<InfoState>>;
  setWorkspaces: React.Dispatch<React.SetStateAction<{ current: string | null; recents: string[] }>>;
  setRunningWs: React.Dispatch<React.SetStateAction<Set<string>>>;
  setHostUp: React.Dispatch<React.SetStateAction<boolean>>;
  setLastTurnFails: React.Dispatch<React.SetStateAction<number | null>>;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  setProjSessions: React.Dispatch<React.SetStateAction<ProjectSessionsByRoot>>;
  setSessions: React.Dispatch<React.SetStateAction<SessionRow[]>>;
  setPrInfo: React.Dispatch<React.SetStateAction<{ number: number; state: string; title?: string } | null>>;
  setContextUsage: React.Dispatch<React.SetStateAction<{ used: number; window: number; compactAt: number; limit: number; pct: number } | null>>;
  setFleet: React.Dispatch<React.SetStateAction<FleetRow[]>>;
  setRecentTasks: React.Dispatch<React.SetStateAction<FleetRow[]>>;
  setChangedFiles: React.Dispatch<React.SetStateAction<Array<{ status: string; path: string }>>>;
  setDiffView: React.Dispatch<React.SetStateAction<{ path: string; diff: string } | null>>;
  setInlineDiffs: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setAllFiles: React.Dispatch<React.SetStateAction<string[]>>;
  setFileView: React.Dispatch<React.SetStateAction<{ path: string; content: string; error?: string } | null>>;
  setGitInfo: React.Dispatch<React.SetStateAction<GitInfoState>>;
  setCommitSubjects: React.Dispatch<React.SetStateAction<string[]>>;
  setHomeStats: React.Dispatch<React.SetStateAction<HomeStatsState>>;
  setBranches: React.Dispatch<React.SetStateAction<BranchesState>>;
  setModelsLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setEndpointModels: React.Dispatch<React.SetStateAction<string[]>>;
  setToolCatalog: React.Dispatch<React.SetStateAction<ToolCatalog>>;
  setProviderModels: React.Dispatch<React.SetStateAction<Record<string, string[]>>>;
  setProbedModels: React.Dispatch<React.SetStateAction<string[]>>;
  setProbeLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setProbeError: React.Dispatch<React.SetStateAction<string>>;
  setCatalog: React.Dispatch<React.SetStateAction<CommandsCatalog | null>>;
  setSnapshot: React.Dispatch<React.SetStateAction<ConfigSnapshot | null>>;
  setUsageLines: React.Dispatch<React.SetStateAction<string[]>>;
  setUsageHistory: React.Dispatch<React.SetStateAction<UsageHistory | null>>;
  setSearchHits: React.Dispatch<React.SetStateAction<SearchHit[] | null>>;
  setSchedules: React.Dispatch<React.SetStateAction<ScheduleRecordView[]>>;
  setRequirements: React.Dispatch<React.SetStateAction<RequirementRecord[]>>;
  setAnnotations: React.Dispatch<React.SetStateAction<AnnotationRecord[]>>;
  setArtifacts: React.Dispatch<React.SetStateAction<ArtifactRecord[]>>;
  setAtlasGraph: React.Dispatch<React.SetStateAction<AtlasGraph | null>>;
  setAtlasBuilding: React.Dispatch<React.SetStateAction<boolean>>;
  setAtlasEnriching: React.Dispatch<React.SetStateAction<boolean>>;
  setAtlasAssessing: React.Dispatch<React.SetStateAction<string | null>>;
  setAtlasAssessments: React.Dispatch<React.SetStateAction<Record<string, import('../../atlas/atlasView.js').AtlasChangeAssessment>>>;
  setWorktrees: React.Dispatch<React.SetStateAction<WorktreeEntry[]>>;
  setWorktreeDiffs: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setReviewRunningByWs: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  setReviewByWs: React.Dispatch<React.SetStateAction<Record<string, ReviewView | null>>>;
  setReviewGateByWs: React.Dispatch<React.SetStateAction<Record<string, GateView | null>>>;
  setGateBlock: React.Dispatch<React.SetStateAction<{ kind: 'commit' | 'push'; msg?: string; reason: string; status: string } | null>>;
  setGrepHits: React.Dispatch<React.SetStateAction<GrepHit[] | null>>;
  setSessionGroups: React.Dispatch<React.SetStateAction<string[]>>;
  setGitBusy: React.Dispatch<React.SetStateAction<boolean>>;
  setInfoDialog: React.Dispatch<React.SetStateAction<{ title: string; body: string } | null>>;
  setToast: React.Dispatch<React.SetStateAction<string>>;
  setFilesLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setFilesTruncated: React.Dispatch<React.SetStateAction<boolean>>;
  setFilesError: React.Dispatch<React.SetStateAction<string>>;
  setAttachmentUploads: React.Dispatch<React.SetStateAction<AttachmentUpload[]>>;
  setAtBottom: React.Dispatch<React.SetStateAction<boolean>>;

  liveBuf: React.MutableRefObject<string>;
  liveFlushPending: React.MutableRefObject<boolean>;
  activeWsRef: React.MutableRefObject<string | null>;
  sessionKeyRef: React.MutableRefObject<string | undefined>;
  turnFailsRef: React.MutableRefObject<number>;
  runningSessionsRef: React.MutableRefObject<Set<string>>;
  pendingWorkspaceRef: React.MutableRefObject<string | null>;
  pendingResumeRef: React.MutableRefObject<string | null>;
  errorsBySession: React.MutableRefObject<Record<string, Array<{ id: number; text: string; detail?: string; ts: number }>>>;
  lastPromptRef: React.MutableRefObject<string>;
  planFeedbackRef: React.MutableRefObject<string>;
  goalContPendingRef: React.MutableRefObject<string | null>;
  workspaceGenRef: React.MutableRefObject<number>;
  pendingSessionsRef: React.MutableRefObject<SessionRow[]>;
  sessionsRef: React.MutableRefObject<SessionRow[]>;
  atBottomRef: React.MutableRefObject<boolean>;
  cardOpenRef: React.MutableRefObject<boolean>;
  chatEnd: React.RefObject<HTMLDivElement>;
  chatRef: React.RefObject<HTMLDivElement>;
  pendingGitRef: React.MutableRefObject<{ kind: 'commit' | 'push'; msg?: string; root: string } | null>;
  pendingCmdRef: React.MutableRefObject<string>;
  cachedSessionRowsRef: React.MutableRefObject<Record<string, ChatRow[]>>;

  q: (id: string, name: string, args?: Record<string, unknown>) => void;
  refreshSession: () => void;
  refreshSidebar: () => void;
  runGit: (kind: 'commit' | 'push' | 'pull', msg?: string, opts?: { bypass?: boolean; reviewed?: boolean }) => void;
  setSessionRunning: (key: string, on: boolean) => void;
  info: InfoState;
  gitInfo: GitInfoState;
  homeStats: HomeStatsState;
  branches: BranchesState;
}

export function getStableRowId(sessionKey: string, r: { id?: string | number; kind: string; text?: string; ts?: number; cmd?: string; items?: any[] }, index?: number): string {
  if (typeof r.id === 'string' && r.id.startsWith(sessionKey + '-')) {
    return r.id;
  }
  const ts = r.ts ?? 0;
  let contentPart = '';
  if (r.text) {
    contentPart = r.text.slice(0, 32);
  } else if (r.cmd) {
    contentPart = r.cmd.slice(0, 32);
  } else if (r.items && r.items.length) {
    contentPart = r.items.map((it: any) => it.tool).join(',');
  }
  contentPart = contentPart.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 32);
  const indexSuffix = index !== undefined ? `-${index}` : '';
  return `${sessionKey || 'global'}-${r.kind}-${ts}-${contentPart}${indexSuffix}`;
}
