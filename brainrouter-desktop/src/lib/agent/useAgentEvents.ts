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
import { useEffect } from 'react';
import type React from 'react';
import type { AgentEvent, AgentEventMessage, InteractionRequest } from '@kinqs/brainrouter-agent-protocol';
import type { PlanItem, ToolItem, ChatRow, SessionRow, FleetRow, WorkflowDetail } from '../../types.js';
import type { SearchHit, ReviewFindingView, GrepHit } from '../../panels/index.js';
import type { ScheduleRecordView } from '../schedule/scheduleView.js';
import type { PlanDecisionView } from '../plan/planReviewView.js';
import type { RequirementRecord, AnnotationRecord, ArtifactRecord } from '@kinqs/brainrouter-types';
import type { CommandsCatalog } from '../commands/commands.js';
import type { ConfigSnapshot } from '../../settings.js';
import { parseWorktreeList, type WorktreeEntry } from '../worktree/worktreeParser.js';
import { mergeOptimistic, dropPending } from '../session/sessionOrder.js';
import { setEntry, shouldProceedGate } from '../review/reviewWorkspace.js';
import { isStaleWorkspaceEvent, nextActiveWorkspace, workspaceChanged, parseQueryId, isStaleQueryResult, nextRunningWorkspaces } from '../workspace/workspaceEvents.js';
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

export interface AgentEventsCtx {
  setRows: React.Dispatch<React.SetStateAction<ChatRow[]>>;
  setRunning: React.Dispatch<React.SetStateAction<boolean>>;
  setStopping: React.Dispatch<React.SetStateAction<boolean>>;
  setStatusLine: React.Dispatch<React.SetStateAction<string>>;
  setReasoningTail: React.Dispatch<React.SetStateAction<string>>;
  setLiveText: React.Dispatch<React.SetStateAction<string>>;
  setToolLog: React.Dispatch<React.SetStateAction<Array<{ id: number; tool: string; ok: boolean; summary: string }>>>;
  setLiveChildren: React.Dispatch<React.SetStateAction<Record<string, { childId: string; role: string; tool?: string; startedAt: number }>>>;
  setFinishedTasks: React.Dispatch<React.SetStateAction<Array<{ id: string; label: string; status: string }>>>;
  setLastPlan: React.Dispatch<React.SetStateAction<{ items: PlanItem[]; explanation?: string } | null>>;
  setPlanHistory: React.Dispatch<React.SetStateAction<PlanDecisionView[]>>;
  setTokens: React.Dispatch<React.SetStateAction<{ promptTokens: number; completionTokens: number; turns: number } | null>>;
  setInteraction: React.Dispatch<React.SetStateAction<InteractionRequest | null>>;
  setPicked: React.Dispatch<React.SetStateAction<string[]>>;
  setViewKey: React.Dispatch<React.SetStateAction<string>>;
  setTaskView: React.Dispatch<React.SetStateAction<{ id: string; kind: string; role?: string; goal?: string; status?: string; parentSessionKey?: string | null; rows: ChatRow[] } | null>>;
  setWorkflowView: React.Dispatch<React.SetStateAction<WorkflowDetail | null>>;
  setInfo: React.Dispatch<React.SetStateAction<InfoState>>;
  setWorkspaces: React.Dispatch<React.SetStateAction<{ current: string | null; recents: string[] }>>;
  setRunningWs: React.Dispatch<React.SetStateAction<Set<string>>>;
  setHostUp: React.Dispatch<React.SetStateAction<boolean>>;
  setLastTurnFails: React.Dispatch<React.SetStateAction<number | null>>;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  setProjSessions: React.Dispatch<React.SetStateAction<Record<string, SessionRow[]>>>;
  setSessions: React.Dispatch<React.SetStateAction<SessionRow[]>>;
  setPrInfo: React.Dispatch<React.SetStateAction<{ number: number; state: string; title?: string } | null>>;
  setContextUsage: React.Dispatch<React.SetStateAction<{ used: number; window: number; compactAt: number; limit: number; pct: number } | null>>;
  setFleet: React.Dispatch<React.SetStateAction<FleetRow[]>>;
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
  setCatalog: React.Dispatch<React.SetStateAction<CommandsCatalog | null>>;
  setSnapshot: React.Dispatch<React.SetStateAction<ConfigSnapshot | null>>;
  setUsageLines: React.Dispatch<React.SetStateAction<string[]>>;
  setSearchHits: React.Dispatch<React.SetStateAction<SearchHit[] | null>>;
  setSchedules: React.Dispatch<React.SetStateAction<ScheduleRecordView[]>>;
  setRequirements: React.Dispatch<React.SetStateAction<RequirementRecord[]>>;
  setAnnotations: React.Dispatch<React.SetStateAction<AnnotationRecord[]>>;
  setArtifacts: React.Dispatch<React.SetStateAction<ArtifactRecord[]>>;
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
  setAtBottom: React.Dispatch<React.SetStateAction<boolean>>;

  liveBuf: React.MutableRefObject<string>;
  liveFlushPending: React.MutableRefObject<boolean>;
  activeWsRef: React.MutableRefObject<string | null>;
  sessionKeyRef: React.MutableRefObject<string | undefined>;
  turnFailsRef: React.MutableRefObject<number>;
  runningSessionsRef: React.MutableRefObject<Set<string>>;
  pendingResumeRef: React.MutableRefObject<string | null>;
  errorsBySession: React.MutableRefObject<Record<string, Array<{ id: number; text: string; detail?: string; ts: number }>>>;
  lastPromptRef: React.MutableRefObject<string>;
  workspaceGenRef: React.MutableRefObject<number>;
  pendingSessionsRef: React.MutableRefObject<SessionRow[]>;
  sessionsRef: React.MutableRefObject<SessionRow[]>;
  atBottomRef: React.MutableRefObject<boolean>;
  cardOpenRef: React.MutableRefObject<boolean>;
  chatEnd: React.RefObject<HTMLDivElement>;
  chatRef: React.RefObject<HTMLDivElement>;
  pendingGitRef: React.MutableRefObject<{ kind: 'commit' | 'push'; msg?: string; root: string } | null>;
  pendingCmdRef: React.MutableRefObject<string>;

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

export function useAgentEvents(ctx: AgentEventsCtx): void {
  const {
    setRows, setRunning, setStopping, setStatusLine, setReasoningTail, setLiveText, setToolLog,
    setLiveChildren, setFinishedTasks, setLastPlan, setPlanHistory, setTokens, setInteraction, setPicked, setViewKey,
    setTaskView, setWorkflowView, setInfo, setWorkspaces, setRunningWs, setHostUp, setLastTurnFails,
    setDraft, setProjSessions, setSessions, setPrInfo, setContextUsage, setFleet, setChangedFiles,
    setDiffView, setInlineDiffs, setAllFiles, setFileView, setGitInfo, setCommitSubjects, setHomeStats,
    setBranches, setModelsLoading, setEndpointModels, setCatalog, setSnapshot, setUsageLines,
    setSearchHits, setSchedules, setRequirements, setAnnotations, setArtifacts, setWorktrees, setWorktreeDiffs, setReviewRunningByWs, setReviewByWs,
    setReviewGateByWs, setGateBlock, setGrepHits, setSessionGroups, setGitBusy, setInfoDialog, setToast,
    setAtBottom,
    liveBuf, liveFlushPending, activeWsRef, sessionKeyRef, turnFailsRef, runningSessionsRef,
    pendingResumeRef, errorsBySession, lastPromptRef, workspaceGenRef, pendingSessionsRef, sessionsRef,
    atBottomRef, cardOpenRef, chatEnd, chatRef, pendingGitRef, pendingCmdRef,
    q, refreshSession, refreshSidebar, runGit, setSessionRunning, info, gitInfo, homeStats, branches,
  } = ctx;

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
      if (isStaleWorkspaceEvent(wsMsg, prevWs)) return;
      activeWsRef.current = nextActiveWorkspace(wsMsg, prevWs);
      setHostUp(true);
      const e: AgentEvent = msg.event;
      // DESK-5v — route by session: a turn you started can keep running after
      // you switch chats; its events stay tagged with ITS key. Drop the purely
      // visual ones when they're not for the chat on screen.
      const isForeground = msg.sessionKey === sessionKeyRef.current;
      if (!isForeground && FOREGROUND_ONLY_KINDS.has(e.kind)) return;
      switch (e.kind) {
        case 'status': setStatusLine(e.text); break;
        case 'reasoning-delta': setReasoningTail((t) => (t + e.text).slice(-200)); break;
        case 'assistant-turn-start': liveBuf.current = ''; liveFlushPending.current = false; setLiveText(''); break;
        case 'assistant-delta':
          liveBuf.current += e.text;
          if (!liveFlushPending.current) {
            liveFlushPending.current = true;
            setTimeout(() => { liveFlushPending.current = false; setLiveText(liveBuf.current); }, 60);
          }
          break;
        case 'assistant-turn-end': flushAssistant(); break;
        case 'tool-end': {
          if (!e.ok) turnFailsRef.current += 1;
          pushTool({ id: rid(), tool: e.tool, summary: e.summary, preview: e.preview, ok: e.ok, file: fileFromSummary(e.tool, e.summary) });
          setToolLog((t) => [...t.slice(-199), { id: rid(), tool: e.tool, ok: e.ok, summary: e.summary }]);
          break;
        }
        case 'child-tool-start':
          // DESK-5n — first sign of a live child: register it as running.
          setLiveChildren((m) => ({ ...m, [e.childId]: { childId: e.childId, role: e.role, tool: e.tool, startedAt: m[e.childId]?.startedAt ?? Date.now() } }));
          break;
        case 'child-tool-end':
          pushTool({ id: rid(), tool: e.tool, summary: e.summary, preview: e.preview, ok: e.ok, child: `${e.role}·${e.childId.slice(-4)}` });
          // Keep the live entry fresh (covers children whose first seen event is an end).
          setLiveChildren((m) => ({ ...m, [e.childId]: { childId: e.childId, role: e.role, tool: e.tool, startedAt: m[e.childId]?.startedAt ?? Date.now() } }));
          break;
        case 'child-complete':
          push({ id: rid(), kind: 'status', text: `${e.status === 'completed' ? '✓' : '✗'} agent ${e.childId} (${e.role}) ${e.status}`, ts: Date.now() });
          setFinishedTasks((f) => [...f.slice(-30), { id: `${e.childId}-${Date.now()}`, label: `${e.role}·${e.childId.slice(-4)}`, status: e.status === 'completed' ? 'Agent · Completed' : 'Agent · Failed' }]);
          setLiveChildren((m) => { const n = { ...m }; delete n[e.childId]; return n; });
          break;
        case 'plan-update':
          setLastPlan({ items: e.items, explanation: e.explanation });
          push({ id: rid(), kind: 'status', text: 'Updated the plan', ts: Date.now() });
          break;
        case 'compaction': push({ id: rid(), kind: 'status', text: `Compacted ${e.droppedMessages} → kept ${e.keptMessages}`, ts: Date.now() }); q('q-ctx', 'context-usage'); break;
        case 'memory': push({ id: rid(), kind: 'status', text: `${e.level === 'warn' ? '⚠ ' : ''}${e.text}`, ts: Date.now() }); break;
        case 'tokens-updated': setTokens({ promptTokens: e.promptTokens, completionTokens: e.completionTokens, turns: e.turns }); q('q-ctx', 'context-usage'); break;
        case 'interaction-request': setInteraction(e.request); setPicked([]); break;
        case 'session-changed':
          // DESK-5u — session-changed is the authoritative "current session"
          // signal; track it directly (info.sessionKey can be clobbered by a
          // q-info refresh, which would mis-bucket per-session errors).
          sessionKeyRef.current = e.sessionKey;
          setViewKey(e.sessionKey);
          setTaskView(null); setWorkflowView(null); // DESK-5w/6w — leaving closes any open task/workflow view
          // DESK-5v — the composer reflects whether the chat we just landed on
          // is itself running (it may be — a background turn you started here
          // earlier). Clear the transient per-turn surfaces either way.
          setRunning(runningSessionsRef.current.has(e.sessionKey));
          setStopping(false); // DESK-6 — a switch clears any pending stop indicator
          setStatusLine(''); setReasoningTail(''); setLiveText(''); liveBuf.current = '';
          // Session-scoped surfaces must NOT carry over from the chat we just left:
          // reset the context meter + plan now (the refresh below repopulates them
          // from THIS session's data — a new chat → empty, not the old chat's 100%).
          setContextUsage(null); setLastPlan(null); setPlanHistory([]);
          if (e.loadedMessages > 0) {
            // Observed: a centered spinner while the transcript loads, then
            // the full history renders scrolled to the bottom.
            setRows([{ id: rid(), kind: 'loading', ts: Date.now() }]);
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
          // Stability fix — refresh tier by whether the WORKSPACE changed: a
          // project/workspace switch needs the FULL git/workspace refresh so
          // branches + git state reload (they were cleared on switch); a same-
          // workspace session change (new chat / switch chat) only needs the
          // light refresh (git is identical across chats in one workspace).
          if (workspaceChanged(wsMsg.workspaceRoot, prevWs)) refreshSidebar();
          else refreshSession();
          break;
        // DESK-5v — turn lifecycle is tracked PER SESSION so a background turn
        // keeps its spinner and lands its result/error in the right chat.
        case 'turn-start': setSessionRunning(msg.sessionKey, true); if (isForeground) setRunning(true); break;
        case 'turn-complete': {
          setSessionRunning(msg.sessionKey, false);
          if (!isForeground) { refreshSidebar(); break; } // background turn: its answer is on disk, re-read on switch-back
          flushAssistant();
          setRows((r) => (r.some((x) => x.kind === 'assistant') ? r : [...r, { id: rid(), kind: 'assistant', text: e.answer, ts: Date.now() }]));
          setRunning(false); setStopping(false); setStatusLine(''); setReasoningTail('');
          setLastTurnFails(turnFailsRef.current);
          setLiveChildren({}); // turn ended — refreshSidebar reseeds any detached workers
          refreshSidebar();
          break;
        }
        case 'turn-error': {
          setSessionRunning(msg.sessionKey, false);
          // DESK-5u/5v — record the error under the SESSION IT BELONGS TO (not
          // the one on screen) so it survives a switch-away-and-back, and a
          // background failure shows up when you return to that chat.
          const errId = rid();
          const errText = 'Something went wrong';
          const errSession = msg.sessionKey;
          const bucket = errorsBySession.current[errSession] ?? [];
          errorsBySession.current[errSession] = [...bucket.slice(-19), { id: errId, text: errText, detail: e.message, ts: Date.now() }];
          if (!isForeground) { refreshSidebar(); break; } // surfaces on switch-back via q-transcript re-injection
          flushAssistant();
          push({ id: errId, kind: 'error', text: errText, detail: e.message, ts: Date.now() });
          setRunning(false); setStopping(false); setStatusLine(''); setReasoningTail('');
          setLiveChildren({});
          // Observed: the app preserves your message on failure.
          setDraft((d) => d || lastPromptRef.current);
          break;
        }
        case 'query-result': handleQueryResult(e.id, e.ok ? e.result : undefined, e.ok ? undefined : (e as { error?: string }).error); break;
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

  function handleQueryResult(rawId: string, result: unknown, error?: string): void {
    // Stability fix — drop results from an older workspace generation (they were
    // in flight when the user switched projects); then route by the base id.
    if (isStaleQueryResult(rawId, workspaceGenRef.current)) return;
    const id = parseQueryId(rawId).base;
    if (error) { setToast(`✗ ${error}`); return; }
    // DESK-5d — per-project chat lists route by the root encoded in the id.
    if (id.startsWith('q-wsess:')) {
      const root = id.slice('q-wsess:'.length);
      if (Array.isArray(result)) setProjSessions((p) => ({ ...p, [root]: result as SessionRow[] }));
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
      } return;
      case 'q-pr': setPrInfo(((result as { pr?: { number: number; state: string; title?: string } | null })?.pr) ?? null); return;
      case 'q-ctx': if (result && typeof result === 'object') setContextUsage(result as { used: number; window: number; compactAt: number; limit: number; pct: number }); return;
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
        const r = result as { error?: string } | null;
        if (r && typeof r === 'object' && typeof r.error === 'string') setToast(`✗ ${r.error}`);
        return;
      }
      case 'q-fleet': if (Array.isArray(result)) setFleet(result as FleetRow[]); return;
      case 'q-info': if (result && typeof result === 'object') setInfo(result as typeof info); return;
      case 'q-files': if (Array.isArray(result)) setChangedFiles(result as Array<{ status: string; path: string }>); return;
      case 'q-diff': if (result && typeof result === 'object') setDiffView(result as { path: string; diff: string }); return;
      case 'q-inline-diff': {
        const r = result as { path?: string; diff?: string };
        if (r?.path) setInlineDiffs((d) => ({ ...d, [r.path!]: r.diff ?? '' }));
        return;
      }
      case 'q-list': if (result && typeof result === 'object') setAllFiles((result as { files: string[] }).files ?? []); return;
      case 'q-read': if (result && typeof result === 'object') setFileView(result as { path: string; content: string }); return;
      case 'q-git': if (result && typeof result === 'object') setGitInfo(result as typeof gitInfo); return;
      case 'q-gitlog': if (result && typeof result === 'object') setCommitSubjects(((result as { subjects?: string[] }).subjects ?? [])); return;
      case 'q-home': if (result && typeof result === 'object') setHomeStats(result as typeof homeStats); return;
      case 'q-branches': if (result && typeof result === 'object') setBranches(result as typeof branches); return;
      case 'q-models': {
        setModelsLoading(false);
        if (result && typeof result === 'object') setEndpointModels(((result as { models?: string[] }).models ?? []));
        return;
      }
      case 'q-catalog': if (result && typeof result === 'object') setCatalog(result as CommandsCatalog); return;
      case 'q-snapshot': if (result && typeof result === 'object') setSnapshot(result as ConfigSnapshot); return;
      case 'q-usage': if (Array.isArray(result)) setUsageLines(result as string[]); return;
      case 'q-search': if (Array.isArray(result)) setSearchHits(result as SearchHit[]); return;
      case 'q-schedule': if (Array.isArray(result)) setSchedules(result as ScheduleRecordView[]); return;
      // REQUIREMENT-RECORDS — the list populates the slice; create/update/seed use
      // their own ids (q-req-create/q-req-update/q-req-seed) and just trigger a
      // refresh via q-req, except seed/error which surfaces a toast.
      case 'q-req': if (Array.isArray(result)) setRequirements(result as RequirementRecord[]); return;
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
        const root = activeWsRef.current ?? info.workspaceRoot ?? '';
        setReviewRunningByWs((m) => ({ ...m, [root]: false }));
        const r = result as { findings?: ReviewFindingView[]; summary?: string; files?: number } | null;
        setReviewByWs((m) => setEntry(m, root, r ? { findings: r.findings ?? [], summary: r.summary ?? '', files: r.files ?? 0 } : { findings: [], summary: 'Review failed.', files: 0 }));
        q('q-review-current', 'review-current'); // refresh the gate + finding statuses
        // If a commit/push was waiting on a freshly-run review, re-check the gate.
        if (pendingGitRef.current) q('q-review-gate', 'review-gate');
        return;
      }
      case 'q-review-current': {
        const root = activeWsRef.current ?? info.workspaceRoot ?? '';
        const r = result as { run?: { findings?: ReviewFindingView[]; summary?: string } | null; gate?: { status: string; blocked: boolean; reason: string }; files?: number } | null;
        setReviewGateByWs((m) => setEntry(m, root, r?.gate ?? null));
        if (r?.run) setReviewByWs((m) => setEntry(m, root, { findings: r.run!.findings ?? [], summary: r.run!.summary ?? '', files: r.files ?? 0 }));
        return;
      }
      case 'q-review-gate': {
        const r = result as { gate?: { blocked?: boolean; reason?: string; status?: string } } | null;
        const gate = r?.gate ?? { blocked: true, reason: 'Review status unavailable.', status: 'needs-review' };
        const root = activeWsRef.current ?? info.workspaceRoot ?? '';
        setReviewGateByWs((m) => setEntry(m, root, { status: gate.status ?? 'needs-review', blocked: !!gate.blocked, reason: gate.reason ?? '' }));
        const pending = pendingGitRef.current;
        if (!pending) return;
        if (gate.blocked) {
          setGateBlock({ kind: pending.kind, msg: pending.msg, reason: gate.reason ?? 'Review required.', status: gate.status ?? 'needs-review' });
        } else {
          pendingGitRef.current = null;
          // §7 + T2 stale-guard: a CLEAN gate from workspace A must NOT clear a
          // commit/push the user started in workspace B (after switching mid-flight).
          if (shouldProceedGate(pending.root, root)) runGit(pending.kind, pending.msg, { reviewed: true });
          else setToast('Workspace changed before the review cleared — commit cancelled, run it again.');
        }
        return;
      }
      case 'q-review-fix': {
        // T3 — the scoped fix agent finished; it returns the re-run review.
        const root = activeWsRef.current ?? info.workspaceRoot ?? '';
        setReviewRunningByWs((m) => ({ ...m, [root]: false }));
        const r = result as { ok?: boolean; error?: string; run?: { findings?: ReviewFindingView[]; summary?: string }; files?: number } | null;
        if (r?.ok && r.run) {
          setReviewByWs((m) => setEntry(m, root, { findings: r.run!.findings ?? [], summary: r.run!.summary ?? '', files: r.files ?? 0 }));
          setToast('Finding fixed — review re-run over the new changes.');
          q('q-review-current', 'review-current'); q('q-files', 'changed-files'); q('q-git', 'git-info');
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
        const mapped: ChatRow[] = (data?.rows ?? []).map((r) => {
          // DESK-6t — use the persisted per-message timestamp so resumed history
          // shows the REAL relative time, not "just now".
          const ts = r.ts ?? Date.now();
          if (r.kind === 'user') return { id: rid(), kind: 'user' as const, text: r.text ?? '', ts };
          if (r.kind === 'assistant') return { id: rid(), kind: 'assistant' as const, text: r.text ?? '', ts };
          // DESK-5p — reconstructed tool calls render as the live tool-group card.
          if (r.kind === 'tool-group') return {
            id: rid(), kind: 'tool-group' as const, ts,
            items: (r.items ?? []).map((it) => ({ id: rid(), tool: it.tool, summary: it.summary, preview: it.preview, ok: it.ok, file: it.file })),
          };
          return { id: rid(), kind: 'status' as const, text: `Used ${r.tools ?? 0} tool${(r.tools ?? 0) === 1 ? '' : 's'}`, ts };
        });
        // DESK-5u — re-inject any cached errors for this session so a failure
        // you saw earlier is still there after switching away and back.
        const cachedErrors = errorsBySession.current[data?.sessionKey ?? ''] ?? [];
        setRows([
          { id: rid(), kind: 'status', text: `Resumed ${data?.sessionKey ?? 'session'} — ${mapped.length} entries.`, ts: Date.now() },
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
        // DESK-6v — and skip the state update entirely when nothing changed, so a
        // stable transcript doesn't re-render (and flash) every poll.
        const sig = (rows: ChatRow[], status?: string): string => `${status ?? ''}|` + rows.map((r) => r.kind === 'tool-group'
          ? `tg:${(r.items ?? []).map((it) => it.tool + it.summary + (it.ok ? '1' : '0')).join(',')}`
          : `${r.kind}:${(r as { text?: string }).text ?? ''}`).join('§');
        setTaskView((prev) => {
          if (prev && sig(prev.rows, prev.status) === sig(mapped, data.status)) return prev;
          return { id: data.id, kind: data.kind, role: data.role, goal: data.goal, status: data.status, parentSessionKey: prev?.parentSessionKey, rows: mapped };
        });
        return;
      }
      // DESK-6w — workflow run breakdown for the /workflows-style card.
      case 'q-workflow-detail': {
        if (result && typeof result === 'object') setWorkflowView(result as WorkflowDetail);
        else setWorkflowView((prev) => prev ? { ...prev, status: 'gone' } : prev);
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
        const lines = result && typeof result === 'object' && Array.isArray((result as { lines?: unknown }).lines)
          ? (result as { lines: string[] }).lines : [fmt(result)];
        setRows((r) => [...r, { id: rid(), kind: 'cmd-out', cmd: pendingCmdRef.current, lines, ts: Date.now() }]);
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
      case 'a-pref': q('q-snapshot', 'config-snapshot'); setToast('Saved — shared with the CLI.'); return;
      case 'a-hook': q('q-snapshot', 'config-snapshot'); setToast('Hook updated.'); return;
      case 'a-access': setToast('Access mode set for this session.'); return;
      case 'a-reconnect': q('q-snapshot', 'config-snapshot'); setToast('Reconnect requested.'); return;
      case 'a-rule': q('q-snapshot', 'config-snapshot'); setToast(result && typeof result === 'object' && (result as { ok?: boolean }).ok ? 'Permission rule saved — shared with the CLI.' : 'Could not save the rule.'); return;
      case 'a-addmcp': q('q-snapshot', 'config-snapshot'); setToast(result && typeof result === 'object' && (result as { ok?: boolean; error?: string }).ok ? 'MCP server added — shared with the CLI.' : `Could not add server: ${(result as { error?: string })?.error ?? 'unknown error'}`); return;
      case 'a-rmmcp': q('q-snapshot', 'config-snapshot'); setToast('MCP server removed.'); return;
      default: return;
    }
  }
}
