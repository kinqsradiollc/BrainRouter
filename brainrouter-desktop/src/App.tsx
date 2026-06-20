/**
 * DESK-4c — the app shell: left rail · chat thread · resizable panel columns.
 * Panels open as full-height window columns right of the chat (drag the left
 * edge to resize). Every CLI slash command surfaces here: ⌘K palette, the
 * composer "/" popup, and the categorized Settings modal.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react';
import type { AgentEvent, AgentEventMessage, InteractionRequest } from '@kinqs/brainrouter-agent-protocol';
import {
  DiffPanel, FilesPanel, FileViewerPanel, PlanPanel, SearchPanel, SchedulePanel, WorktreesPanel, ReviewPanel,
  RequirementsPanel, AnnotationsPanel, ArtifactsPanel, TasksPanel, TerminalPanel, ToolsPanel, ContextPanel, PANEL_DEFS, type PanelId, type SearchHit, type ReviewFindingView,
} from './panels/index.js';
import type { RequirementRecord, AnnotationRecord, ArtifactRecord, TrackProject, WorkItem, WorkItemType, Sprint, SprintState, AutomationRule, AutomationTrigger, AutomationAction, ProjectMember, ProjectRole } from '@kinqs/brainrouter-types';
import { TrackView, type SyncConfig, type SyncResult } from './track/TrackView.js';
import type { ScheduleRecordView } from './lib/schedule/scheduleView.js';
import { SESSION_BASE } from './lib/session/sessionPagination.js';
import { mergeOptimistic } from './lib/session/sessionOrder.js';
import { setEntry } from './lib/review/reviewWorkspace.js';
import { usePanels } from './lib/panels/usePanels.js';
import { buildCommandList, runCommand, resolveSlashInput, type CmdCtx, type CommandsCatalog, type DeskCommand, type SettingsSection } from './lib/commands/commands.js';
import { tagQueryId } from './lib/workspace/workspaceEvents.js';
import { duplicateTitleKeys } from './lib/session/sessionDisplay.js';
import { CommandPalette } from './palette.js';
import { SettingsDialog, type ConfigSnapshot } from './settings.js';
import { installDevBridge } from './devBridge.js';
import { Icon } from './icons.js';
import type { AttachmentUpload, PlanItem, ToolItem, ChatRow, SessionRow, FleetRow, PopId } from './types.js';
import type { PlanDecisionView } from './lib/plan/planReviewView.js';
import { fileFromSummary, fmtAge, fmt, download } from './lib/format.js';
import { FOREGROUND_ONLY_KINDS } from './constants.js';
import { useClosable } from './lib/useClosable.js';
import { rid } from './lib/rid.js';
import { useAgentEvents } from './lib/agent/useAgentEvents.js';
import { useEditor } from './lib/editor/useEditor.js';
import { useCi } from './lib/ci/useCi.js';
import { type DashTab, type DashTask, type WorkspaceDash } from './lib/workspace/dashboard.js';
// Monaco is ~5MB — lazy-load the editor panel so it only loads when first opened.
const EditorPanel = lazy(() => import('./panels/EditorPanel.js').then((m) => ({ default: m.EditorPanel })));
// CI + Dashboard are optional panels rarely opened on load — lazy so they stay
// out of the initial bundle / first paint.
const CIPanel = lazy(() => import('./panels/CIPanel.js').then((m) => ({ default: m.CIPanel })));
const DashboardPanel = lazy(() => import('./panels/DashboardPanel.js').then((m) => ({ default: m.DashboardPanel })));
import { MessageRow } from './chat/MessageRow.js';
import { SessionStatus } from './components/SessionStatus.js';
import { Composer } from './components/Composer.js';
import { useComposerDerived } from './lib/composer/useComposerDerived.js';
import { buildPromptWithAttachments, readyAttachments } from './lib/attachments/attachmentPrompt.js';
import { useSessionSidebar } from './lib/session/useSessionSidebar.js';
import { reorderProjectRoots, withCachedProjectSessions } from './lib/session/projectSessionsView.js';
import { useGitState } from './lib/git/useGitState.js';
import { useSessionState } from './lib/session/useSessionState.js';
import { saveExpandedProjects, withExpanded } from './lib/session/expandedProjectsStore.js';
import { sessionRowsCacheKey } from './lib/session/sessionCache.js';
import { workspaceRunCounts, runningWorkspaceSet } from './lib/workspace/runningIndicators.js';
import { useSessionActions } from './lib/session/useSessionActions.js';
import { GIT_VISIBLE_POLL_MS, gitPollRefreshDue, gitRefreshDue } from './lib/git/gitFreshness.js';
import { TopbarRight } from './components/TopbarRight.js';
import { Sidebar } from './components/Sidebar.js';
import { ChatThread } from './components/ChatThread.js';
import { ViewsRail } from './components/ViewsRail.js';
import { EnvironmentPanel } from './components/EnvironmentPanel.js';
import { TerminalDock } from './components/TerminalDock.js';
import { InfoAndGateDialogs } from './components/InfoAndGateDialogs.js';
import { InteractionDialogs } from './components/InteractionDialogs.js';
import { ExportAndMenuDialogs } from './components/ExportAndMenuDialogs.js';

installDevBridge();

export function App(): React.ReactElement {
  const [draft, setDraft] = useState('');
  // T4 — session/workspace STATE container. Every symbol is destructured back so
  // existing references (render JSX, useAgentEvents ctx, action hooks) are unchanged.
  const {
    viewKey, setViewKey, running, setRunning, stopping, setStopping,
    runningSessions, setRunningSessions, runningSessionsRef,
    sessions, setSessions, sessionsRef, pendingSessionsRef,
    liveChildren, setLiveChildren, renamingKey, setRenamingKey, renameDraft, setRenameDraft,
    showArchived, setShowArchived, sessionGroups, setSessionGroups,
    finishedTasks, setFinishedTasks, taskView, setTaskView, workflowView, setWorkflowView,
    sessionMenu, setSessionMenu, sessionKeyRef, cardOpenRef, errorsBySession, lastPromptRef, planFeedbackRef, goalContPendingRef, turnFailsRef,
    workspaces, setWorkspaces, expandedProjects, setExpandedProjects, expandedProjectsRef, projSessions, setProjSessions,
    activeWsRef, workspaceGenRef, pendingWorkspaceRef, pendingResumeRef, trustAsk, setTrustAsk, runningWs, setRunningWs,
    setSessionRunning,
  } = useSessionState();

  const cachedSessionRowsRef = useRef<Record<string, ChatRow[]>>({});
  const [rows, setRowsState] = useState<ChatRow[]>([]);
  const setRows = useCallback((val: ChatRow[] | ((prev: ChatRow[]) => ChatRow[])) => {
    setRowsState((prev) => {
      const next = typeof val === 'function' ? val(prev) : val;
      if (sessionKeyRef.current) {
        cachedSessionRowsRef.current[sessionRowsCacheKey(activeWsRef.current, sessionKeyRef.current)] = next;
      }
      return next;
    });
  }, [activeWsRef, sessionKeyRef]);
  const [statusLine, setStatusLine] = useState('');
  const [reasoningTail, setReasoningTail] = useState('');
  const [liveText, setLiveText] = useState('');
  const [fleet, setFleet] = useState<FleetRow[]>([]);
  // §3 — recently-finished DURABLE tasks (completed/failed) for THIS workspace,
  // so the Background panel shows verification/review/revision outcomes, not just
  // what's running. Sourced from the durable `tasks-list` query (status: all).
  const [recentTasks, setRecentTasks] = useState<FleetRow[]>([]);
  const [info, setInfo] = useState<{ sessionKey?: string; model?: string; workspaceRoot?: string; username?: string }>({});
  const [hostUp, setHostUp] = useState(false);
  const [interaction, setInteraction] = useState<InteractionRequest | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [railOpen, setRailOpen] = useState(() => {
    const saved = localStorage.getItem('br-rail-open');
    return saved !== null ? saved === '1' : true;
  });
  // DESK-5i — the left sidebar starts at its minimum size (220) on launch.
  const [railWidth, setRailWidth] = useState(220);

  // DESK-5f — ONE tabbed side panel (Codex model): views are tabs you switch
  // between, never extra window columns. Empty tab list = the view chooser.
  // DESK-5h — measured room: the Environment COLUMN (it reserves layout space,
  // never overlays the chat) and its toggle yield when the chat would squeeze.
  const workrowRef = useRef<HTMLDivElement>(null);
  const [workW, setWorkW] = useState(0);
  const [toolLog, setToolLog] = useState<Array<{ id: number; tool: string; ok: boolean; summary: string }>>([]);
  const [tokens, setTokens] = useState<{ promptTokens: number; completionTokens: number; turns: number; cachedTokens?: number } | null>(null);
  // LIVE — the in-flight turn's running usage (from usage-live), cleared at
  // turn-start/end. Added to the session base (`tokens`) so the Context panel's
  // token counter climbs during a turn instead of jumping only at turn-end.
  const [liveTurn, setLiveTurn] = useState<{ promptTokens: number; completionTokens: number; calls: number; cachedTokens?: number } | null>(null);
  // Session efficiency — what the runtime SAVED: prompt-cache reuse (in `tokens`),
  // history compaction, and memory recall. Reset when the session changes.
  const [efficiency, setEfficiency] = useState<{ compactions: number; droppedMessages: number; memoriesRecalled: number }>({ compactions: 0, droppedMessages: 0, memoriesRecalled: 0 });
  // Workspace MODE — Chat · Track · Code, switched from the left sidebar (each
  // swaps the whole main surface). Code is the default agentic-coding view.
  const [mode, setMode] = useState<'chat' | 'track' | 'code'>('code');
  // Track mode data (the per-workspace project + its work items), fed by the
  // host `track-*` queries. Mutations re-fetch the item list.
  const [track, setTrack] = useState<{ project: TrackProject | null; items: WorkItem[]; sprints: Sprint[]; automations: AutomationRule[]; members: ProjectMember[]; sync: { config: SyncConfig | null; result: SyncResult | null } }>({ project: null, items: [], sprints: [], automations: [], members: [], sync: { config: null, result: null } });
  const [lastPlan, setLastPlan] = useState<{ items: PlanItem[]; explanation?: string } | null>(null);
  const [planHistory, setPlanHistory] = useState<PlanDecisionView[]>([]);
  const [searchHits, setSearchHits] = useState<SearchHit[] | null>(null);

  // Command surfaces + settings
  const [catalog, setCatalog] = useState<CommandsCatalog | null>(null);
  const [snapshot, setSnapshot] = useState<ConfigSnapshot | null>(null);
  const [usageLines, setUsageLines] = useState<string[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settings, setSettings] = useState<{ open: boolean; section: SettingsSection }>({ open: false, section: 'general' });
  const [infoDialog, setInfoDialog] = useState<{ title: string; body: string } | null>(null);
  const [toast, setToast] = useState('');
  const [slashSel, setSlashSel] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [codeFont, setCodeFont] = useState(() => localStorage.getItem('br-code-font') ?? '');
  const [theme, setTheme] = useState(() => localStorage.getItem('br-desktop-theme') ?? 'dark');
  const [recentsSort, setRecentsSort] = useState<'recent' | 'alpha'>('recent');
  const [homeStats, setHomeStats] = useState<{
    sessions: number; turns: number; activeDays: number; currentStreak: number;
    longestStreak: number; model: string; perDay: Record<string, number>;
  } | null>(null);
  const [statsTab, setStatsTab] = useState<'overview' | 'models'>('overview');
  const [statsRange, setStatsRange] = useState<'all' | '30d' | '7d'>('all');
  // DESK-4m — popovers (one open at a time) across composer, top bar, and menus.
  const [pop, setPop] = useState<PopId>('');
  // DESK-5q/5r — context fill for the composer ring (vs the auto-compact limit).
  const [contextUsage, setContextUsage] = useState<{ used: number; window: number; compactAt: number; limit: number; pct: number } | null>(null);
  // DESK-5e — the Environment card is PINNED, not a transient popover: it
  // stays until the toggle is clicked again (Codex behavior) and survives
  // relaunches via localStorage.
  const [envOpen, setEnvOpen] = useState(() => localStorage.getItem('br-env-open') === '1');

  const liveBuf = useRef('');
  // DESK-5w (#4 lag) — coalesce streaming deltas: setLiveText at most ~16×/s
  // instead of on every ~18ms chunk, so the in-progress markdown re-parses far
  // less often. The final text always comes from liveBuf (flushAssistant), so
  // throttling never drops content.
  const liveFlushPending = useRef(false);
  const chatEnd = useRef<HTMLDivElement>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [turnStart, setTurnStart] = useState(0);
  // DESK-5e — the Environment "Checks" row is real signal: failed tool calls
  // in the last completed turn (null until a turn has finished here).
  const [lastTurnFails, setLastTurnFails] = useState<number | null>(null);
  const [grepHits, setGrepHits] = useState<import('./panels/index.js').GrepHit[] | null>(null);
  const [branches, setBranches] = useState<{ current: string | null; branches: string[]; loading?: boolean }>({ current: null, branches: [] });
  const [endpointModels, setEndpointModels] = useState<string[]>([]);
  // §endpoint-driven-models — per-named-provider /models lists for the sub-agent
  // model pickers (keyed by provider name; fetched via list-models { provider }).
  const [providerModels, setProviderModels] = useState<Record<string, string[]>>({});
  const [modelsLoading, setModelsLoading] = useState(false);
  // Item 10 — where a model pick is saved: 'global' = config.json (shared with
  // the CLI, every chat), 'session' = this chat only (sessionRuntimeStore).
  const [modelScope, setModelScope] = useState<'global' | 'session'>('global');
  // T14 — scheduled tasks for the viewed session (cron/once), from the CLI store.
  const [schedules, setSchedules] = useState<ScheduleRecordView[]>([]);
  // REQUIREMENT-RECORDS — this workspace's Requirement Records, from the CLI store.
  const [requirements, setRequirements] = useState<RequirementRecord[]>([]);
  // ANNOTATION-RECORDS — this workspace's durable feedback records, from the CLI store.
  const [annotations, setAnnotations] = useState<AnnotationRecord[]>([]);
  // ARTIFACT-RECORDS — this workspace's durable Artifact Records, from the CLI store.
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([]);
  const [chatWidth, setChatWidth] = useState(() => localStorage.getItem('br-chat-w') ?? 'medium');
  const [chatSize, setChatSize] = useState(() => localStorage.getItem('br-chat-fs') ?? 'medium');
  const [accent, setAccent] = useState(() => localStorage.getItem('br-accent') ?? '');
  const [prInfo, setPrInfo] = useState<{ number: number; state: string; title?: string } | null>(null);
  const [recentsOpenByRoot, setRecentsOpenByRoot] = useState<Record<string, boolean>>({});
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesTruncated, setFilesTruncated] = useState(false);
  const [filesError, setFilesError] = useState('');
  const [attachmentUploads, setAttachmentUploads] = useState<AttachmentUpload[]>([]);
  const activeSidebarRoot = workspaces.current ?? info.workspaceRoot ?? '';
  const recentsOpen = activeSidebarRoot ? (recentsOpenByRoot[activeSidebarRoot] ?? true) : true;
  const setRecentsOpen = useCallback<React.Dispatch<React.SetStateAction<boolean>>>((value) => {
    const root = activeWsRef.current ?? activeSidebarRoot;
    if (!root) return;
    const currentOpen = recentsOpenByRoot[root] ?? true;
    const nextOpen = typeof value === 'function' ? value(currentOpen) : value;
    setRecentsOpenByRoot((prev) => {
      if ((prev[root] ?? true) === nextOpen) return prev;
      return { ...prev, [root]: nextOpen };
    });
    setExpandedProjects((prev) => {
      const next = nextOpen ? withExpanded(prev, root) : prev.filter((r) => r !== root);
      expandedProjectsRef.current = next;
      return next;
    });
  }, [activeSidebarRoot, activeWsRef, expandedProjectsRef, recentsOpenByRoot, setExpandedProjects]);
  // Item 9 — how many of the current project's chats are shown (grows a page at
  // a time via the show-more button). Collapsed view always shows the base few.
  const [visibleCount, setVisibleCount] = useState(SESSION_BASE);
  const commands = useMemo(() => buildCommandList(catalog), [catalog]);

  const q = (id: string, name: string, args?: Record<string, unknown>) => {
    if (name === 'list-files') { setFilesLoading(true); setFilesError(''); }
    window.brainrouter.send({ kind: 'query', id: tagQueryId(id, workspaceGenRef.current), name, args });
  };

  // Track mode — fetch the project + work items on entering Track or switching
  // workspace; mutations return the updated list (handled in useAgentEvents).
  useEffect(() => {
    if (mode !== 'track') return;
    q('q-track-project', 'track-project');
    q('q-track-items', 'track-items');
    q('q-track-sprints', 'track-sprints');
    q('q-track-automations', 'track-automations');
    q('q-track-members', 'track-members');
    q('q-track-sync-config', 'track-sync-config');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, info.workspaceRoot]);

  // A4 — Chat is a READ-ONLY conversational stance: the agent can read, search,
  // and reason, but cannot write files or run shell. Entering Chat pins the
  // active agent to 'read' access; Code/Track restore the default 'shell'. Re-
  // asserted on every mode switch so a fresh/swapped agent inherits the stance.
  useEffect(() => {
    // Distinct id from the manual settings selector ('a-access') so the
    // automatic, mode-driven switch stays SILENT — no per-switch toast.
    q('a-mode-access', 'action:set-access', { mode: mode === 'chat' ? 'read' : 'shell' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, info.sessionKey]);
  const trackOps = {
    create: (input: { title: string; type: WorkItemType; status: string }) => q('q-track-create', 'track-create', input),
    transition: (idOrKey: string, toStatus: string) => q('q-track-transition', 'track-transition', { idOrKey, toStatus }),
    update: (idOrKey: string, patch: Partial<WorkItem>) => q('q-track-update-item', 'track-update-item', { idOrKey, patch }),
    comment: (idOrKey: string, body: string) => q('q-track-comment', 'track-comment', { idOrKey, body }),
    link: (idOrKey: string, input: { codeLinks?: WorkItem['codeLinks']; linkedMemoryIds?: string[]; blocks?: string }) => q('q-track-link', 'track-link', { idOrKey, ...input }),
    assignSprint: (idOrKey: string, sprintId: string | null) => q('q-track-assign-sprint', 'track-assign-sprint', { idOrKey, sprintId }),
    createSprint: (name: string, goal?: string) => q('q-track-create-sprint', 'track-create-sprint', { name, goal }),
    sprintState: (id: string, state: SprintState) => q('q-track-sprint-state', 'track-sprint-state', { id, state }),
    createAutomation: (input: { name: string; trigger: AutomationTrigger; condition?: string; actions: AutomationAction[] }) => q('q-track-create-automation', 'track-create-automation', input),
    updateAutomation: (id: string, patch: Partial<AutomationRule>) => q('q-track-update-automation', 'track-update-automation', { id, patch }),
    deleteAutomation: (id: string) => q('q-track-delete-automation', 'track-delete-automation', { id }),
    addMember: (input: { id: string; name?: string; role: ProjectRole }) => q('q-track-add-member', 'track-add-member', input),
    updateMemberRole: (id: string, role: ProjectRole) => q('q-track-update-member-role', 'track-update-member-role', { id, role }),
    removeMember: (id: string) => q('q-track-remove-member', 'track-remove-member', { id }),
    syncMembers: () => q('q-track-sync-members', 'track-sync-members', {}),
    sync: (direction: 'import' | 'export', dryRun: boolean) => {
      q('q-track-sync', 'track-sync', { direction, dryRun });
      // A real run can create/modify items — refresh the board shortly after.
      if (!dryRun) window.setTimeout(() => { q('q-track-items', 'track-items'); }, 600);
    },
  };

  // T4 — git/diff/review STATE + the Changes-tab git action (runGit). Every symbol
  // is destructured back so existing references (render JSX, useAgentEvents ctx)
  // keep compiling unchanged.
  const {
    changedFiles, setChangedFiles, diffView, setDiffView, diffTarget, setDiffTarget,
    allFiles, setAllFiles, fileView, setFileView, gitInfo, setGitInfo, commitSubjects, setCommitSubjects,
    gitBusy, setGitBusy, pendingGitRef, gateBlock, setGateBlock,
    worktrees, setWorktrees, worktreeDiffs, setWorktreeDiffs, inlineDiffs, setInlineDiffs,
    reviewByWs, setReviewByWs, reviewGateByWs, setReviewGateByWs, reviewRunningByWs, setReviewRunningByWs,
    activeRoot, review, reviewGate, reviewRunning, activeReviewBadge, reviewFindingsByFile,
    runGit,
  } = useGitState({ q, setToast, workspaces, info });

  // T4 — panel/dock state + handlers live in usePanels (q injected so ensurePanel
  // can refresh worktrees/review on open).
  const {
    sideTabs, activeSideTab, sidePanelOpen, sideWidth, sideFullScreen, termDockOpen, termDockHeight, termTabs, activeTerm,
    setSideTabs, setActiveSideTab, setSidePanelOpen, setSideWidth, setSideFullScreen, setTermDockOpen, setTermDockHeight, setTermTabs, setActiveTerm,
    ensurePanel, closeSideTab, reorderSideTab, togglePanel, openSideView, openBottomDock, addBottomTab, closeBottomTab, resizeTerminal, resetTermDock,
  } = usePanels(q);

  // T5 — in-app code editor. Self-contained (own host round-trips); on a save it
  // refreshes git status + changed files and re-checks the review gate (the
  // working tree just changed). Reads/writes go through the host, never the fs.
  const editor = useEditor({
    workspaceRoot: workspaces.current ?? info.workspaceRoot,
    onSaved: () => { q('q-git', 'git-info'); q('q-files', 'changed-files'); q('q-list', 'list-files', { refresh: true }); q('q-review-gate', 'review-gate'); },
    onToast: setToast,
  });
  // T5 — warn before a reload/close drops unsaved editor changes.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => { if (editor.anyDirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [editor.anyDirty]);

  // T6 — GitHub CI/CD (real `gh` status, kept separate from local tool success).
  const ci = useCi({ workspaceRoot: workspaces.current ?? info.workspaceRoot, onToast: setToast });

  // T1 — workflow/background dashboard. Workspace scope uses the live fleet +
  // finished tasks; All scope disk-reads every recent workspace via main.
  const [dashScope, setDashScope] = useState<'workspace' | 'all'>('workspace');
  const [dashTab, setDashTab] = useState<DashTab>('running');
  const [globalBoards, setGlobalBoards] = useState<WorkspaceDash[] | null>(null);
  const [dashBusy, setDashBusy] = useState(false);
  const pendingDashboardTaskRef = useRef<DashTask | null>(null);

  // T4 — session/workspace/panel ACTION functions (no command-catalog deps) live
  // in useSessionActions. Every symbol is destructured back so existing references
  // (render JSX, useAgentEvents ctx, effects) keep compiling unchanged. Called here
  // — after q / git state / panels / editor / ci / dashboard state are available —
  // so useAgentEvents below can reference refreshSession/refreshSidebar as consts.
  const {
    refreshSession, refreshSidebar, refreshGit, resumeSession, resumeSessionRef, resumeTimerRef,
    openTask, openWorkflow, viewToTop, answerInteraction, requestStop,
    switchToWorkspace, openProject, addProject, toggleProject,
    openSettings, openFile, closeEditorTab, openUrl, openCiPanel, refreshDashboard, openDashboard,
    closeSessionMenu, setMeta, togglePin, toggleComplete, toggleArchive, moveToGroup,
    startRename, commitRename, forkSessionAction, deleteSessionAction, openExternal, openSessionMenu,
  } = useSessionActions({
    q, running, stopping, interaction, renamingKey, renameDraft, workspaces, info, projSessions, recentsOpenByRoot,
    runningSessionsRef, sessionKeyRef, activeWsRef, pendingWorkspaceRef, pendingResumeRef, pendingSessionsRef, sessionsRef,
    workspaceGenRef, expandedProjectsRef,
    liveBuf, chatRef, atBottomRef, errorsBySession, cachedSessionRowsRef,
    setStopping, setStatusLine, setReasoningTail, setLiveText, setRows, setRunning, setInteraction,
    setSessions, setSearchHits, setViewKey, setTaskView, setWorkflowView, setWorkspaces, setExpandedProjects, setTrustAsk,
    setHostUp, setGitInfo, setPrInfo, setBranches, setChangedFiles, setAllFiles, setFileView, setDiffView,
    setTokens, setContextUsage, setGateBlock, setLastPlan, setPlanHistory, setFleet, setLiveChildren, setRecentTasks, setFinishedTasks, setCommitSubjects, setToast,
    setProjSessions, setSettings, setSessionMenu, setRenamingKey, setRenameDraft, setDashBusy, setGlobalBoards,
    pendingGitRef, ensurePanel, resetTermDock, editor, ci,
  });

  // Git/branch is LIVE environment state, not durable session truth — re-read
  // it when the window regains focus or the tab becomes visible, so a branch
  // switched in another terminal shows up instead of a stale one. Debounced
  // (gitRefreshDue) so the focus + paired visibilitychange collapse to one.
  const lastGitFocusRef = useRef(0);
  const lastGitPollRef = useRef(0);
  useEffect(() => {
    const onWake = (): void => {
      if (!hostUp) return;
      const now = Date.now();
      if (!gitRefreshDue(lastGitFocusRef.current, now, document.visibilityState === 'visible')) return;
      lastGitFocusRef.current = now;
      refreshGit();
    };
    window.addEventListener('focus', onWake);
    document.addEventListener('visibilitychange', onWake);
    return () => { window.removeEventListener('focus', onWake); document.removeEventListener('visibilitychange', onWake); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostUp]);

  useEffect(() => {
    if (!hostUp) return;
    const onPoll = (): void => {
      const now = Date.now();
      if (!gitPollRefreshDue(lastGitPollRef.current, now, document.visibilityState === 'visible')) return;
      lastGitPollRef.current = now;
      refreshGit();
    };
    onPoll();
    const timer = window.setInterval(onPoll, GIT_VISIBLE_POLL_MS);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostUp]);

  const pendingCmdRef = useRef('');
  function runBridge(cmd: string, argText = ''): void {
    pendingCmdRef.current = `/${cmd}${argText ? ` ${argText}` : ''}`;
    q('q-cmd', 'command:dispatch', { cmd, args: argText });
  }

  const cmdCtx: CmdCtx = {
    send: (c) => window.brainrouter.send(c as never),
    query: q,
    ensurePanel,
    openSettings,
    info: (title, body) => setInfoDialog({ title, body }),
    toast: setToast,
    compose: (text) => { setDraft(text); setSlashDismissed(true); },
    bridge: runBridge,
  };

  useEffect(() => {
    if (!running) return;
    // DESK-5r — context ring: lastSeenPromptTokens grows after each LLM call
    // within the turn, so polling shows context fill rise live. (The elapsed
    // timer is now self-contained in <WorkElapsed/>, so no app-wide tick here.)
    const fp = setInterval(() => { q('q-ctx', 'context-usage'); }, 2000);
    q('q-ctx', 'context-usage'); // immediate, don't wait the first interval
    return () => { clearInterval(fp); };
  }, [running]);

  // §7 — keep the plan version history LIVE. A new plan VERSION under auto/YOLO
  // mode records an `actor:'auto'` approval in core (agent.maybeAutoApprovePlan)
  // with NO prompt; without this the "approved · auto" entry only appears after
  // the user clicks Approve. Re-fetch the history whenever the plan's step
  // STRUCTURE changes (a new version → a decision was just recorded), so the
  // auto-approval shows up on its own. Keyed on the step signature so a plain
  // status tick (same steps) doesn't spam the host.
  const planSigRef = useRef('');
  useEffect(() => {
    const sig = (lastPlan?.items ?? []).map((it) => it.step).join('');
    if (sig && sig !== planSigRef.current) {
      planSigRef.current = sig;
      // small delay so core has flushed recordPlanDecision before we read.
      const t = setTimeout(() => q('q-plan-history', 'plan-history'), 200);
      return () => clearTimeout(t);
    }
  }, [lastPlan]);

  // DESK-5w — keep the per-session background-task list fresh even when the
  // VIEWED chat is idle: another chat may be running work whose tasks should
  // appear/clear in the sidebar (and reflect the boot-time stale reconcile).
  useEffect(() => {
    const tick = (): void => { q('q-fleet', 'fleet'); q('q-tasks-recent', 'tasks-list', { scope: 'workspace', status: 'all' }); };
    const t = setInterval(tick, 3000);
    tick();
    return () => clearInterval(t);
  }, []);
  // Fix 4 / §3 — keep the CROSS-workspace running indicators fresh (durable-merged
  // global dashboard) so a workspace with a background task shows a running dot +
  // count even when it isn't the active one, and survives host reload / refresh.
  // Light: small per-workspace JSON reads; does not toggle the dashboard's busy
  // state. Skipped when the bridge has no globalDashboard (browser dev mock).
  useEffect(() => {
    if (!window.brainrouter.globalDashboard) return;
    let alive = true;
    const tick = (): void => {
      window.brainrouter.globalDashboard?.()
        .then((r) => { if (alive) setGlobalBoards((r.workspaces ?? []) as unknown as WorkspaceDash[]); })
        .catch(() => { /* disk/gh unreadable */ });
    };
    tick();
    const t = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // T14 — keep the Schedules panel fresh (cheap store read) so nextRun/lastRun
  // tick and another head's /schedule edits show up.
  useEffect(() => {
    const t = setInterval(() => q('q-schedule', 'schedule-list'), 5000);
    q('q-schedule', 'schedule-list');
    return () => clearInterval(t);
  }, []);

  // Wave 1 — main pushes project membership/state updates and explicit manual
  // reorders. Opening/viewing/activity does not promote projects, so the list
  // stays stable while you browse.
  useEffect(() => {
    const off = window.brainrouter.onRecentsChanged?.((data) => {
      setWorkspaces((w) => ({ ...w, recents: data.recents }));
      setProjSessions((prev) => {
        const state = prev[data.workspaceRoot];
        if (!state) return prev;
        return { ...prev, [data.workspaceRoot]: { ...state, loadedAt: 0 } };
      });
    });
    return () => off?.();
  }, []);

  // DESK-5w — while a task's conversation is open, refresh it so a running
  // worker/subagent's chat updates as it works.
  useEffect(() => {
    if (!taskView) return;
    const { kind, id, parentSessionKey } = taskView;
    q('q-task-transcript', 'task-transcript', { kind, id, parentSessionKey: parentSessionKey ?? '' });
    const t = setInterval(() => q('q-task-transcript', 'task-transcript', { kind, id, parentSessionKey: parentSessionKey ?? '' }), 2500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskView?.id, taskView?.kind, taskView?.parentSessionKey]);

  // DESK-6w — while a workflow card is open, refresh its phases/agent stats live.
  useEffect(() => {
    if (!workflowView) return;
    const slug = workflowView.slug;
    const t = setInterval(() => q('q-workflow-detail', 'workflow-detail', { slug }), 2500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowView?.slug]);

  // DESK-6w — keep the auto-scroll suppressor in sync with any card view.
  useEffect(() => { cardOpenRef.current = !!(taskView || workflowView); }, [taskView, workflowView]);

  // Close any open task/workflow CARD the moment the active session changes —
  // a catch-all so navigating between sessions always drops back to the chat
  // (matching sub-agents), no matter which navigation path fired. Opening a card
  // doesn't change viewKey, so a freshly-opened card is never cleared by this.
  useEffect(() => { setTaskView(null); setWorkflowView(null); }, [viewKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    document.documentElement.style.setProperty('--chat-w', chatWidth === 'narrow' ? '720px' : chatWidth === 'wide' ? '980px' : '840px');
    document.documentElement.style.setProperty('--chat-fs', chatSize === 'small' ? '13.5px' : chatSize === 'large' ? '15.5px' : '14.5px');
    localStorage.setItem('br-chat-w', chatWidth);
    localStorage.setItem('br-chat-fs', chatSize);
  }, [chatWidth, chatSize]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    localStorage.setItem('br-env-open', envOpen ? '1' : '0');
  }, [envOpen]);

  useEffect(() => {
    localStorage.setItem('br-rail-w', String(railWidth));
  }, [railWidth]);

  useEffect(() => {
    localStorage.setItem('br-rail-open', railOpen ? '1' : '0');
  }, [railOpen]);

  // Fix 4 — persist sidebar workspace expansion so it survives refresh / host
  // reload / workspace switch (the collapse-on-switch bug). User-controlled.
  useEffect(() => {
    saveExpandedProjects(expandedProjects);
  }, [expandedProjects]);

  // DESK-5h — track the workrow's real width (window size AND panel state both
  // change it); drives the Environment column's show/yield logic.
  useEffect(() => {
    const el = workrowRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWorkW(el.clientWidth));
    ro.observe(el);
    setWorkW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen((p) => !p); }
      // View shortcuts (parity with the reference app's Views menu)
      if (mod && e.shiftKey && e.key.toLowerCase() === 'd') { e.preventDefault(); togglePanel('diff'); }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); togglePanel('files'); }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'g') { e.preventDefault(); togglePanel('plan'); }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'e') { e.preventDefault(); setSideFullScreen((v) => !v); setSidePanelOpen(true); }
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); togglePanel('files'); }
      if (e.ctrlKey && e.key === '`') { e.preventDefault(); setTermDockOpen((o) => !o); }
      if (mod && !e.shiftKey && /^[1-9]$/.test(e.key)) {
        const idx = Number(e.key) - 1;
        const sess = sessionsRef.current[idx];
        if (sess) { e.preventDefault(); resumeSessionRef.current(sess.sessionKey); }
      }
      if (mod && e.key === ',') { e.preventDefault(); openSettings('general'); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    document.documentElement.style.setProperty('--mono',
      codeFont.trim() ? `"${codeFont.trim()}", "SF Mono", Consolas, monospace` : '"SF Mono", "Cascadia Code", "JetBrains Mono", Consolas, monospace');
    localStorage.setItem('br-code-font', codeFont);
  }, [codeFont]);

  useEffect(() => {
    // DESK-5m — mark macOS so the rail can reserve the traffic-light strip
    // (the frameless hiddenInset window puts the lights over the top-left).
    if (/Mac/i.test(navigator.platform) || /Mac/i.test(navigator.userAgent)) document.documentElement.dataset.os = 'mac';
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('br-desktop-theme', theme);
  }, [theme]);

  useEffect(() => {
    // Codex-style accent customization: one color drives accent + its soft tint.
    const root = document.documentElement.style;
    if (accent) {
      root.setProperty('--accent', accent);
      root.setProperty('--accent-soft', `${accent}21`);
    } else {
      root.removeProperty('--accent');
      root.removeProperty('--accent-soft');
    }
    localStorage.setItem('br-accent', accent);
  }, [accent]);

  // DESK-5j — no auto-close at a px breakpoint: ⌘+/- zoom shrinks the CSS
  // viewport, and the rail vanishing mid-zoom read as the UI breaking apart.
  // Panels are user-controlled; columns shrink in place instead.

  useAgentEvents({
    setRows, setRunning, setStopping, setTurnStart, setStatusLine, setReasoningTail, setLiveText, setToolLog,
    setLiveChildren, setFinishedTasks, setLastPlan, setPlanHistory, setTokens, setLiveTurn, setEfficiency, setTrack, setInteraction, setPicked, setViewKey,
    setTaskView, setWorkflowView, setInfo, setWorkspaces, setRunningWs, setHostUp, setLastTurnFails,
    setDraft, setProjSessions, setSessions, setPrInfo, setContextUsage, setFleet, setRecentTasks, setChangedFiles,
    setDiffView, setInlineDiffs, setAllFiles, setFileView, setGitInfo, setCommitSubjects, setHomeStats,
    setBranches, setModelsLoading, setEndpointModels, setProviderModels, setCatalog, setSnapshot, setUsageLines,
    setSearchHits, setSchedules, setRequirements, setAnnotations, setArtifacts, setWorktrees, setWorktreeDiffs, setReviewRunningByWs, setReviewByWs,
    setReviewGateByWs, setGateBlock, setGrepHits, setSessionGroups, setGitBusy, setInfoDialog, setToast,
    setFilesLoading, setFilesTruncated, setFilesError, setAttachmentUploads,
    setAtBottom,
    liveBuf, liveFlushPending, activeWsRef, sessionKeyRef, turnFailsRef, runningSessionsRef,
    pendingWorkspaceRef, pendingResumeRef, errorsBySession, lastPromptRef, planFeedbackRef, goalContPendingRef, workspaceGenRef, pendingSessionsRef, sessionsRef,
    atBottomRef, cardOpenRef, chatEnd, chatRef, pendingGitRef, pendingCmdRef, cachedSessionRowsRef,
    q, refreshSession, refreshSidebar, runGit, setSessionRunning, info, gitInfo, homeStats, branches,
  });

  function submit(): void {
    const typedPrompt = draft.trim();
    const pendingAttachments = attachmentUploads.filter((a) => a.status === 'reading' || a.status === 'attaching');
    const failedAttachments = attachmentUploads.filter((a) => a.status === 'failed');
    const attached = readyAttachments(attachmentUploads);
    if (running || stopping) return;
    if (!typedPrompt && attached.length === 0) return;
    if (pendingAttachments.length > 0) {
      setToast(pendingAttachments.length === 1 ? `Still attaching ${pendingAttachments[0].name}…` : `Still attaching ${pendingAttachments.length} files…`);
      return;
    }
    if (failedAttachments.length > 0) {
      setToast(failedAttachments.length === 1 ? `Remove failed attachment ${failedAttachments[0].name} before sending.` : 'Remove failed attachments before sending.');
      return;
    }
    const prompt = buildPromptWithAttachments(typedPrompt, attached);
    const displayPrompt = typedPrompt || (attached.length === 1 ? `Use attached file: ${attached[0].name}` : `Use ${attached.length} attached files`);
    // T8 — a slash command is NEVER sent to the LLM. Route it through the
    // command registry: bridge runs against the CLI stores, known commands run
    // their wire (panel/settings/native/cli fallback), and an UNKNOWN slash
    // surfaces a command-output card instead of becoming a chat prompt.
    const slash = resolveSlashInput(typedPrompt, commands);
    if (slash.kind !== 'not-slash') {
      if (attached.length > 0) {
        setToast('Attachments are sent with chat messages, not slash commands.');
        return;
      }
      setDraft('');
      if (slash.kind === 'bridge') runBridge(slash.cmd, slash.args);
      else if (slash.kind === 'command') runCommand(slash.command, cmdCtx);
      else {
        const nowTs = Date.now();
        const stableCmdId = `${sessionKeyRef.current ?? 'global'}-cmd-out-${nowTs}-${typedPrompt.slice(0, 32).replace(/[^a-zA-Z0-9]/g, '_')}`;
        setRows((r) => [...r, { id: stableCmdId, kind: 'cmd-out', cmd: typedPrompt,
          lines: [`Unknown command \`${slash.base}\` — type \`/\` to browse commands, or run it in the terminal CLI.`], ts: nowTs }]);
      }
      return;
    }
    lastPromptRef.current = typedPrompt;
    // §goal-autonomy — a real user message preempts any queued goal continuation.
    goalContPendingRef.current = null;
    const nowTs = Date.now();
    const stableId = `${sessionKeyRef.current ?? 'global'}-user-${nowTs}-${displayPrompt.slice(0, 32).replace(/[^a-zA-Z0-9]/g, '_')}`;
    setRows((r) => [...r, { id: stableId, kind: 'user', text: displayPrompt, ts: nowTs }]);
    setDraft('');
    if (attached.length > 0) setAttachmentUploads((prev) => prev.filter((a) => !attached.some((sent) => sent.id === a.id)));
    setRunning(true);
    // DESK-5v — mark THIS session running so its spinner survives a switch away.
    setSessionRunning(sessionKeyRef.current ?? info.sessionKey ?? '', true);
    setTurnStart(Date.now());
    turnFailsRef.current = 0;
    // DESK-6t — show this chat in "Projects" IMMEDIATELY (optimistic row), so a
    // brand-new chat doesn't stay invisible in the sidebar until the turn ends.
    // refreshSession() shortly after reconciles it with the host-backed row.
    const sk = sessionKeyRef.current ?? info.sessionKey;
    if (sk) {
      const optimistic: SessionRow = { sessionKey: sk, firstUserMessage: displayPrompt, modifiedAt: new Date().toISOString(), turnCount: 1, lastRole: 'user' };
      // Wave 2 — track it as pending so subsequent list-sessions refreshes MERGE
      // it (instead of replacing it away) until the host transcript confirms it.
      if (!pendingSessionsRef.current.some((s) => s.sessionKey === sk)) pendingSessionsRef.current = [optimistic, ...pendingSessionsRef.current];
      setSessions((prev) => mergeOptimistic(prev.filter((s) => s.sessionKey !== sk), [optimistic]));
      sessionsRef.current = mergeOptimistic(sessionsRef.current.filter((s) => s.sessionKey !== sk), [optimistic]);
      setProjSessions((prev) => {
        const root = activeWsRef.current ?? info.workspaceRoot ?? workspaces.current;
        if (!root) return prev;
        const rows = mergeOptimistic((prev[root]?.rows ?? []).filter((s) => s.sessionKey !== sk), [optimistic]);
        return withCachedProjectSessions(prev, root, rows);
      });
      setTimeout(() => refreshSession(), 400);
    }
    window.brainrouter.send({ kind: 'start-turn', prompt });
  }

  // §5 — attach dropped/picked files: read each as base64 in the renderer and
  // ingest into a durable attachment record (the host preserves the original,
  // extracts text/metadata, links to memory) as a visible 'attachment' task.
  const attachFiles = (files: File[]): void => {
    const batch = files.slice(0, 8); // bound a stray multi-select
    const uploads = batch.map((file) => ({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name: file.name,
      size: file.size,
      status: 'reading' as const,
    }));
    if (uploads.length) setAttachmentUploads((prev) => [...prev, ...uploads]);
    batch.forEach((file, index) => {
      const upload = uploads[index];
      const reader = new FileReader();
      reader.onload = () => {
        const out = reader.result;
        if (typeof out !== 'string') {
          setAttachmentUploads((prev) => prev.map((u) => u.id === upload.id ? { ...u, status: 'failed', detail: 'Could not read this file.' } : u));
          setToast(`✗ Could not read ${file.name}`);
          return;
        }
        const base64 = out.includes(',') ? out.slice(out.indexOf(',') + 1) : out;
        setAttachmentUploads((prev) => prev.map((u) => u.id === upload.id ? { ...u, status: 'attaching' } : u));
        q(`q-attach:${upload.id}`, 'attachment-ingest', { name: file.name, dataBase64: base64 });
      };
      reader.onerror = () => {
        setAttachmentUploads((prev) => prev.map((u) => u.id === upload.id ? { ...u, status: 'failed', detail: 'Could not read this file.' } : u));
        setToast(`✗ Could not read ${file.name}`);
      };
      reader.readAsDataURL(file);
    });
    if (batch.length) {
      setToast(batch.length === 1 ? `Attaching ${batch[0].name}…` : `Attaching ${batch.length} files…`);
      ensurePanel('tasks');
    }
  };

  // DESK-5n — the Running list the panels show: live in-turn children (from
  // child-* events) unioned with the disk-backed fleet (detached /bg workers,
  // workflows). Dedup by id, preferring the disk entry (it carries worktree).
  const runningTasks = useMemo<FleetRow[]>(() => {
    const byId = new Map<string, FleetRow>();
    for (const c of Object.values(liveChildren)) {
      byId.set(c.childId, { kind: 'agent', id: c.childId, label: `${c.role}·${c.childId.slice(-4)}${c.tool ? ` — ${c.tool}` : ''}`, role: c.role, startedAt: new Date(c.startedAt).toISOString(), parentSessionKey: viewKey });
    }
    for (const f of fleet) byId.set(f.id, f); // disk entry wins on collision
    return [...byId.values()];
  }, [liveChildren, fleet, viewKey]);
  // Background work is workspace-scoped UI, not chat-list content. Chat rows stay
  // pure conversations; task/workflow transcripts open from the Background panel.
  const backgroundTasks = runningTasks;
  const dashBoards = useMemo<WorkspaceDash[]>(() => {
    if (dashScope === 'all') return globalBoards ?? [];
    const tasks: DashTask[] = [];
    const seen = new Set<string>();
    const add = (task: DashTask): void => {
      if (!task.id) return;
      const key = `${task.kind}:${task.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      tasks.push({ ...task, workspaceRoot: activeRoot });
    };
    for (const f of backgroundTasks) add({ ...f, workspaceRoot: activeRoot, status: f.status ?? 'running' });
    for (const f of recentTasks) add({ ...f, workspaceRoot: activeRoot });
    for (const t of finishedTasks) add({ kind: 'agent', id: t.id, label: t.label, status: /fail|stale|interrupt/i.test(t.status) ? 'failed' : 'completed', workspaceRoot: activeRoot });
    const activeDisk = globalBoards?.find((b) => b.workspaceRoot === activeRoot);
    for (const t of activeDisk?.tasks ?? []) add({ ...t, workspaceRoot: activeRoot });
    return [{ workspaceRoot: activeRoot, tasks, reviewGate }];
  }, [dashScope, globalBoards, backgroundTasks, recentTasks, finishedTasks, activeRoot, reviewGate]);
  const openDashboardTask = useCallback((t: DashTask): void => {
    if (t.workspaceRoot && t.workspaceRoot !== activeRoot) {
      pendingDashboardTaskRef.current = t;
      switchToWorkspace(t.workspaceRoot);
      return;
    }
    openTask(t as FleetRow);
  }, [activeRoot, openTask, switchToWorkspace]);
  useEffect(() => {
    const pending = pendingDashboardTaskRef.current;
    if (!pending || !hostUp) return;
    if (pending.workspaceRoot && pending.workspaceRoot !== activeRoot) return;
    pendingDashboardTaskRef.current = null;
    const row = backgroundTasks.find((t) => t.id === pending.id) ?? (pending as FleetRow);
    openTask(row);
  }, [activeRoot, backgroundTasks, hostUp, openTask]);
  // Fix 4 / §3 — cross-workspace running indicators. globalBoards (durable +
  // live, polled below) gives the active-task count per NON-active workspace;
  // the active workspace prefers its live fleet. Drives the sidebar dot + count
  // so a background task in workspace A stays visible while viewing workspace B.
  const workspaceRunCount = useMemo<Map<string, number>>(
    () => workspaceRunCounts(globalBoards, activeRoot, runningTasks.length),
    [globalBoards, activeRoot, runningTasks],
  );
  const runningWorkspaces = useMemo<Set<string>>(
    () => runningWorkspaceSet(runningWs, workspaceRunCount),
    [runningWs, workspaceRunCount],
  );
  // DESK-6u — if the chat on screen was forked, resolve its parent so we can show
  // a "Forked from conversation" link back to the original.
  const forkParent = useMemo(() => {
    const fk = sessions.find((s) => s.sessionKey === viewKey)?.forkedFrom;
    return fk ? { key: fk, title: sessions.find((s) => s.sessionKey === fk)?.firstUserMessage } : null;
  }, [sessions, viewKey]);
  // Item 9 — sessions that share an opening prompt get their age appended inline
  // so identical-looking rows stay distinguishable.
  const dupeTitleKeys = useMemo(() => duplicateTitleKeys(sessions), [sessions]);

  // DESK-6m — one chat row with its ⋮ menu trigger + pinned/completed state +
  // inline rename. Background tasks are not rendered as chats.
  const renderSessionNode = (s: SessionRow, i: number): React.ReactElement => (
    <React.Fragment key={s.sessionKey}>
      <div className={`session-wrap${s.sessionKey === viewKey ? ' active' : ''}${s.status === 'completed' ? ' completed' : ''}${sessionMenu?.key === s.sessionKey ? ' menu-open' : ''}`}>
        {renamingKey === s.sessionKey ? (
          <input className="session-rename" autoFocus value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); else if (e.key === 'Escape') setRenamingKey(null); }}
            onBlur={commitRename} />
        ) : (
          <button className="project-session" title={s.firstUserMessage || s.sessionKey}
            onClick={() => resumeSession(s.sessionKey)}>
            {s.pinned ? <span className="st st-pin" title="Pinned"><Icon name="pin" size={11} /></span>
              : (s.forkedFrom && !runningSessions.includes(s.sessionKey))
                ? <span className="st st-fork" title="Forked conversation"><Icon name="branch" size={11} /></span>
                : <SessionStatus s={s} working={runningSessions.includes(s.sessionKey)} />}
            <span className="session-title">
              {s.firstUserMessage || s.sessionKey}
              {dupeTitleKeys.has(s.sessionKey) && s.modifiedAt ? <span className="title-age"> · {fmtAge(s.modifiedAt)}</span> : null}
            </span>
            {s.status === 'completed' ? <span className="session-done" title="Completed"><Icon name="check-circle" size={11} /></span> : null}
            {!s.group && i < 9 ? <span className="session-cmd">⌘{i + 1}</span> : null}
            {s.modifiedAt && !dupeTitleKeys.has(s.sessionKey) ? <span className="session-age">{fmtAge(s.modifiedAt)}</span> : null}
          </button>
        )}
        <button className="session-menu-btn icon-btn" aria-label="Chat options" onClick={(e) => openSessionMenu(e, s.sessionKey)}><Icon name="dots" size={13} /></button>
      </div>
    </React.Fragment>
  );

  // DESK-5w (#4 lag) — render ONE transcript row. Extracted + memoized (below)
  // so streaming deltas / the per-second tick don't re-render the whole history
  // (every <Markdown> was re-parsing on every ~18ms delta — the source of lag).
  const renderRow = (r: ChatRow, liveLast: boolean): React.ReactElement => (
    <MessageRow
      key={r.id}
      r={r}
      liveLast={liveLast}
      inlineDiffs={inlineDiffs}
      onRequestDiff={(f) => q('q-inline-diff', 'file-diff', { path: f })}
      onOpenFile={(f) => openFile(f)}
      onOpenDiff={(f) => { setDiffTarget({ path: f, line: 1 }); ensurePanel('diff'); q('q-diff', 'file-diff', { path: f }); }}
      onOpenPlan={() => ensurePanel('plan')}
      onDismissError={(id) => {
        setRows((rs) => rs.filter((x) => x.id !== id));
        for (const k of Object.keys(errorsBySession.current)) errorsBySession.current[k] = errorsBySession.current[k].filter((er) => er.id !== id);
      }}
      onFork={(ts) => forkSessionAction(sessionKeyRef.current ?? '', ts)}
    />
  );
  // Memoized on [rows, inlineDiffs, running] ONLY — NOT liveText/nowTick — so the
  // in-progress stream below re-renders alone, leaving history untouched.
  const transcriptEls = useMemo(
    () => rows.map((r, i) => renderRow(r, running && i === rows.length - 1)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, inlineDiffs, running],
  );

  const statuses = useMemo(() => new Map(changedFiles.map((f) => [f.path, f.status])), [changedFiles]);
  // T4 — composer/header derived state (sessionTitle, hasConversation, homeMode,
  // slash matches, mode/effort/model labels) lives in a pure hook now.
  const { sessionTitle, hasConversation, homeMode, slashActive, slashMatches, execMode, modeLabel, effort, modelChoices } =
    useComposerDerived({ rows, liveText, running, taskView, workflowView, slashDismissed, draft, commands, snapshot, info });
  const setPreference = useCallback((key: string, value: unknown) => {
    if (key === 'executionMode' || key === 'reviewPolicy' || key === 'effort') {
      q('a-mode', 'action:set-session-mode', { [key]: value });
      return;
    }
    q('a-pref', 'action:set-pref', { key, value });
  }, [q]);
  // T4 — sidebar groupings (archived/pinned/grouped split + visible window +
  // other projects) live in a pure hook now.
  const { archivedCount, ungroupedSessions, groupedSessions, visibleProjectSessions, hiddenProjectSessions, projectRoots } =
    useSessionSidebar({ sessions, showArchived, recentsSort, recentsOpen, visibleCount, workspaces, info });

  const reorderProject = useCallback((dragged: string, target: string): void => {
    if (!dragged || !target || dragged === target) return;
    const optimistic = reorderProjectRoots(projectRoots, dragged, target);
    setWorkspaces((prev) => ({ ...prev, recents: optimistic }));
    const persisted = window.brainrouter.reorderWorkspace?.(dragged, target);
    void persisted
      ?.then((result) => setWorkspaces((prev) => ({ ...prev, recents: result.recents })))
      .catch(() => setToast('Could not reorder projects.'));
  }, [projectRoots, setWorkspaces]);

  function runSlash(c: DeskCommand): void {
    setDraft('');
    setSlashSel(0);
    runCommand(c, cmdCtx);
  }

  // DESK-5f — tab CONTENT only; the tab strip owns titles and closing.
  const renderPanelBody = (id: PanelId): React.ReactElement | null => {
    switch (id) {
      case 'context': return (
        <ContextPanel
          hostUp={hostUp} running={running}
          model={info.model} workspaceRoot={info.workspaceRoot} sessionKey={info.sessionKey}
          gitInfo={gitInfo} branch={branches.current}
          tokens={tokens} liveTurn={liveTurn} contextUsage={contextUsage} efficiency={efficiency}
          bgCount={runningTasks.length} configDir="~/.config/brainrouter"
        />);
      case 'files': return <FilesPanel files={allFiles} statuses={statuses} onOpen={openFile} grepHits={grepHits}
        onGrep={(gq) => q('q-grep', 'search-content', { q: gq })}
        onRefresh={() => { q('q-list', 'list-files', { refresh: true }); q('q-files', 'changed-files'); }}
        loading={filesLoading} truncated={filesTruncated} error={filesError} />;
      case 'file': return <FileViewerPanel view={fileView} />;
      case 'editor': return (
        <Suspense fallback={<div className="row status"><span className="spinner" /> Loading editor…</div>}>
          <EditorPanel
            tabs={editor.tabs} activePath={editor.activePath} conflictPaths={editor.conflictPaths} saving={editor.saving}
            onSelect={editor.select} onChange={editor.change} onSave={editor.save} onSaveAll={editor.saveAll}
            onRevert={editor.revert} onClose={closeEditorTab} onReorder={editor.reorder}
            onAnnotateSelection={(path, body, anchor) => {
              q('q-annot-create', 'annotation-create', {
                type: 'file',
                body,
                anchor: { filePath: path, startLine: anchor.startLine, endLine: anchor.endLine, selectedText: anchor.selectedText },
              });
              setTimeout(() => q('q-annot', 'annotation-list'), 150);
              setToast('Selected code saved as an annotation.');
            }} />
        </Suspense>
      );
      case 'ci': return <Suspense fallback={<div className="row status"><span className="spinner" /> Loading…</div>}><CIPanel ci={ci} onOpenExternal={openUrl} /></Suspense>;
      case 'diff': return (
        <DiffPanel gitInfo={gitInfo} changed={changedFiles} diff={diffView}
          scrollToLine={diffView && diffTarget && diffView.path === diffTarget.path ? diffTarget.line : undefined}
          onPick={(p) => { setDiffTarget(null); q('q-diff', 'file-diff', { path: p }); }}
          onBack={() => { setDiffTarget(null); setDiffView(null); }} onOpenFile={openFile}
          onGit={runGit} onGitBypass={(kind, msg) => runGit(kind, msg, { bypass: true })} gitBusy={gitBusy}
          reviewGate={reviewGate} onReview={() => ensurePanel('review')}
          findingsByFile={reviewFindingsByFile} />);
      case 'terminal': return <TerminalPanel />;
      case 'tools': return <ToolsPanel log={toolLog} />;
      case 'tasks': return <TasksPanel fleet={backgroundTasks} recent={recentTasks} finished={finishedTasks} onClear={() => setFinishedTasks([])} onOpen={(id) => { const f = backgroundTasks.find((t) => t.id === id) ?? recentTasks.find((t) => t.id === id); if (f) openTask(f); }} />;
      case 'dashboard': return <Suspense fallback={<div className="row status"><span className="spinner" /> Loading…</div>}><DashboardPanel scope={dashScope} setScope={(s) => { setDashScope(s); if (s === 'all') refreshDashboard(); }}
        tab={dashTab} setTab={setDashTab} boards={dashBoards} busy={dashBusy} onRefresh={refreshDashboard}
        onOpenTask={openDashboardTask}
        onStopTask={(t) => { if (!t.workspaceRoot || t.workspaceRoot === activeRoot) { window.brainrouter.send({ kind: 'interrupt' }); setToast('Interrupt sent to this workspace.'); } else { switchToWorkspace(t.workspaceRoot); setToast('Opening that workspace before stopping its tasks.'); } }} /></Suspense>;
      case 'plan': {
        // §7 — record an approval/changes-requested decision, then re-fetch the
        // history so the new version appears in the panel.
        const refreshHistory = () => setTimeout(() => q('q-plan-history', 'plan-history'), 150);
        return <PlanPanel plan={lastPlan} history={planHistory}
          onApprove={() => { q('q-plan-decision', 'plan-record-decision', { verdict: 'approved' }); refreshHistory(); setToast('Plan approved — snapshot saved to the version history.'); }}
          onRequestChanges={(feedback) => {
            // §1 — launch a REAL background plan-revision task (the host returns
            // it; q-plan-decision surfaces success/error). Stash the feedback so
            // it can be restored to the composer if the task fails to start.
            planFeedbackRef.current = feedback;
            q('q-plan-decision', 'plan-record-decision', { verdict: 'changes-requested', feedback });
            refreshHistory();
            ensurePanel('tasks');
            setToast('Requesting changes — starting a background revision task…');
          }}
          onAnnotateStep={(item, index, body) => {
            q('q-annot-create', 'annotation-create', {
              type: 'plan',
              targetId: `plan-step:${index + 1}`,
              body,
              anchor: { block: `Step ${index + 1}`, selectedText: item.step },
            });
            setTimeout(() => q('q-annot', 'annotation-list'), 150);
            setToast('Plan step saved as an annotation.');
          }} />;
      }
      case 'search': return <SearchPanel hits={searchHits} onSearch={(query) => q('q-search', 'search-transcript', { q: query })} />;
      case 'schedule': return <SchedulePanel schedules={schedules} now={Date.now()}
        onAdd={(kind, expr, command) => { q('q-schedule', 'schedule-add', { kind, expr, command }); setTimeout(() => q('q-schedule', 'schedule-list'), 150); }}
        onRemove={(id) => { q('q-schedule', 'schedule-remove', { id }); setTimeout(() => q('q-schedule', 'schedule-list'), 150); }}
        onToggle={(id, enabled) => { q('q-schedule', 'schedule-toggle', { id, enabled }); setTimeout(() => q('q-schedule', 'schedule-list'), 150); }} />;
      case 'worktrees': return <WorktreesPanel worktrees={worktrees} diffs={worktreeDiffs}
        onCreate={(name, ref) => { q('q-worktree-create', 'worktree-create', { name, ref }); setTimeout(() => q('q-worktrees', 'git-worktrees'), 250); }}
        onRemove={(path) => { q('q-worktree-remove', 'worktree-remove', { path }); setTimeout(() => q('q-worktrees', 'git-worktrees'), 250); }}
        onOpen={(path) => openProject(path)}
        onDiff={(path) => q('q-worktree-diff', 'worktree-diff', { path })} />;
      case 'review': {
        const refresh = () => setTimeout(() => q('q-review-current', 'review-current'), 120);
        const fixPrompt = (f: ReviewFindingView) => `Fix this review finding in \`${f.file}${f.line ? `:${f.line}` : ''}\` (${f.severity}): ${f.summary}`;
        return <ReviewPanel review={review} gate={reviewGate} running={reviewRunning}
          onRun={() => { setReviewRunningByWs((m) => ({ ...m, [activeRoot]: true })); setReviewByWs((m) => setEntry(m, activeRoot, null)); q('q-review-diff', 'review-diff'); }}
          onDiscuss={(f) => setDraft(`About the review finding in \`${f.file}${f.line ? `:${f.line}` : ''}\` (${f.severity}): ${f.summary}\n\nWhat's the fix?`)}
          onApply={(f) => { if (f.id) { q('q-review-apply', 'review-apply-suggestion', { id: f.id }); refresh(); setTimeout(() => { q('q-files', 'changed-files'); q('q-gitinfo', 'git-info'); }, 450); } }}
          onAskFix={(f) => {
            // T3 — launch a scoped fix agent for THIS finding (not just a draft);
            // it edits the file, then the review re-runs. Falls back to a draft if
            // the finding has no id.
            if (f.id) { setReviewRunningByWs((m) => ({ ...m, [activeRoot]: true })); setToast('Fixing this finding — the agent is editing the file…'); q('q-review-fix', 'review-fix-finding', { id: f.id }); }
            else { setDraft(fixPrompt(f)); setToast('Fix request drafted — press Enter to ask the agent.'); }
          }}
          onDismiss={(f) => { if (f.id) { q('q-review-dismiss', 'review-dismiss-finding', { id: f.id }); refresh(); } }}
          onResolve={(f) => { if (f.id) { q('q-review-resolve', 'review-resolve-finding', { id: f.id }); refresh(); } }}
          onTriage={(f, status) => { if (f.id) { q('q-review-triage', 'review-set-finding-status', { id: f.id, status }); refresh(); } }}
          onAnnotate={(f) => {
            // §9 — capture a review finding as a durable annotation: a review-finding
            // record referencing the finding by id, anchored to its file/lines, with
            // the finding's severity. Refreshes the annotation slice afterwards.
            const sev = (['info', 'low', 'medium', 'high'] as const).includes(f.severity as never) ? f.severity : undefined;
            q('q-annot-create', 'annotation-create', {
              type: 'review-finding', targetId: f.id, body: f.summary, severity: sev,
              anchor: { filePath: f.file, startLine: f.line, endLine: f.endLine },
            });
            setTimeout(() => q('q-annot', 'annotation-list'), 150);
            setToast('Finding saved as an annotation — see the Annotations view.');
          }}
          onOpenFile={(f) => openFile(f.file)}
          onOpenDiff={(f) => { setDiffTarget({ path: f.file, line: f.line }); ensurePanel('diff'); q('q-diff', 'file-diff', { path: f.file }); }} />;
      }
      case 'requirements': {
        const refresh = () => setTimeout(() => q('q-req', 'requirement-list'), 150);
        return <RequirementsPanel requirements={requirements}
          onCreate={(title) => { q('q-req-create', 'requirement-create', { title }); refresh(); }}
          onSetStatus={(id, status) => { q('q-req-update', 'requirement-update', { id, status }); refresh(); }}
          onSetPriority={(id, priority) => { q('q-req-update', 'requirement-update', { id, priority }); refresh(); }}
          onAddCriterion={(id, text) => { q('q-req-update', 'requirement-update', { id, criterion: text }); refresh(); }}
          onSeedPlan={(id) => { q('q-req-seed', 'requirement-seed-plan', { id }); refresh(); setToast('Seeded this session\'s plan from the requirement — it shows in Plan on the next turn.'); }} />;
      }
      case 'annotations': {
        // ANNOTATION-RECORDS — status set re-fetches the list; export round-trips
        // the markdown back through q-annot-export, which drops it into the
        // composer draft (the "export feedback to the session" path).
        const refresh = () => setTimeout(() => q('q-annot', 'annotation-list'), 150);
        return <AnnotationsPanel annotations={annotations}
          onSetStatus={(id, status) => { q('q-annot-status', 'annotation-set-status', { id, status }); refresh(); }}
          onExport={(filter) => { q('q-annot-export', 'annotation-export', filter); }}
          onAddComment={(id, body) => { q('q-annot-comment', 'annotation-add-comment', { id, body }); refresh(); }}
          onSelectTarget={(a) => { if (a.anchor?.filePath) { setDiffTarget({ path: a.anchor.filePath, line: a.anchor.startLine }); ensurePanel('diff'); q('q-diff', 'file-diff', { path: a.anchor.filePath }); } }} />;
      }
      case 'artifacts': {
        // ARTIFACT-RECORDS — create/status-set re-fetch the list; Preview resolves
        // the artifact's content via q-art-read (file via the safe workspace read,
        // or inline), which merges the content back onto the matching record.
        const refresh = () => setTimeout(() => q('q-art', 'artifact-list'), 150);
        // §8 — annotations targeting an artifact use the artifact's format as the
        // annotation kind (markdown/html), else the generic 'artifact' target.
        const annTypeFor = (fmt: string): 'markdown' | 'html' | 'artifact' => fmt === 'markdown' ? 'markdown' : fmt === 'html' ? 'html' : 'artifact';
        return <ArtifactsPanel artifacts={artifacts} annotations={annotations}
          onCreate={(title) => { q('q-art-create', 'artifact-create', { kind: 'markdown-report', title }); refresh(); }}
          onSetStatus={(id, status) => { q('q-art-update', 'artifact-update', { id, status }); refresh(); }}
          onPreview={(a) => { q('q-art-read', 'artifact-read', { id: a.id }); }}
          onSave={(id, content) => { q('q-art-save', 'artifact-save', { id, content }); refresh(); setTimeout(() => q('q-art-read', 'artifact-read', { id }), 250); setToast('Artifact saved.'); }}
          onRevert={(id, version) => { q('q-art-revert', 'artifact-revert', { id, version }); refresh(); setTimeout(() => q('q-art-read', 'artifact-read', { id }), 250); setToast(`Reverted to v${version}.`); }}
          onSendToChat={(text) => { setDraft(text); setToast('Artifact sent to the composer — press Enter to continue.'); }}
          onAnnotate={(a, body) => { q('q-annot-create', 'annotation-create', { type: annTypeFor(a.format), targetId: a.id, artifactId: a.id, body }); setTimeout(() => q('q-annot', 'annotation-list'), 150); setToast('Annotation saved to this artifact.'); }} />;
      }
      default: return null;
    }
  };
  const tabTitle = (id: PanelId): string =>
    id === 'file' && fileView?.path ? fileView.path.split('/').pop()! : PANEL_DEFS.find((d) => d.id === id)?.title ?? id;

  // DESK-5f/5h — animated presence for every show/hide surface.
  // Env column may ONLY appear when the chat keeps its full natural content
  // width (760px content + padding ≈ 820): opening Environment must never
  // visibly shrink the conversation. No room → column AND toggle yield.
  const envRoom = !sideFullScreen && (workW === 0 || workW - (sidePanelOpen ? sideWidth : 0) - 316 >= 820);
  const envVisible = envOpen && !homeMode && envRoom;
  const railAnim = useClosable(railOpen);
  const sideAnim = useClosable(sidePanelOpen);
  const dockAnim = useClosable(termDockOpen);
  const envAnim = useClosable(envVisible, 150);

  return (
    <div className="app">
      <Sidebar railAnim={railAnim} railWidth={railWidth} setRailOpen={setRailOpen} setRailWidth={setRailWidth}
        setPaletteOpen={setPaletteOpen} ensurePanel={ensurePanel} setSidePanelOpen={setSidePanelOpen}
        recentsSort={recentsSort} setRecentsSort={setRecentsSort} workspaces={workspaces} info={info}
        projectRoots={projectRoots} activeReviewBadge={activeReviewBadge} prInfo={prInfo}
        recentsOpen={recentsOpen} setRecentsOpen={setRecentsOpen} visibleProjectSessions={visibleProjectSessions}
        renderSessionNode={renderSessionNode} hiddenProjectSessions={hiddenProjectSessions} ungroupedSessions={ungroupedSessions}
        setVisibleCount={setVisibleCount} groupedSessions={groupedSessions} archivedCount={archivedCount}
        setShowArchived={setShowArchived} showArchived={showArchived}
        expandedProjects={expandedProjects} projSessions={projSessions} runningWs={runningWorkspaces} workspaceRunCount={workspaceRunCount}
        openProject={openProject} toggleProject={toggleProject} reorderProject={reorderProject} addProject={addProject}
        mode={mode} setMode={setMode} />

      <div className="main">
        {mode === 'track' ? (
          <TrackView project={track.project} items={track.items} sprints={track.sprints} automations={track.automations} members={track.members} sync={track.sync} ops={trackOps} />
        ) : (<>
        <div className="workrow" ref={workrowRef}>
          <ChatThread
            homeMode={homeMode} railOpen={railOpen} setRailOpen={setRailOpen} gitInfo={gitInfo} info={info}
            sessionTitle={sessionTitle} taskView={taskView} setTaskView={setTaskView} chatRef={chatRef}
            atBottomRef={atBottomRef} setAtBottom={setAtBottom} workflowView={workflowView} setWorkflowView={setWorkflowView}
            renderRow={renderRow} homeStats={homeStats} statsTab={statsTab} setStatsTab={setStatsTab}
            statsRange={statsRange} setStatsRange={setStatsRange} snapshot={snapshot} sessions={sessions}
            resumeSession={resumeSession} forkParent={forkParent} transcriptEls={transcriptEls} liveText={liveText}
            running={running} turnStart={turnStart} reasoningTail={reasoningTail} statusLine={statusLine}
            interaction={interaction} answerInteraction={answerInteraction} q={q} chatEnd={chatEnd} atBottom={atBottom}
            hasConversation={hasConversation} changedFiles={changedFiles} ensurePanel={ensurePanel}
            composer={
              <>
              {mode === 'chat' ? (
                <div className="chat-readonly" title="Chat keeps the agent read-only — it can read, search and explain, but won't edit files or run commands. Switch to Code to make changes.">
                  <Icon name="eye" size={12} /> Read-only — Chat explores &amp; explains; switch to <button className="chat-readonly-link" onClick={() => setMode('code')}>Code</button> to make changes
                </div>
              ) : null}
              <Composer
                draft={draft} setDraft={setDraft} running={running} stopping={stopping} submit={submit} requestStop={requestStop}
                slashActive={slashActive} slashMatches={slashMatches} commands={commands} slashSel={slashSel} setSlashSel={setSlashSel}
                setSlashDismissed={setSlashDismissed} onRunSlash={runSlash} pop={pop} setPop={setPop} q={q}
                modeLabel={modeLabel} execMode={execMode} effort={effort} info={info} branches={branches}
                endpointModels={endpointModels} modelsLoading={modelsLoading} setModelsLoading={setModelsLoading}
                modelChoices={modelChoices} modelScope={modelScope} setModelScope={setModelScope}
                hasConversation={hasConversation} contextUsage={contextUsage} tokens={tokens} openSettings={openSettings}
                onAttach={attachFiles}
                attachments={attachmentUploads}
                canSubmit={readyAttachments(attachmentUploads).length > 0}
                onClearAttachment={(id) => setAttachmentUploads((prev) => prev.filter((u) => u.id !== id))} />
              </>
            } />

          {/* Chat mode is a FOCUSED conversation — the code workbench (Environment
              column, side panels, terminal) appears only in Code mode. */}
          {mode === 'code' ? (<>
          {/* DESK-5h — Environment as a LAYOUT COLUMN: the chat reflows next
              to it; it can never cover content. Yields via envRoom. */}
          <EnvironmentPanel envAnim={envAnim} openSettings={openSettings} gitInfo={gitInfo} ensurePanel={ensurePanel}
            setTermDockOpen={setTermDockOpen} branches={branches} pop={pop} setPop={setPop} q={q} commitSubjects={commitSubjects} ci={ci}
            openCiPanel={openCiPanel} lastTurnFails={lastTurnFails} backgroundTasks={backgroundTasks} openTask={openTask} />

          <ViewsRail sideAnim={sideAnim} sideWidth={sideWidth} setSideWidth={setSideWidth} sideFullScreen={sideFullScreen}
            setSidePanelOpen={setSidePanelOpen}
            activeSideTab={activeSideTab} sideTabs={sideTabs} setActiveSideTab={setActiveSideTab} closeSideTab={closeSideTab} reorderSideTab={reorderSideTab}
            tabTitle={tabTitle}
            renderPanelBody={renderPanelBody} openSideView={openSideView} lastPlan={lastPlan} changedFiles={changedFiles}
            backgroundTasks={backgroundTasks} fleet={fleet} toolLog={toolLog} schedules={schedules}
            worktrees={worktrees} review={review} requirements={requirements} annotations={annotations} artifacts={artifacts} ci={ci}
            envRoom={envRoom} />
          </>) : null}
        </div>

        {mode === 'code' ? (
        <TerminalDock dockAnim={dockAnim} termDockHeight={termDockHeight} resizeTerminal={resizeTerminal}
          termTabs={termTabs} activeTerm={activeTerm} setActiveTerm={setActiveTerm} closeBottomTab={closeBottomTab}
          pop={pop} setPop={setPop} addBottomTab={addBottomTab} setTermDockOpen={setTermDockOpen}
          tabTitle={tabTitle} gitInfo={gitInfo} renderPanelBody={renderPanelBody} />
        ) : null}
        </>)}

        {/* DESK-5h — window control cluster, pinned top-right of the content
            area (absolute — visual position is unaffected by DOM order).
            MUST be the LAST child of .main: Electron builds drag regions in
            DOM order, so this cluster's no-drag rect has to subtract AFTER
            the chat-head's drag rect is added. Placed earlier, the drag
            region re-covers the buttons and swallows every click — the
            browser preview ignores app-region, which is why it only broke
            in the real Electron shell. */}
        <TopbarRight homeMode={homeMode} envRoom={envRoom} envOpen={envOpen} setEnvOpen={setEnvOpen} q={q}
          termDockOpen={termDockOpen} setTermDockOpen={setTermDockOpen} sidePanelOpen={sidePanelOpen}
          setSidePanelOpen={setSidePanelOpen} sideFullScreen={sideFullScreen} setSideFullScreen={setSideFullScreen}
          sideTabs={sideTabs} activeSideTab={activeSideTab} ensurePanel={ensurePanel} openBottomDock={openBottomDock}
          pop={pop} setPop={setPop} openSettings={openSettings} />
      </div>

      {pop && pop !== 'export' ? <div className="picker-backdrop" onClick={() => setPop('')} /> : null}

      <CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)}
        onRun={(c) => runCommand(c, cmdCtx)} />

      <SettingsDialog
        open={settings.open}
        section={settings.section}
        setSection={(s) => setSettings({ open: true, section: s })}
        onClose={() => setSettings((st) => ({ ...st, open: false }))}
        snapshot={snapshot}
        usageLines={usageLines}
        tokens={tokens}
        commands={commands}
        catalog={catalog}
        onPref={setPreference}
        endpointModels={endpointModels}
        providerModels={providerModels}
        onModelSave={(model) => window.brainrouter.send({ kind: 'set-model', model, persist: true })}
        onAction={(id, name, args) => {
          if (name === 'new-session') { window.brainrouter.send({ kind: 'new-session' }); setSettings((st) => ({ ...st, open: false })); return; }
          q(id, name, args);
        }}
        onRunCommand={(c) => { setSettings((st) => ({ ...st, open: false })); runCommand(c, cmdCtx); }}
        codeFont={codeFont}
        onCodeFont={setCodeFont}
        theme={theme}
        onTheme={setTheme}
        chatWidth={chatWidth}
        onChatWidth={setChatWidth}
        chatSize={chatSize}
        onChatSize={setChatSize}
        accent={accent}
        onAccent={setAccent}
      />

      <InteractionDialogs interaction={interaction} picked={picked} setPicked={setPicked} answerInteraction={answerInteraction}
        trustAsk={trustAsk} setTrustAsk={setTrustAsk} switchToWorkspace={switchToWorkspace} />

      <ExportAndMenuDialogs pop={pop} setPop={setPop} q={q} sessionMenu={sessionMenu} sessions={sessions}
        closeSessionMenu={closeSessionMenu} openExternal={openExternal} togglePin={togglePin} toggleComplete={toggleComplete}
        startRename={startRename} forkSessionAction={forkSessionAction} moveToGroup={moveToGroup} sessionGroups={sessionGroups}
        toggleArchive={toggleArchive} deleteSessionAction={deleteSessionAction} />
      <InfoAndGateDialogs infoDialog={infoDialog} setInfoDialog={setInfoDialog} gateBlock={gateBlock} setGateBlock={setGateBlock}
        activeRoot={activeRoot} ensurePanel={ensurePanel} setReviewRunningByWs={setReviewRunningByWs} setReviewByWs={setReviewByWs}
        q={q} pendingGitRef={pendingGitRef} runGit={runGit} setToast={setToast} setGitBusy={setGitBusy} toast={toast} />
    </div>
  );
}
