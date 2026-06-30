/**
 * useAgentEvents — the mount-once agent-event subscription extracted from App.tsx.
 *
 * Owns the `window.brainrouter.onEvent` subscription (live turn lifecycle, tool
 * cards, per-session/per-workspace routing) and the `handleQueryResult` router
 * that dispatches every `q-*`/`a-*` query result back onto App state. Everything
 * the bodies touch is App-local state and is injected via `AgentEventsCtx`; this
 * file only imports the module-level helpers/types the moved code references.
 *
 * Behavior is identical to the original in-component code: the effect runs ONCE
 * on mount (empty deps + the intentional eslint-disable), and handleQueryResult
 * is a hoisted function declaration so the effect can call it before it appears.
 */
import { useEffect, useRef } from 'react';
import type React from 'react';
import type { AgentEvent, AgentEventMessage, InteractionRequest } from '@kinqs/brainrouter-agent-protocol';
import type { AttachmentUpload, PlanItem, ToolItem, ChatRow, ChangesetFile, SessionRow, FleetRow, TaskViewState, WorkflowDetail } from '../../types.js';
import type { TrackProject, WorkItem, Sprint, AutomationRule, ProjectMember } from '@kinqs/brainrouter-types';
import type { GitTrackContext, SyncConfig, SyncResult, TrackPrStatus } from '../../track/TrackView.js';
import type { SearchHit, ReviewFindingView, GrepHit } from '../../panels/index.js';
import type { ScheduleRecordView } from '../schedule/scheduleView.js';
import type { PlanDecisionView } from '../plan/planReviewView.js';
import type { RequirementRecord, AnnotationRecord, ArtifactRecord, AtlasGraph } from '@kinqs/brainrouter-types';
import type { CommandsCatalog } from '../commands/commands.js';
import type { ConfigSnapshot, UsageHistory } from '../../settings.js';
import { parseWorktreeList, type WorktreeEntry } from '../worktree/worktreeParser.js';
import { mergeOptimistic, dropPending } from '../session/sessionOrder.js';
import { normalizeProjectSessionsResult, withCachedProjectSessions, type ProjectSessionsByRoot } from '../session/projectSessionsView.js';
import { shouldApplyTaskTranscript, shouldApplyWorkflowDetail } from '../session/taskTranscriptRouting.js';
import { sessionRowsCacheKey } from '../session/sessionCache.js';
import { setEntry, shouldProceedGate } from '../review/reviewWorkspace.js';
import { isStaleWorkspaceEvent, isBlockedDuringPendingWorkspaceSwitch, nextActiveWorkspace, workspaceChanged, parseQueryId, isStaleQueryResult, nextRunningWorkspaces } from '../workspace/workspaceEvents.js';
import { fileFromSummary, fmt, download } from '../format.js';
import { FOREGROUND_ONLY_KINDS } from '../../constants.js';
import { rid } from '../rid.js';

type InfoState = { sessionKey?: string; model?: string; workspaceRoot?: string; username?: string };
type GitInfoState = { repo: string; branch: string | null; insertions: number; deletions: number; gitRoot?: string | null; repoRelativePath?: string; isSubdir?: boolean } | null;
type HomeStatsState = {
  sessions: number; turns: number; activeDays: number; currentStreak: number;
  longestStreak: number; model: string; perDay: Record<string, number>;
} | null;
type BranchesState = { current: string | null; branches: string[]; loading?: boolean };
type ReviewView = { findings: ReviewFindingView[]; summary: string; files: number };
type GateView = { status: string; blocked: boolean; reason: string };
const WORKSPACE_SCOPED_REVIEW_QUERY_IDS = new Set(['q-review-diff', 'q-review-current', 'q-review-gate', 'q-review-fix']);

function isWorkspaceScopedReviewQuery(id: string): boolean {
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
  setGoalState: React.Dispatch<React.SetStateAction<import('../../components/GoalBanner.js').GoalRecord | null>>;
  setPlanHistory: React.Dispatch<React.SetStateAction<PlanDecisionView[]>>;
  setTokens: React.Dispatch<React.SetStateAction<{ promptTokens: number; completionTokens: number; turns: number; cachedTokens?: number } | null>>;
  // LIVE per-call usage for the in-flight turn (cleared at turn-start/end) so the
  // Context panel's token total ticks up during the turn, not only at turn-end.
  setLiveTurn: React.Dispatch<React.SetStateAction<{ promptTokens: number; completionTokens: number; calls: number; cachedTokens?: number } | null>>;
  // Session efficiency counters (cache reuse rides on `tokens`; compaction + memory
  // recall are counted here from their events). Reset on session-changed.
  setEfficiency: React.Dispatch<React.SetStateAction<{ compactions: number; droppedMessages: number; memoriesRecalled: number }>>;
  // Track mode data (project + work items + sprints), fed by the host `track-*` queries.
  setTrack: React.Dispatch<React.SetStateAction<{ project: TrackProject | null; items: WorkItem[]; sprints: Sprint[]; automations: AutomationRule[]; members: ProjectMember[]; sync: { config: SyncConfig | null; result: SyncResult | null }; git: GitTrackContext | null; pr: TrackPrStatus | null }>>;
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
  setAtlasAssessments: React.Dispatch<React.SetStateAction<Record<string, import('../atlas/atlasView.js').AtlasChangeAssessment>>>;
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

export function useAgentEvents(ctx: AgentEventsCtx): void {
  const {
    setRows, setRunning, setStopping, setTurnStart, setStatusLine, setReasoningTail, setLiveText, setToolLog,
    setLiveChildren, setFinishedTasks, setLastPlan, setGoalState, setPlanHistory, setTokens, setLiveTurn, setEfficiency, setTrack, setInteraction, setPicked, setViewKey,
    setTaskView, setWorkflowView, setInfo, setWorkspaces, setRunningWs, setHostUp, setLastTurnFails,
    setDraft, planFeedbackRef, goalContPendingRef, setProjSessions, setSessions, setPrInfo, setContextUsage, setFleet, setRecentTasks, setChangedFiles,
    setDiffView, setInlineDiffs, setAllFiles, setFileView, setGitInfo, setCommitSubjects, setHomeStats,
    setBranches, setModelsLoading, setEndpointModels, setToolCatalog, setProviderModels, setProbedModels, setProbeLoading, setProbeError, setCatalog, setSnapshot, setUsageLines, setUsageHistory,
    setSearchHits, setSchedules, setRequirements, setAnnotations, setArtifacts, setAtlasGraph, setAtlasBuilding, setAtlasEnriching, setAtlasAssessing, setAtlasAssessments, setWorktrees, setWorktreeDiffs, setReviewRunningByWs, setReviewByWs,
    setReviewGateByWs, setGateBlock, setGrepHits, setSessionGroups, setGitBusy, setInfoDialog, setToast,
    setFilesLoading, setFilesTruncated, setFilesError, setAttachmentUploads,
    setAtBottom,
    liveBuf, liveFlushPending, activeWsRef, sessionKeyRef, turnFailsRef, runningSessionsRef,
    pendingWorkspaceRef, pendingResumeRef, errorsBySession, lastPromptRef, workspaceGenRef, pendingSessionsRef, sessionsRef,
    atBottomRef, cardOpenRef, chatEnd, chatRef, pendingGitRef, pendingCmdRef, cachedSessionRowsRef,
    q, refreshSession, refreshSidebar, runGit, setSessionRunning, info, gitInfo, homeStats, branches,
  } = ctx;

  // §live-render fix — true once THIS turn has streamed/flushed an assistant row,
  // so turn-complete only appends `answer` when nothing was shown live. A
  // non-streaming endpoint produces no deltas; without this its answer was
  // dropped from the live view and only appeared after a session reload.
  const streamedThisTurnRef = useRef(false);
  // Files the agent edited/wrote THIS turn (path → status), reset at turn-start.
  // At turn-end we ask the host for their numstat and render a Codex-style
  // "Edited N files +X −Y" changeset card in the transcript.
  const turnEditsRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    const push = (row: ChatRow) => setRows((r) => [...r, row]);
    const pushTool = (item: ToolItem) => setRows((r) => {
      const last = r[r.length - 1];
      if (last && last.kind === 'tool-group') {
        return [...r.slice(0, -1), { ...last, items: [...last.items, item] }];
      }
      return [...r, { id: rid(), kind: 'tool-group', items: [item], ts: Date.now() }];
    });
    const flushAssistant = () => {
      const text = liveBuf.current.trim();
      liveBuf.current = '';
      liveFlushPending.current = false;
      setLiveText('');
      if (text) push({ id: rid(), kind: 'assistant', text, ts: Date.now() });
    };
    const off = window.brainrouter.onEvent((msg: AgentEventMessage) => {
      // T2/T3 — main tags each event with its owning workspace. Drop events from
      // a non-active workspace generation, then let session-changed advance the
      // active workspace. Untagged events (single-host) pass through unchanged.
      const wsMsg = msg as AgentEventMessage & { workspaceRoot?: string };
      const prevWs = activeWsRef.current;
      // Item 4 — record per-WORKSPACE running state BEFORE the stale-drop below:
      // a background project's turn events are exactly what that drop discards,
      // and they're what powers the sidebar's "running elsewhere" dot.
      setRunningWs((s) => nextRunningWorkspaces(s, msg.event?.kind, wsMsg.workspaceRoot));
      // WS3 — per-SESSION running state must also update for EVERY workspace, not
      // just the active one: a session running in a PARKED workspace otherwise
      // shows a stale spinner (its turn-lifecycle events are exactly what the
      // stale-drop below discards). Mirror the per-workspace capture above and do
      // it BEFORE the drop, keyed by the event's OWNING session.
      {
        const owning = msg.sessionKey;
        const k = msg.event?.kind;
        if (owning) {
          if (k === 'turn-start') setSessionRunning(owning, true);
          else if (k === 'turn-complete' || k === 'turn-error') setSessionRunning(owning, false);
        }
      }
      const pendingWorkspace = pendingWorkspaceRef.current;
      if (pendingWorkspace && msg.event?.kind === 'query-result') {
        const queryEvent = msg.event as { id?: string; ok?: boolean; result?: unknown; error?: string };
        const id = typeof queryEvent.id === 'string' ? parseQueryId(queryEvent.id).base : '';
        if (wsMsg.workspaceRoot && isWorkspaceScopedReviewQuery(id)) {
          handleQueryResult(queryEvent.id!, queryEvent.ok ? queryEvent.result : undefined, queryEvent.ok ? undefined : queryEvent.error, wsMsg.workspaceRoot);
        }
        return;
      }
      if (isBlockedDuringPendingWorkspaceSwitch(wsMsg, pendingWorkspace)) return;
      if (isStaleWorkspaceEvent(wsMsg, prevWs)) return;
      activeWsRef.current = nextActiveWorkspace(wsMsg, prevWs);
      setHostUp(true);
      const e: AgentEvent = msg.event;
      // DESK-5v — route by session: a turn you started can keep running after
      // you switch chats; its events stay tagged with ITS key. Drop the purely
      // visual ones when they're not for the chat on screen.
      const currentSessionKey = sessionKeyRef.current || info.sessionKey || '';
      const owningSessionKey = msg.sessionKey || currentSessionKey;
      const isForeground = !currentSessionKey || !owningSessionKey || owningSessionKey === currentSessionKey;
      if (!isForeground && FOREGROUND_ONLY_KINDS.has(e.kind)) return;
      switch (e.kind) {
        case 'status': setStatusLine(e.text); break;
        case 'reasoning-delta': setReasoningTail((t) => t + e.text); break;
        case 'assistant-turn-start': liveBuf.current = ''; liveFlushPending.current = false; setLiveText(''); break;
        case 'assistant-delta':
          streamedThisTurnRef.current = true;
          liveBuf.current += e.text;
          if (!liveFlushPending.current) {
            liveFlushPending.current = true;
            setTimeout(() => { liveFlushPending.current = false; setLiveText(liveBuf.current); }, 60);
          }
          break;
        case 'assistant-turn-end': flushAssistant(); break;
        case 'tool-end': {
          if (!e.ok) turnFailsRef.current += 1;
          const editedFile = fileFromSummary(e.tool, e.summary);
          if (e.ok && editedFile) turnEditsRef.current.set(editedFile, /write|create/i.test(e.tool) ? 'A' : 'M');
          pushTool({ id: rid(), tool: e.tool, summary: e.summary, preview: e.preview, ok: e.ok, file: editedFile });
          setToolLog((t) => [...t.slice(-199), { id: rid(), tool: e.tool, ok: e.ok, summary: e.summary }]);
          // §AV-3 — near-live artifacts: when the agent authors/updates an artifact
          // in-band (artifact_write), refresh the list immediately so the Artifacts
          // panel reflects it mid-turn instead of waiting for a manual reload.
          if (e.ok && e.tool === 'artifact_write') q('q-art', 'artifact-list');
          break;
        }
        case 'child-tool-start':
          // DESK-5n — first sign of a live child: register it as running.
          setLiveChildren((m) => ({ ...m, [e.childId]: { childId: e.childId, role: e.role, tool: e.tool, startedAt: m[e.childId]?.startedAt ?? Date.now() } }));
          break;
        case 'child-tool-end': {
          const childEdit = fileFromSummary(e.tool, e.summary);
          if (e.ok && childEdit) turnEditsRef.current.set(childEdit, /write|create/i.test(e.tool) ? 'A' : 'M');
          pushTool({ id: rid(), tool: e.tool, summary: e.summary, preview: e.preview, ok: e.ok, child: `${e.role}·${e.childId.slice(-4)}` });
          // Keep the live entry fresh (covers children whose first seen event is an end).
          setLiveChildren((m) => ({ ...m, [e.childId]: { childId: e.childId, role: e.role, tool: e.tool, startedAt: m[e.childId]?.startedAt ?? Date.now() } }));
          break;
        }
        case 'child-complete':
          push({ id: rid(), kind: 'status', text: `${e.status === 'completed' ? '✓' : '✗'} agent ${e.childId} (${e.role}) ${e.status}`, ts: Date.now() });
          setFinishedTasks((f) => [...f.slice(-30), { id: e.childId, label: `${e.role}·${e.childId.slice(-4)}`, status: e.status === 'completed' ? 'Agent · Completed' : 'Agent · Failed' }]);
          setLiveChildren((m) => { const n = { ...m }; delete n[e.childId]; return n; });
          break;
        case 'plan-update':
          setLastPlan({ items: e.items, explanation: e.explanation });
          push({ id: rid(), kind: 'status', text: 'Updated the plan', action: 'plan', ts: Date.now() });
          break;
        case 'files-changed':
          // FILES-LIVE — the host's debounced fs.watch fired. Re-pull the file
          // tree (cache already invalidated host-side), the Changes list and the
          // git counts so the right panel stays live without a manual Refresh.
          // The stale-workspace guard above already dropped events for a
          // background workspace, so this only repaints the foreground one.
          q('q-list', 'list-files', { refresh: true });
          q('q-files', 'changed-files');
          q('q-git', 'git-info');
          break;
        case 'compaction': push({ id: rid(), kind: 'status', text: `Compacted ${e.droppedMessages} → kept ${e.keptMessages}`, ts: Date.now() }); setEfficiency((s) => ({ ...s, compactions: s.compactions + 1, droppedMessages: s.droppedMessages + (e.droppedMessages || 0) })); q('q-ctx', 'context-usage'); break;
        case 'memory':
          // A briefing carries the recalled records — render a collapsible row
          // that shows the user exactly what memory was injected, not a label.
          if ((e as { op?: string }).op === 'briefing') {
            const briefRecords = (e as { records?: import('../../types.js').BriefingRecord[] }).records ?? [];
            push({ id: rid(), kind: 'briefing', sources: (e as { sources?: string[] }).sources ?? [], records: briefRecords, ts: Date.now() });
            if (briefRecords.length) setEfficiency((s) => ({ ...s, memoriesRecalled: s.memoriesRecalled + briefRecords.length }));
          } else {
            push({ id: rid(), kind: 'status', text: `${e.level === 'warn' ? '⚠ ' : ''}${e.text}`, ts: Date.now() });
          }
          break;
        // §truncation — a persistent provider-truncation notice ("raise cli.maxOutputTokens").
        case 'notice': push({ id: rid(), kind: 'status', text: `${e.level === 'warn' ? '⚠ ' : ''}${e.message}`, ts: Date.now() }); break;
        case 'requirement-event':
          q('q-req', 'requirement-list');
          break;
        case 'annotation-event':
          q('q-annot', 'annotation-list');
          break;
        case 'artifact-event':
          q('q-art', 'artifact-list');
          break;
        case 'provenance':
          break;
        case 'task-event': {
          // DURABLE BACKGROUND TASKS — a plan-revision/review/attachment task
          // changed state. Refresh the fleet so the Background panel + sidebar
          // indicators update instantly (don't wait for the 3s poll). Failures
          // stay out of the chat transcript; the task panel owns background work.
          q('q-fleet', 'fleet');
          // A terminal task event also refreshes the recently-finished list so a
          // just-completed/failed verification appears without waiting for the poll.
          if (e.action === 'completed' || e.action === 'failed' || e.action === 'canceled') {
            q('q-tasks-recent', 'tasks-list', { scope: 'workspace', status: 'all' });
          }
          if (e.action === 'failed' && e.task?.error) {
            setToast(`${e.task.title}: ${e.task.error}`);
          }
          break;
        }
        case 'tokens-updated': setTokens({ promptTokens: e.promptTokens, completionTokens: e.completionTokens, turns: e.turns, cachedTokens: e.cachedTokens }); setLiveTurn(null); q('q-ctx', 'context-usage'); break;
        // LIVE — per-call cumulative usage for THIS turn (set, don't add: the agent
        // sends the turn's running total). The session base (`tokens`) absorbs it at
        // turn-end, where setLiveTurn(null) above keeps the two from double-counting.
        case 'usage-live': if (isForeground) { setLiveTurn({ promptTokens: e.promptTokens, completionTokens: e.completionTokens, calls: e.calls, cachedTokens: e.cachedTokens }); q('q-ctx', 'context-usage'); } break;
        case 'interaction-request': setInteraction(e.request); setPicked([]); break;
        case 'session-changed':
          // DESK-5u — session-changed is the authoritative "current session"
          // signal; track it directly (info.sessionKey can be clobbered by a
          // q-info refresh, which would mis-bucket per-session errors).
          pendingWorkspaceRef.current = null;
          sessionKeyRef.current = e.sessionKey;
          setViewKey(e.sessionKey);
          setTaskView(null); setWorkflowView(null); // DESK-5w/6w — leaving closes any open task/workflow view
          // DESK-5v — the composer reflects whether the chat we just landed on
          // is itself running (it may be — a background turn you started here
          // earlier). Clear the transient per-turn surfaces either way.
          // Reconcile the per-session running flag against the host's
          // AUTHORITATIVE state (Runtime.running, carried on session-changed). A
          // dropped turn-complete (workspace stale-drop / host exit for a
          // non-foreground session) used to leave runningSessionsRef stuck → a
          // resumed chat showed "working…" forever with a bogus 600s+ elapsed.
          // When the host reports running, trust it: clear or set the ref.
          const hostRunning = typeof e.running === 'boolean'
            ? e.running
            : runningSessionsRef.current.has(e.sessionKey);
          if (typeof e.running === 'boolean') setSessionRunning(e.sessionKey, e.running);
          setRunning(hostRunning);
          // Reset the elapsed clock — turnStart is only written by submit(), so a
          // resumed/backgrounded turn (or a stale flag) showed minutes from an
          // unrelated turn. If it really is running we don't know the original
          // start, so count from now (honest-ish); if not, the spinner is hidden.
          setTurnStart(hostRunning ? Date.now() : 0);
          setStopping(false); // DESK-6 — a switch clears any pending stop indicator
          setStatusLine(''); setReasoningTail(''); setLiveText(''); liveBuf.current = '';
          // Session-scoped surfaces must NOT carry over from the chat we just left:
          // reset the context meter + plan now (the refresh below repopulates them
          // from THIS session's data — a new chat → empty, not the old chat's 100%).
          setContextUsage(null); setLastPlan(null); setPlanHistory([]);
          setEfficiency({ compactions: 0, droppedMessages: 0, memoriesRecalled: 0 }); // efficiency is per-session
          if (e.loadedMessages > 0) {
            // Only show spinner if not cached
            const cacheRoot = wsMsg.workspaceRoot ?? activeWsRef.current ?? info.workspaceRoot ?? '';
            if (!cachedSessionRowsRef.current || !cachedSessionRowsRef.current[sessionRowsCacheKey(cacheRoot, e.sessionKey)]) {
              setRows([{ id: rid(), kind: 'loading', ts: Date.now() }]);
            }
            setSearchHits(null);
            q('q-transcript', 'transcript', { sessionKey: e.sessionKey });
          } else if (e.loadedMessages === 0) {
            setRows([]);
            setSearchHits(null);
            setTimeout(() => { if (chatRef.current) chatRef.current.scrollTop = 0; }, 50);
          }
          // T3 — identity is set ATOMICALLY here from the event's own workspace,
          // so breadcrumb / env / sidebar all flip to the new project in one go
          // instead of lagging behind a separate session-info refresh.
          setInfo((i) => ({ ...i, sessionKey: e.sessionKey, model: e.model || i.model, workspaceRoot: wsMsg.workspaceRoot ?? i.workspaceRoot }));
          if (wsMsg.workspaceRoot) setWorkspaces((w) => w.current === wsMsg.workspaceRoot ? w : { ...w, current: wsMsg.workspaceRoot! });
          // DESK-5d — a chat clicked under ANOTHER project: the new host has
          // just announced itself; now land on the chat that was clicked.
          {
            const want = pendingResumeRef.current;
            if (want) {
              pendingResumeRef.current = null;
              if (e.sessionKey !== want) window.brainrouter.send({ kind: 'resume-session', sessionKey: want });
            }
          }
          // The effort / mode chip reads its value from the config snapshot,
          // which is SESSION-aware on the host (resolveActiveMode). It's fetched
          // at boot / Settings-open / mode-mutations but NOT on session switch,
          // so the chip used to show the PREVIOUS session's effort while the
          // agent (which resolves fresh per turn) sent this session's. Refetch
          // it on every switch so the chip matches what actually gets sent.
          q('q-snapshot', 'config-snapshot');
          // GOAL-BANNER — pull THIS session's active goal so the pinned banner
          // reflects the chat we just landed on (each session has its own goal).
          q('q-goal', 'goal-state');
          // Stability fix — refresh tier by whether the WORKSPACE changed: a
          // project/workspace switch needs the FULL git/workspace refresh so
          // branches + git state reload (they were cleared on switch); a same-
          // workspace session change (new chat / switch chat) only needs the
          // light refresh (git is identical across chats in one workspace).
          if (workspaceChanged(wsMsg.workspaceRoot, prevWs)) {
            // ATLAS-18 — the Atlas is per-workspace. Drop the previous project's
            // graph and load the NEW workspace's STORED graph (q-atlas reads, never
            // regenerates), so its prior enrichment is preserved until the user
            // explicitly Rebuilds/Enriches. Clear transient + path-keyed state too.
            setAtlasGraph(null); setAtlasBuilding(false); setAtlasEnriching(false);
            setAtlasAssessing(null); setAtlasAssessments({});
            q('q-atlas', 'atlas-graph');
            refreshSidebar();
          } else refreshSession();
          break;
        // DESK-5v — turn lifecycle is tracked PER SESSION so a background turn
        // keeps its spinner and lands its result/error in the right chat.
        case 'turn-start': if (owningSessionKey) setSessionRunning(owningSessionKey, true); if (isForeground) { setRunning(true); setTurnStart(Date.now()); setLiveTurn(null); streamedThisTurnRef.current = false; turnEditsRef.current = new Map(); } break;
        case 'turn-complete': {
          if (owningSessionKey) setSessionRunning(owningSessionKey, false);
          if (!isForeground) { refreshSidebar(); break; } // background turn: its answer is on disk, re-read on switch-back
          flushAssistant();
          // Render the final answer UNLESS this turn already streamed/flushed one.
          // (The old guard checked "does any assistant row exist?" — true after any
          // earlier turn — so a non-streaming endpoint's answer was dropped from the
          // live view until a session reload.)
          if (!streamedThisTurnRef.current && (e.answer ?? '').trim()) {
            push({ id: rid(), kind: 'assistant', text: e.answer, ts: Date.now() });
          }
          streamedThisTurnRef.current = false;
          setRunning(false); setStopping(false); setStatusLine(''); setReasoningTail('');
          setLastTurnFails(turnFailsRef.current);
          setLiveChildren({}); // turn ended — refreshSidebar reseeds any detached workers
          refreshSidebar();
          // End-of-turn changeset — if the agent edited files this turn, ask the
          // host for their numstat; the result handler appends a Codex-style
          // "Edited N files +X −Y" card right after the final answer.
          if (turnEditsRef.current.size > 0) {
            q('q-turn-changeset', 'turn-changeset', { paths: [...turnEditsRef.current.keys()] });
            turnEditsRef.current = new Map();
          }
          // §goal-autonomy — ask the host whether an active goal should continue.
          // Returns { action:'none' } (a no-op) when there's no goal, so this is
          // safe on every turn. A 'continue' result fires the next hidden turn.
          q('q-goalcont', 'goal-continuation');
          break;
        }
        case 'turn-error': {
          if (owningSessionKey) setSessionRunning(owningSessionKey, false);
          // DESK-5u/5v — record the error under the SESSION IT BELONGS TO (not
          // the one on screen) so it survives a switch-away-and-back, and a
          // background failure shows up when you return to that chat.
          const errId = rid();
          const errText = 'Something went wrong';
          const errSession = owningSessionKey;
          if (errSession) {
            const bucket = errorsBySession.current[errSession] ?? [];
            errorsBySession.current[errSession] = [...bucket.slice(-19), { id: errId, text: errText, detail: e.message, ts: Date.now() }];
          }
          if (!isForeground) { refreshSidebar(); break; } // surfaces on switch-back via q-transcript re-injection
          flushAssistant();
          push({ id: errId, kind: 'error', text: errText, detail: e.message, ts: Date.now() });
          setRunning(false); setStopping(false); setStatusLine(''); setReasoningTail('');
          setLiveChildren({}); setLiveTurn(null); // a failed turn never gets tokens-updated; clear live
          // Observed: the app preserves your message on failure.
          setDraft((d) => d || lastPromptRef.current);
          break;
        }
        case 'query-result': handleQueryResult(e.id, e.ok ? e.result : undefined, e.ok ? undefined : (e as { error?: string }).error, wsMsg.workspaceRoot); break;
        default: break;
      }
      // Sticky-bottom: never yank the view while the user is reading scrollback.
      queueMicrotask(() => { if (atBottomRef.current && !cardOpenRef.current) chatEnd.current?.scrollIntoView({ behavior: 'auto' }); });
    });
    refreshSidebar();
    q('q-catalog', 'commands-catalog');
    q('q-snapshot', 'config-snapshot');
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleQueryResult(rawId: string, result: unknown, error?: string, resultWorkspaceRoot?: string): void {
    // Stability fix — drop results from an older workspace generation (they were
    // in flight when the user switched projects); then route by the base id.
    const id = parseQueryId(rawId).base;
    const workspaceScopedLateResult = !!resultWorkspaceRoot && isWorkspaceScopedReviewQuery(id);
    if (!workspaceScopedLateResult && isStaleQueryResult(rawId, workspaceGenRef.current)) return;
    // DESK-5d — per-project chat lists route by the root encoded in the id.
    if (id.startsWith('q-wsess:')) {
      const root = id.slice('q-wsess:'.length);
      if (error) {
        setProjSessions((p) => ({
          ...p,
          [root]: { rows: p[root]?.rows ?? [], loading: false, error, loadedAt: Date.now() },
        }));
        return;
      }
      setProjSessions((p) => ({ ...p, [root]: normalizeProjectSessionsResult(result) }));
      return;
    }
    if (error) {
      if (id === 'q-list') {
        setFilesLoading(false);
        setFilesTruncated(false);
        setFilesError(error);
      }
      if (id.startsWith('q-attach:')) {
        const uploadId = id.slice('q-attach:'.length);
        setAttachmentUploads((prev) => prev.map((u) => u.id === uploadId ? { ...u, status: 'failed', detail: error } : u));
      }
      setToast(`✗ ${error}`);
      return;
    }
    // WS8 — rewind result: an in-app warning (top-right toast) when blocked
    // because code was generated after the point, or a confirmation when it
    // truncated. The agent's history is rewound host-side for the next turn.
    if (id === 'a-rewind') {
      const r = result as { ok?: boolean; reason?: string } | undefined;
      if (r && r.ok === false) setToast(`⚠ ${r.reason ?? 'Rewind blocked.'}`);
      else if (r && r.ok) setToast('Rewound to here — your next message continues from this point.');
      return;
    }
    if (id === 'q-attach' || id.startsWith('q-attach:')) {
      const uploadId = id.startsWith('q-attach:') ? id.slice('q-attach:'.length) : '';
      const r = result as { ok?: boolean; attachment?: { name: string; id: string; kind: string }; contextMarkdown?: string; error?: string } | null;
      if (r?.ok && r.attachment) {
        if (uploadId) {
          setAttachmentUploads((prev) => prev.map((u) => u.id === uploadId ? {
            ...u,
            status: 'attached',
            attachmentId: r.attachment!.id,
            kind: r.attachment!.kind,
            detail: r.attachment!.kind,
            contextMarkdown: r.contextMarkdown,
          } : u));
        }
        setToast(`✓ Attached ${r.attachment.name}`);
        q('q-fleet', 'fleet');
      } else {
        const detail = r?.error ?? 'Attachment failed.';
        if (uploadId) setAttachmentUploads((prev) => prev.map((u) => u.id === uploadId ? { ...u, status: 'failed', detail } : u));
        setToast(`✗ Attach failed: ${detail}`);
      }
      return;
    }
    switch (id) {
      case 'q-sessions': if (Array.isArray(result)) {
        const hostRows = result as SessionRow[];
        // Wave 2 — drop optimistic rows the host now confirms, then merge the
        // still-pending ones so a brand-new chat never vanishes on a refresh.
        pendingSessionsRef.current = dropPending(pendingSessionsRef.current, hostRows.map((r) => r.sessionKey));
        const merged = mergeOptimistic(hostRows, pendingSessionsRef.current);
        setSessions(merged); sessionsRef.current = merged;
        const root = resultWorkspaceRoot ?? activeWsRef.current ?? info.workspaceRoot;
        setProjSessions((prev) => withCachedProjectSessions(prev, root, merged));
      } return;
      case 'q-pr': setPrInfo(((result as { pr?: { number: number; state: string; title?: string } | null })?.pr) ?? null); return;
      case 'q-ctx': if (result && typeof result === 'object') {
        const u = result as { used: number; window: number; compactAt: number; limit: number; pct: number };
        // Auto-compaction must trigger WITHIN the model window — clamp the
        // threshold to the window so its bar never shows a max larger than the
        // model window (a knob bigger than the window can never fire: the
        // provider rejects the request before that many tokens accrue).
        const compactAt = u.window > 0 ? Math.min(u.compactAt, u.window) : u.compactAt;
        const limit = compactAt > 0 ? compactAt : u.window;
        setContextUsage({ ...u, compactAt, limit, pct: limit > 0 ? Math.min(1, u.used / limit) : 0 });
      } return;
      // TRACK mode — project + work items. Create/transition return the updated list.
      case 'q-track-project': setTrack((t) => ({ ...t, project: (result as TrackProject | null) ?? null })); return;
      case 'q-track-items': case 'q-track-create': case 'q-track-transition':
      case 'q-track-update-item': case 'q-track-comment': case 'q-track-link': case 'q-track-assign-sprint':
        if (Array.isArray(result)) setTrack((t) => ({ ...t, items: result as WorkItem[] }));
        return;
      case 'q-track-sprints': case 'q-track-create-sprint': case 'q-track-sprint-state':
        if (Array.isArray(result)) setTrack((t) => ({ ...t, sprints: result as Sprint[] }));
        return;
      case 'q-track-automations': case 'q-track-create-automation':
      case 'q-track-update-automation': case 'q-track-delete-automation':
        if (Array.isArray(result)) setTrack((t) => ({ ...t, automations: result as AutomationRule[] }));
        return;
      case 'q-track-members': case 'q-track-add-member':
      case 'q-track-update-member-role': case 'q-track-remove-member':
        if (Array.isArray(result)) setTrack((t) => ({ ...t, members: result as ProjectMember[] }));
        return;
      case 'q-track-sync-members': {
        const r = result as { members?: ProjectMember[]; added?: string[]; errors?: string[] } | null;
        if (Array.isArray(r?.members)) setTrack((t) => ({ ...t, members: r!.members! }));
        if (r) setToast(`Pulled ${r.added?.length ?? 0} member(s) from GitHub${r.errors?.length ? ` · ${r.errors.length} error(s)` : ''}.`);
        return;
      }
      case 'q-track-sync-config':
        if (result && typeof result === 'object') setTrack((t) => ({ ...t, sync: { ...t.sync, config: result as SyncConfig } }));
        return;
      case 'q-track-git-context':
        if (result && typeof result === 'object') setTrack((t) => ({ ...t, git: result as GitTrackContext }));
        return;
      case 'q-track-start-work': {
        const r = result as { ok?: boolean; error?: string; branch?: string; items?: WorkItem[]; context?: GitTrackContext } | null;
        if (Array.isArray(r?.items)) setTrack((t) => ({ ...t, items: r!.items!, git: r!.context ?? t.git }));
        if (r?.error) setToast(`Git start failed: ${r.error}`);
        else if (r?.branch) setToast(`Started ${r.branch}.`);
        return;
      }
      case 'q-track-pr-status':
        if (result && typeof result === 'object') setTrack((t) => ({ ...t, pr: result as TrackPrStatus }));
        return;
      case 'q-track-create-pr': {
        const r = result as { ok?: boolean; error?: string; url?: string; pr?: TrackPrStatus['pr']; branch?: string | null; itemKey?: string; items?: WorkItem[] } | null;
        if (Array.isArray(r?.items)) setTrack((t) => ({
          ...t,
          items: r!.items!,
          pr: { pr: r!.pr ?? null, branch: r!.branch ?? null, itemKey: r!.itemKey },
        }));
        if (r?.error) setToast(`Draft PR failed: ${r.error}`);
        else if (r?.url) setToast(`Created draft PR: ${r.url}`);
        return;
      }
      case 'q-track-gh-issues': {
        const r = result as (SyncResult & { items?: WorkItem[] }) | null;
        if (Array.isArray(r?.items)) setTrack((t) => ({ ...t, items: r!.items!, sync: { ...t.sync, result: r as SyncResult } }));
        if (r) setToast(`Imported ${r.imported?.length ?? 0} issue(s) via gh${r.errors?.length ? ` · ${r.errors.length} error(s)` : ''}.`);
        return;
      }
      case 'q-track-merge-pr': {
        const r = result as { ok?: boolean; error?: string; pr?: TrackPrStatus['pr']; branch?: string | null; itemKey?: string; items?: WorkItem[] } | null;
        if (Array.isArray(r?.items)) setTrack((t) => ({
          ...t,
          items: r!.items!,
          pr: { pr: r!.ok ? null : (r!.pr ?? null), branch: r!.branch ?? null, itemKey: r!.itemKey },
        }));
        if (r?.error) setToast(`Merge failed: ${r.error}`);
        else if (r?.ok) setToast('Pull request merged.');
        return;
      }
      case 'q-track-submit-pr-review': {
        const r = result as { ok?: boolean; error?: string; pr?: TrackPrStatus['pr']; branch?: string | null; itemKey?: string } | null;
        if (r) setTrack((t) => ({ ...t, pr: { pr: r.pr ?? t.pr?.pr ?? null, branch: r.branch ?? t.pr?.branch ?? null, itemKey: r.itemKey ?? t.pr?.itemKey } }));
        if (r?.error) setToast(`Review failed: ${r.error}`);
        else if (r?.ok) setToast('Pull request review submitted.');
        return;
      }
      case 'q-track-fix-checks': {
        const r = result as { ok?: boolean; error?: string; pr?: TrackPrStatus['pr']; branch?: string | null; itemKey?: string; task?: { id?: string } } | null;
        if (r) setTrack((t) => ({ ...t, pr: { pr: r.pr ?? t.pr?.pr ?? null, branch: r.branch ?? t.pr?.branch ?? null, itemKey: r.itemKey ?? t.pr?.itemKey } }));
        if (r?.error) setToast(`Fix checks failed: ${r.error}`);
        else if (r?.ok) {
          setToast('Fix checks task started — see Background tasks.');
          q('q-fleet', 'fleet');
        }
        return;
      }
      case 'q-track-sync':
        if (result && typeof result === 'object' && !(result as { error?: string }).error) setTrack((t) => ({ ...t, sync: { ...t.sync, result: result as SyncResult } }));
        return;
      case 'q-track-scan': {
        const r = result as { scanned?: number; linked?: unknown[]; transitioned?: unknown[]; items?: WorkItem[] } | null;
        if (Array.isArray(r?.items)) setTrack((t) => ({ ...t, items: r!.items! }));
        if (r) setToast(`Scanned ${r.scanned ?? 0} commit(s) — ${r.linked?.length ?? 0} linked, ${r.transitioned?.length ?? 0} advanced.`);
        return;
      }
      case 'q-turn-changeset': {
        // End-of-turn changeset → append a card right after the final answer.
        const r = result as { files?: ChangesetFile[]; insertions?: number; deletions?: number } | null;
        if (r && Array.isArray(r.files) && r.files.length) {
          setRows((rows) => [...rows, { id: rid(), kind: 'changeset', files: r.files!, insertions: r.insertions ?? 0, deletions: r.deletions ?? 0, ts: Date.now() }]);
        }
        return;
      }
      case 'q-plan': {
        // This session's durable plan (empty for a new chat). Null/empty → clear
        // the panel rather than leave the previous session's plan showing.
        const p = result as { items?: PlanItem[]; explanation?: string } | null;
        setLastPlan(p && Array.isArray(p.items) && p.items.length ? { items: p.items, explanation: p.explanation } : null);
        return;
      }
      // §7 PLAN REVIEW — this session's plan decision history (the version log).
      case 'q-plan-history': if (Array.isArray(result)) setPlanHistory(result as PlanDecisionView[]); return;
      // Approve / request-changes round-trips: surface an error, else refresh the
      // history so the new decision appears (the App layer re-fetches q-plan-history).
      case 'q-plan-decision': {
        const r = result as { error?: string; taskError?: string; task?: { id: string; title?: string } } | null;
        if (r && typeof r === 'object') {
          if (typeof r.error === 'string') setToast(`✗ ${r.error}`);
          else if (typeof r.taskError === 'string') {
            // §1 — the revision task couldn't start: surface the error and
            // restore the feedback draft so the user doesn't lose it.
            setToast(`✗ Could not start the revision task: ${r.taskError}`);
            if (planFeedbackRef.current) setDraft(planFeedbackRef.current);
          } else if (r.task) {
            setToast('Revision task started — see Background tasks.');
            q('q-fleet', 'fleet');
            planFeedbackRef.current = '';
          }
        }
        return;
      }
      case 'q-fleet': if (Array.isArray(result)) setFleet(result as FleetRow[]); return;
      case 'q-tasks-recent': {
        // §3 — durable tasks (all statuses). Keep the TERMINAL ones (completed/
        // failed/canceled) as a FleetRow-shaped "recently finished" list; the
        // running ones already arrive via q-fleet. Clicking reopens the result.
        if (!Array.isArray(result)) return;
        const rows = (result as Array<Record<string, unknown>>)
          .filter((t) => t.status === 'completed' || t.status === 'failed' || t.status === 'canceled')
          .slice(0, 25)
          .map((t) => ({
            kind: String(t.kind ?? 'agent'), id: String(t.id ?? ''), label: String(t.title ?? t.id ?? ''),
            startedAt: typeof t.startedAt === 'string' ? t.startedAt : (typeof t.createdAt === 'string' ? t.createdAt : undefined),
            status: String(t.status ?? ''), durable: true,
            parentSessionKey: typeof t.sessionKey === 'string' ? t.sessionKey : null,
            transcript: t.transcript as FleetRow['transcript'],
          })) as FleetRow[];
        setRecentTasks(rows);
        return;
      }
      case 'q-info': if (result && typeof result === 'object') setInfo(result as typeof info); return;
      case 'q-files': if (Array.isArray(result)) setChangedFiles(result as Array<{ status: string; path: string }>); return;
      case 'q-diff': if (result && typeof result === 'object') setDiffView(result as { path: string; diff: string }); return;
      case 'q-inline-diff': {
        const r = result as { path?: string; diff?: string };
        if (r?.path) setInlineDiffs((d) => ({ ...d, [r.path!]: r.diff ?? '' }));
        return;
      }
      case 'q-list': {
        setFilesLoading(false);
        if (result && typeof result === 'object') {
          const r = result as { files?: string[]; truncated?: boolean };
          if (typeof (r as { error?: unknown }).error === 'string') {
            setAllFiles([]);
            setFilesTruncated(false);
            setFilesError((r as { error: string }).error);
            setToast(`✗ ${(r as { error: string }).error}`);
            return;
          }
          setAllFiles(Array.isArray(r.files) ? r.files : []);
          setFilesTruncated(!!r.truncated);
          setFilesError('');
        } else {
          setAllFiles([]);
          setFilesTruncated(false);
          setFilesError('');
        }
        return;
      }
      case 'q-read': if (result && typeof result === 'object') setFileView(result as { path: string; content: string }); return;
      case 'q-git': if (result && typeof result === 'object') setGitInfo(result as typeof gitInfo); return;
      case 'q-gitlog': if (result && typeof result === 'object') setCommitSubjects(((result as { subjects?: string[] }).subjects ?? [])); return;
      case 'q-home': if (result && typeof result === 'object') setHomeStats(result as typeof homeStats); return;
      case 'q-branches': if (result && typeof result === 'object') setBranches(result as typeof branches); return;
      case 'q-models': {
        setModelsLoading(false);
        if (result && typeof result === 'object') {
          const r = result as { models?: string[]; provider?: string };
          // A named-provider result feeds the per-provider map (sub-agent model
          // pickers); the active endpoint feeds the main list. Both come from the
          // endpoint's /models — never a hand-written list.
          if (r.provider) setProviderModels((prev) => ({ ...prev, [r.provider!]: r.models ?? [] }));
          else setEndpointModels(r.models ?? []);
        }
        return;
      }
      case 'q-toolcat': {
        if (result && typeof result === 'object') {
          const r = result as Partial<ToolCatalog>;
          setToolCatalog({ builtin: r.builtin ?? [], mcp: r.mcp ?? [] });
        }
        return;
      }
      // §multi-select-models — a draft-key probe from the Models setup dialog.
      // Feeds its OWN state (never endpointModels), so it can't race the on-open
      // model load. An empty list means the key/endpoint unlocked nothing.
      case 'q-probe': {
        setProbeLoading(false);
        const r = (result && typeof result === 'object') ? result as { models?: string[]; error?: string } : { models: [] };
        const models = r.models ?? [];
        setProbedModels(models);
        // error reason (http-401 = bad key, unreachable = CORS/network) takes
        // precedence so the dialog can validate the key; else generic no-models.
        setProbeError(models.length ? '' : ((r as { error?: string }).error || 'no-models'));
        return;
      }
      // §multi-provider — visible feedback (banner) for the Models-panel actions,
      // so creating/removing/defaulting a provider never silently does nothing.
      case 'a-setprov': {
        const r = result as { ok?: boolean; name?: string; error?: string } | null;
        setToast(r && r.ok ? `✓ Connected ${r.name ?? 'provider'}` : `✗ Couldn't save provider${r?.error ? `: ${r.error}` : ''}`);
        return;
      }
      case 'a-rmprov': {
        const r = result as { ok?: boolean; name?: string; error?: string } | null;
        setToast(r && r.ok ? `✓ Removed ${r.name ?? 'provider'}` : `✗ Couldn't remove provider${r?.error ? `: ${r.error}` : ''}`);
        return;
      }
      case 'a-setdefault': {
        const r = result as { ok?: boolean; error?: string } | null;
        setToast(r && r.ok ? '✓ Default provider updated' : `✗ Couldn't set default${r?.error ? `: ${r.error}` : ''}`);
        return;
      }
      case 'q-catalog': if (result && typeof result === 'object') setCatalog(result as CommandsCatalog); return;
      case 'q-snapshot': if (result && typeof result === 'object') setSnapshot(result as ConfigSnapshot); return;
      case 'q-usage': if (Array.isArray(result)) setUsageLines(result as string[]); return;
      case 'q-usage-hist': if (result && typeof result === 'object') setUsageHistory(result as UsageHistory); return;
      case 'q-search': if (Array.isArray(result)) setSearchHits(result as SearchHit[]); return;
      case 'q-schedule': if (Array.isArray(result)) setSchedules(result as ScheduleRecordView[]); return;
      // REQUIREMENT-RECORDS — the list populates the slice; create/update/seed use
      // their own ids (q-req-create/q-req-update/q-req-seed) and just trigger a
      // refresh via q-req, except seed/error which surfaces a toast.
      case 'q-req': if (Array.isArray(result)) setRequirements(result as RequirementRecord[]); return;
      case 'q-atlas': setAtlasGraph(result && typeof result === 'object' && Array.isArray((result as { nodes?: unknown }).nodes) ? (result as AtlasGraph) : null); return;
      case 'q-atlas-build': { const g = (result as { graph?: AtlasGraph } | null)?.graph ?? null; if (g) setAtlasGraph(g); setAtlasBuilding(false); return; }
      case 'q-atlas-enrich': {
        const r = result as { graph?: AtlasGraph; error?: string; enrichResult?: { summarized: number; layers: number; tourSteps: number; batchesFailed: number } } | null;
        setAtlasEnriching(false);
        if (r?.error) { setToast(`⚠ ${r.error}`); return; }
        if (r?.graph) setAtlasGraph(r.graph);
        const er = r?.enrichResult;
        if (er) setToast(`✓ Atlas enriched — ${er.summarized} summaries · ${er.layers} layers · ${er.tourSteps} tour`);
        return;
      }
      case 'q-atlas-explain': {
        const r = result as { path?: string; error?: string; assessment?: import('../atlas/atlasView.js').AtlasChangeAssessment } | null;
        setAtlasAssessing(null);
        if (r?.error) { setToast(`⚠ ${r.error}`); return; }
        if (r?.path && r.assessment) setAtlasAssessments((prev) => ({ ...prev, [r.path as string]: r.assessment! }));
        return;
      }
      case 'q-req-create': case 'q-req-update': case 'q-req-seed': {
        const r = result as { error?: string } | null;
        if (r && typeof r === 'object' && typeof r.error === 'string') setToast(`✗ ${r.error}`);
        return;
      }
      // ANNOTATION-RECORDS — the list populates the slice; status/create use their
      // own ids and just refresh via q-annot (surfacing any error toast). Export
      // round-trips the markdown into the composer draft (export-to-session path).
      case 'q-annot': if (Array.isArray(result)) setAnnotations(result as AnnotationRecord[]); return;
      case 'q-annot-status': case 'q-annot-create': case 'q-annot-comment': {
        const r = result as { error?: string } | null;
        if (r && typeof r === 'object' && typeof r.error === 'string') setToast(`✗ ${r.error}`);
        return;
      }
      case 'q-annot-export': {
        const r = result as { markdown?: string } | null;
        if (r && typeof r.markdown === 'string') { setDraft(r.markdown); setToast('Annotations exported to the chat — press Enter to send the feedback to the agent.'); }
        return;
      }
      // ARTIFACT-RECORDS — the list populates the slice; create/status use their
      // own ids and just refresh via q-art (surfacing any error toast). The
      // Preview fetch (q-art-read) merges the resolved content onto the matching
      // record so the detail view's preview renders without a parallel state slice.
      case 'q-art': if (Array.isArray(result)) setArtifacts(result as ArtifactRecord[]); return;
      case 'q-art-create': case 'q-art-update': case 'q-art-save': {
        const r = result as { error?: string } | null;
        if (r && typeof r === 'object' && typeof r.error === 'string') setToast(`✗ ${r.error}`);
        return;
      }
      case 'q-art-read': {
        const r = result as { id?: string; content?: string; error?: string } | null;
        if (!r || typeof r.id !== 'string') return;
        if (typeof r.error === 'string') { setToast(`✗ ${r.error}`); return; }
        if (typeof r.content === 'string') setArtifacts((list) => list.map((a) => (a.id === r.id ? { ...a, content: r.content } : a)));
        return;
      }
      case 'q-worktrees': {
        const r = result as { raw?: string; current?: string } | null;
        if (r && typeof r.raw === 'string') setWorktrees(parseWorktreeList(r.raw, r.current));
        return;
      }
      case 'q-worktree-diff': {
        const r = result as { path?: string; diff?: string } | null;
        if (r && typeof r.path === 'string') setWorktreeDiffs((d) => ({ ...d, [r.path!]: r.diff ?? '' }));
        return;
      }
      case 'q-review-diff': {
        // T2 — write under the workspace that's active at result time (stale-gen
        // results are already dropped upstream), so reviews never cross workspaces.
        const root = resultWorkspaceRoot ?? activeWsRef.current ?? info.workspaceRoot ?? '';
        setReviewRunningByWs((m) => ({ ...m, [root]: false }));
        const r = result as { findings?: ReviewFindingView[]; summary?: string; files?: number } | null;
        setReviewByWs((m) => setEntry(m, root, r ? { findings: r.findings ?? [], summary: r.summary ?? '', files: r.files ?? 0 } : { findings: [], summary: 'Review failed.', files: 0 }));
        const activeRootNow = activeWsRef.current ?? info.workspaceRoot ?? '';
        if (root === activeRootNow && !pendingWorkspaceRef.current) {
          q('q-review-current', 'review-current'); // refresh the gate + finding statuses
          // If a commit/push was waiting on a freshly-run review, re-check the gate.
          if (pendingGitRef.current) q('q-review-gate', 'review-gate');
        }
        return;
      }
      case 'q-review-current': {
        const root = resultWorkspaceRoot ?? activeWsRef.current ?? info.workspaceRoot ?? '';
        const r = result as { run?: { findings?: ReviewFindingView[]; summary?: string } | null; gate?: { status: string; blocked: boolean; reason: string }; files?: number } | null;
        setReviewGateByWs((m) => setEntry(m, root, r?.gate ?? null));
        if (r?.run) setReviewByWs((m) => setEntry(m, root, { findings: r.run!.findings ?? [], summary: r.run!.summary ?? '', files: r.files ?? 0 }));
        return;
      }
      case 'q-review-gate': {
        const r = result as { gate?: { blocked?: boolean; reason?: string; status?: string } } | null;
        const gate = r?.gate ?? { blocked: true, reason: 'Review status unavailable.', status: 'needs-review' };
        const root = resultWorkspaceRoot ?? activeWsRef.current ?? info.workspaceRoot ?? '';
        setReviewGateByWs((m) => setEntry(m, root, { status: gate.status ?? 'needs-review', blocked: !!gate.blocked, reason: gate.reason ?? '' }));
        const pending = pendingGitRef.current;
        if (!pending) return;
        if (gate.blocked) {
          setGateBlock({ kind: pending.kind, msg: pending.msg, reason: gate.reason ?? 'Review required.', status: gate.status ?? 'needs-review' });
        } else {
          pendingGitRef.current = null;
          // §7 + T2 stale-guard: a CLEAN gate from workspace A must NOT clear a
          // commit/push the user started in workspace B (after switching mid-flight).
          const activeRootNow = activeWsRef.current ?? info.workspaceRoot ?? '';
          if (shouldProceedGate(pending.root, root) && root === activeRootNow && !pendingWorkspaceRef.current) runGit(pending.kind, pending.msg, { reviewed: true });
          else setToast('Workspace changed before the review cleared — commit cancelled, run it again.');
        }
        return;
      }
      case 'q-review-fix': {
        // T3 — the scoped fix agent finished; it returns the re-run review.
        const root = resultWorkspaceRoot ?? activeWsRef.current ?? info.workspaceRoot ?? '';
        setReviewRunningByWs((m) => ({ ...m, [root]: false }));
        const r = result as { ok?: boolean; error?: string; run?: { findings?: ReviewFindingView[]; summary?: string }; files?: number } | null;
        if (r?.ok && r.run) {
          setReviewByWs((m) => setEntry(m, root, { findings: r.run!.findings ?? [], summary: r.run!.summary ?? '', files: r.files ?? 0 }));
          const activeRootNow = activeWsRef.current ?? info.workspaceRoot ?? '';
          if (root === activeRootNow && !pendingWorkspaceRef.current) {
            setToast('Finding fixed — review re-run over the new changes.');
            q('q-review-current', 'review-current'); q('q-files', 'changed-files'); q('q-git', 'git-info');
          }
        } else {
          setToast(`Fix failed: ${r?.error ?? 'unknown error'}`);
        }
        return;
      }
      case 'q-review-apply': {
        // T3 — surface apply-suggestion success/error (the refresh is fired by the caller).
        const r = result as { ok?: boolean; error?: string } | null;
        setToast(r?.ok ? 'Suggestion applied to the working tree.' : `Apply failed: ${r?.error ?? 'no patch — use Ask agent to fix'}`);
        return;
      }
      case 'q-grep': if (Array.isArray(result)) setGrepHits(result as import('../../panels/index.js').GrepHit[]); return;
      case 'q-transcript': {
        const data = result as { sessionKey?: string; rows?: Array<{ kind: string; text?: string; tools?: number; ts?: number; items?: Array<{ tool: string; summary: string; preview?: string; ok: boolean; file?: string }> }> };
        if (data?.sessionKey && data.sessionKey !== sessionKeyRef.current) return;
        const mapped: ChatRow[] = (data?.rows ?? []).map((r, index) => {
          // DESK-6t — use the persisted per-message timestamp so resumed history
          // shows the REAL relative time, not "just now".
          const ts = r.ts ?? Date.now();
          const stableId = getStableRowId(data.sessionKey ?? '', r, index);
          if (r.kind === 'user') return { id: stableId, kind: 'user' as const, text: r.text ?? '', ts };
          if (r.kind === 'assistant') return { id: stableId, kind: 'assistant' as const, text: r.text ?? '', ts };
          // DESK-5p — reconstructed tool calls render as the live tool-group card.
          if (r.kind === 'tool-group') return {
            id: stableId, kind: 'tool-group' as const, ts,
            items: (r.items ?? []).map((it, itemIndex) => ({ id: `${stableId}-item-${itemIndex}`, tool: it.tool, summary: it.summary, preview: it.preview, ok: it.ok, file: it.file })),
          };
          return { id: stableId, kind: 'status' as const, text: `Used ${r.tools ?? 0} tool${(r.tools ?? 0) === 1 ? '' : 's'}`, ts };
        });
        // DESK-5u — re-inject any cached errors for this session so a failure
        // you saw earlier is still there after switching away and back.
        const cachedErrors = errorsBySession.current[data?.sessionKey ?? ''] ?? [];
        const resumeStatusId = `${data.sessionKey}-resume-status`;
        setRows([
          { id: resumeStatusId, kind: 'status', text: `Resumed ${data?.sessionKey ?? 'session'} — ${mapped.length} entries.`, ts: Date.now() },
          ...mapped,
          ...cachedErrors.map((er) => ({ id: er.id, kind: 'error' as const, text: er.text, detail: er.detail, ts: er.ts })),
        ]);
        atBottomRef.current = true;
        setAtBottom(true);
        setTimeout(() => chatEnd.current?.scrollIntoView({ behavior: 'auto' }), 50);
        return;
      }
      // DESK-5w — a background task's conversation, opened read-only over the chat.
      case 'q-task-transcript': {
        const data = result as { id: string; kind: string; role?: string; goal?: string; status?: string; rows?: Array<{ kind: string; text?: string; ts?: number; items?: Array<{ tool: string; summary: string; preview?: string; ok: boolean; file?: string }> }> };
        const mapped: ChatRow[] = (data?.rows ?? []).map((r, i) => {
          const ts = r.ts ?? Date.now();
          // DESK-6v — STABLE, index-based keys: the 2.5s live poll re-sends the
          // same rows, and random ids made React remount EVERY row each time
          // (the flashing). Stable keys let it reconcile in place instead.
          if (r.kind === 'user') return { id: i, kind: 'user' as const, text: r.text ?? '', ts };
          if (r.kind === 'assistant') return { id: i, kind: 'assistant' as const, text: r.text ?? '', ts };
          if (r.kind === 'tool-group') return { id: i, kind: 'tool-group' as const, ts, items: (r.items ?? []).map((it, j) => ({ id: j, tool: it.tool, summary: it.summary, preview: it.preview, ok: it.ok, file: it.file })) };
          return { id: i, kind: 'status' as const, text: r.text ?? '', ts };
        });
        // §review-visibility — a RUNNING task whose transcript is still empty
        // (the agent hasn't flushed its first line yet) must NOT erase the
        // spinner to a blank pane. Keep a stable loading row so the user sees the
        // agent is working until real content lands.
        const isTaskRunning = data?.status === 'running' || data?.status === undefined;
        const finalRows: ChatRow[] = mapped.length ? mapped : (isTaskRunning ? [{ id: 'task-working', kind: 'loading' as const, ts: 0 }] : mapped);
        // DESK-6v — and skip the state update entirely when nothing changed, so a
        // stable transcript doesn't re-render (and flash) every poll.
        const sig = (rows: ChatRow[], status?: string): string => `${status ?? ''}|` + rows.map((r) => r.kind === 'tool-group'
          ? `tg:${r.ts}:${(r.items ?? []).map((it) => `${it.tool}:${it.summary}:${it.preview ?? ''}:${it.file ?? ''}:${it.ok ? '1' : '0'}`).join(',')}`
          : `${r.kind}:${r.ts}:${(r as { text?: string }).text ?? ''}`).join('§');
        setTaskView((prev) => {
          if (!shouldApplyTaskTranscript(prev, data)) return prev;
          if (prev && sig(prev.rows, prev.status) === sig(finalRows, data.status)) return prev;
          return {
            id: data.id,
            kind: data.kind,
            role: data.role ?? prev?.role,
            title: prev?.title ?? data.goal,
            sourceKind: prev?.sourceKind,
            goal: data.goal,
            status: data.status,
            parentSessionKey: prev?.parentSessionKey,
            rows: finalRows,
          };
        });
        return;
      }
      // DESK-6w — workflow run breakdown for the /workflows-style card.
      case 'q-workflow-detail': {
        if (result && typeof result === 'object') {
          setWorkflowView((prev) => shouldApplyWorkflowDetail(prev, result as { slug?: string }) ? result as WorkflowDetail : prev);
        }
        return;
      }
      // DESK-6m — per-chat ⋮ menu action results: refresh the sidebar list.
      case 'q-session-meta': {
        if (result && typeof result === 'object' && Array.isArray((result as { groups?: unknown }).groups)) setSessionGroups((result as { groups: string[] }).groups);
        refreshSession();
        return;
      }
      case 'q-session-delete': refreshSession(); return;
      case 'q-session-fork': {
        const nk = (result as { newKey?: string } | undefined)?.newKey;
        refreshSession();
        if (nk) window.brainrouter.send({ kind: 'resume-session', sessionKey: nk });
        return;
      }
      case 'q-session-groups': if (result && typeof result === 'object' && Array.isArray((result as { groups?: unknown }).groups)) setSessionGroups((result as { groups: string[] }).groups); return;
      case 'q-open-external': return; // fire-and-forget
      case 'q-cmd': {
        const r = result as { lines?: string[]; startTurn?: string } | null;
        const lines = r && Array.isArray(r.lines) ? r.lines : [fmt(result)];
        setRows((rows) => [...rows, { id: rid(), kind: 'cmd-out', cmd: pendingCmdRef.current, lines, ts: Date.now() }]);
        // §goal-autonomy — a bridge command (e.g. /goal <text> or /goal resume)
        // can ask us to KICK OFF a turn. The prompt is hidden (machine-generated)
        // so it never renders as a message the user typed. The goal-continuation
        // loop (turn-complete → q-goalcont) takes over from there.
        if (r && typeof r.startTurn === 'string' && r.startTurn.trim()) {
          goalContPendingRef.current = null; // a fresh kickoff cancels any stale pending continuation
          window.brainrouter.send({ kind: 'start-turn', prompt: r.startTurn, hidden: true });
        }
        // A /goal command (set/resume/pause/clear) just changed the goal — refresh
        // the pinned banner so its text/status/controls reflect the new state.
        if (pendingCmdRef.current.startsWith('/goal')) q('q-goal', 'goal-state');
        return;
      }
      case 'q-goal':
        // GOAL-BANNER — the structured active goal for the pinned banner (null = none).
        setGoalState((result ?? null) as import('../../components/GoalBanner.js').GoalRecord | null);
        return;
      case 'a-goal-edit': {
        const r = result as { ok?: boolean; goal?: unknown; error?: string } | null;
        if (r && r.ok && r.goal) setGoalState(r.goal as import('../../components/GoalBanner.js').GoalRecord);
        else if (r && r.error) setToast(r.error);
        return;
      }
      case 'q-goalcont': {
        // §goal-autonomy — the host decided the goal's next move after a turn.
        const r = result as { action?: string; followUp?: string; iteration?: number; cap?: string; notice?: string } | null;
        if (!r || !r.action || r.action === 'none') return;
        if (r.action === 'continue' && typeof r.followUp === 'string') {
          const followUp = r.followUp;
          goalContPendingRef.current = followUp;
          setRows((rows) => [...rows, { id: rid(), kind: 'status', text: `🎯 Goal — continuing… send a message to steer, or pause the goal.`, ts: Date.now() }]);
          // Brief delay so a fast user message can preempt the auto-continuation.
          setTimeout(() => {
            if (goalContPendingRef.current !== followUp) return;          // canceled by user input
            if (runningSessionsRef.current.has(sessionKeyRef.current ?? '')) return; // a turn already running
            goalContPendingRef.current = null;
            window.brainrouter.send({ kind: 'start-turn', prompt: followUp, hidden: true });
          }, 600);
        } else if (r.notice) {
          setRows((rows) => [...rows, { id: rid(), kind: 'status', text: r.notice!, ts: Date.now() }]);
        }
        return;
      }
      case 'a-allow-rule': setToast(`Always-allow rule saved${result && typeof result === 'object' && 'rule' in (result as object) ? `: ${(result as { rule: string }).rule}` : ''} — shared with the CLI.`); q('q-snapshot', 'config-snapshot'); return;
      case 'a-term': return; // term-exec output is rendered by the live TerminalPanel (xterm), not buffered here
      case 'a-git': {
        const r = result as { out?: string; code?: number };
        setGitBusy(false);
        const first = (r?.out ?? '').split('\n').find((l) => l.trim()) ?? '';
        setToast(r?.code ? `✗ ${first || `git exited ${r.code}`}` : `✓ ${first || 'Done'}`);
        q('q-git', 'git-info');
        q('q-files', 'changed-files');
        q('q-branches', 'git-branches');
        q('q-gitlog', 'git-log');
        q('q-pr', 'git-pr');
        return;
      }
      case 'q-recap': setInfoDialog({ title: 'Session recap', body: fmt(result) }); return;
      case 'q-chapters': {
        const marks = Array.isArray(result) ? result as Array<{ title: string; summary?: string }> : [];
        setInfoDialog({ title: 'Chapters', body: marks.length ? marks.map((m, i) => `${i + 1}. ${m.title}${m.summary ? ` — ${m.summary}` : ''}`).join('\n') : 'No chapter marks in this session yet.' });
        return;
      }
      case 'q-export': {
        const r = result as { filename?: string; content?: string };
        if (r?.filename && typeof r.content === 'string') { download(r.filename, r.content); setToast(`Exported ${r.filename}`); }
        return;
      }
      case 'a-clear': setRows([]); if (sessionKeyRef.current) delete errorsBySession.current[sessionKeyRef.current]; setToast('History cleared.'); return;
      case 'a-compact': setInfoDialog({ title: 'Compaction', body: result ? fmt(result) : 'Nothing to compact yet.' }); return;
      case 'a-mode': q('q-snapshot', 'config-snapshot'); setToast('Mode saved for this session.'); return;
      case 'a-pref': q('q-snapshot', 'config-snapshot'); setToast('Saved — shared with the CLI.'); return;
      case 'a-hook': q('q-snapshot', 'config-snapshot'); setToast('Hook updated.'); return;
      case 'a-ext': q('q-snapshot', 'config-snapshot'); setToast('Extension updated — reloaded.'); return;
      case 'a-trust': q('q-snapshot', 'config-snapshot'); setToast(result && typeof result === 'object' && (result as { trusted?: boolean }).trusted ? 'Workspace trusted — extensions loaded.' : 'Workspace trust revoked.'); return;
      case 'a-access': setToast('Access mode set for this session.'); return;
      case 'a-reconnect': q('q-snapshot', 'config-snapshot'); setToast('Reconnect requested.'); return;
      case 'a-rule': q('q-snapshot', 'config-snapshot'); setToast(result && typeof result === 'object' && (result as { ok?: boolean }).ok ? 'Permission rule saved — shared with the CLI.' : 'Could not save the rule.'); return;
      case 'a-addmcp': q('q-snapshot', 'config-snapshot'); setToast(result && typeof result === 'object' && (result as { ok?: boolean; error?: string }).ok ? 'MCP server added — shared with the CLI.' : `Could not add server: ${(result as { error?: string })?.error ?? 'unknown error'}`); return;
      case 'a-rmmcp': q('q-snapshot', 'config-snapshot'); setToast('MCP server removed.'); return;
      default: return;
    }
  }
}
