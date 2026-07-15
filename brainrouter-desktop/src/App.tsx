/**
 * DESK-4c — the app shell: left rail · chat thread · resizable panel columns.
 * Panels open as full-height window columns right of the chat (drag the left
 * edge to resize). Every CLI slash command surfaces here: ⌘K palette, the
 * composer "/" popup, and the categorized Settings modal.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { InteractionRequest } from '@kinqs/brainrouter-agent-protocol';
// UI-TEST fusion — the generated screen map + user-journey stories the Atlas
// Screens mode + Browser panel render, and that runStory replays.
import type { UiMap, Story } from '@kinqs/brainrouter-core/uitest';
import { PANEL_DEFS, type PanelId, type SearchHit } from './panels/index.js';
import type { RequirementRecord, AnnotationRecord, ArtifactRecord, AtlasGraph, TrackProject, WorkItem, Sprint, Module, SavedView, AutomationRule, ProjectMember } from '@kinqs/brainrouter-types';
import type { GitTrackContext, SyncConfig, SyncResult, TrackPrStatus } from './track/TrackView.js';
import type { ScheduleRecordView } from './lib/schedule/scheduleView.js';
import { SESSION_BASE } from './lib/session/list/sessionPagination.js';
import { usePanels } from './lib/panels/usePanels.js';
import { environmentPanelLayout } from './lib/panels/sideRailLayout.js';
import { buildCommandList, runCommand, type CmdCtx, type CommandsCatalog, type DeskCommand, type SettingsSection } from './lib/commands/commands.js';
import { tagQueryId } from './lib/workspace/workspaceEvents.js';
import { duplicateTitleKeys } from './lib/session/list/sessionDisplay.js';
import { type ConfigSnapshot, type UsageHistory } from './settings.js';
import type { MarketplaceState } from './settings/marketplace/index.js';
import { installDevBridge } from './devBridge.js';
import type { AttachmentUpload, PlanItem, ChatRow, FleetRow, PopId, ComponentTag } from './types.js';
import type { PlanDecisionView } from './lib/plan/planReviewView.js';
import { useClosable } from './lib/useClosable.js';
import { useAgentEvents, type ToolCatalog } from './lib/agent/useAgentEvents.js';
import { useEditor } from './lib/editor/useEditor.js';
import { useCi } from './lib/ci/useCi.js';
import { type DashTab, type WorkspaceDash } from './lib/workspace/dashboard.js';
import { useComposerDerived } from './lib/composer/useComposerDerived.js';
import { readyAttachments } from './lib/attachments/attachmentPrompt.js';
import { useSessionSidebar } from './lib/session/hooks/useSessionSidebar.js';
import { reorderProjectRoots } from './lib/session/workspaces/projectSessionsView.js';
import { useGitState } from './lib/git/useGitState.js';
import { useSessionState } from './lib/session/hooks/useSessionState.js';
import { withExpanded } from './lib/session/workspaces/expandedProjectsStore.js';
import { sessionRowsCacheKey } from './lib/session/list/sessionCache.js';
import { useSessionActions } from './lib/session/hooks/useSessionActions.js';
import { Sidebar } from './components/layout/Sidebar.js';
import type { GoalRecord } from './components/chat/GoalBanner.js';
import { useZoom, useAppHandlers, useAppEffects, useDashboardTasks } from './App/hooks/index.js';
import { buildTrackOps } from './App/track/index.js';
import { buildRenderPanelBody, buildRenderSessionNode, buildRenderRow } from './App/render/index.js';
import { AppDialogs, MainContent } from './App/layout/index.js';

installDevBridge();

export function App(): React.ReactElement {
  const [draft, setDraft] = useState('');
  // T4 — session/workspace STATE container. Every symbol is destructured back so
  // existing references (render JSX, useAgentEvents ctx, action hooks) are unchanged.
  const {
    viewKey, setViewKey, running, setRunning, stopping, setStopping,
    runningSessions, setRunningSessions, runningSessionsRef,
    sessions, setSessions, sessionsRef, pendingSessionsRef,
    liveChildren, setLiveChildren, renamingKey, setRenamingKey, renamingRoot, setRenamingRoot, renameDraft, setRenameDraft,
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
  const [lastRouterFallback, setLastRouterFallback] = useState<string | null>(null);
  const [reasoningTail, setReasoningTail] = useState('');
  const [liveText, setLiveText] = useState('');
  const [fleet, setFleet] = useState<FleetRow[]>([]);
  // §3 — recently-finished DURABLE tasks (completed/failed) for THIS workspace,
  // so the Background panel shows verification/review/revision outcomes, not just
  // what's running. Sourced from the durable `tasks-list` query (status: all).
  const [recentTasks, setRecentTasks] = useState<FleetRow[]>([]);
  const [info, setInfo] = useState<{
    sessionKey?: string;
    model?: string;
    provider?: string;
    workspaceRoot?: string;
    username?: string;
    accountSignedIn?: boolean;
    accountEmail?: string;
  }>(() => {
    const status = window.brainrouter.getBootstrapState?.()?.accountStatus;
    const account = status?.account;
    return {
      username: account?.displayName || account?.email || undefined,
      accountSignedIn: status?.signedIn === true,
      accountEmail: account?.email || undefined,
    };
  });
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
  const [mode, setMode] = useState<'chat' | 'track' | 'code' | 'meetings'>('code');
  // Track mode data (the per-workspace project + its work items), fed by the
  // host `track-*` queries. Mutations re-fetch the item list.
  const [track, setTrack] = useState<{ project: TrackProject | null; items: WorkItem[]; sprints: Sprint[]; modules: Module[]; views: SavedView[]; automations: AutomationRule[]; members: ProjectMember[]; sync: { config: SyncConfig | null; result: SyncResult | null }; git: GitTrackContext | null; pr: TrackPrStatus | null }>({ project: null, items: [], sprints: [], modules: [], views: [], automations: [], members: [], sync: { config: null, result: null }, git: null, pr: null });
  const [lastPlan, setLastPlan] = useState<{ items: PlanItem[]; explanation?: string } | null>(null);
  const [goalState, setGoalState] = useState<GoalRecord | null>(null);
  const [planHistory, setPlanHistory] = useState<PlanDecisionView[]>([]);
  const [searchHits, setSearchHits] = useState<SearchHit[] | null>(null);

  // Command surfaces + settings
  const [catalog, setCatalog] = useState<CommandsCatalog | null>(null);
  const [snapshot, setSnapshot] = useState<ConfigSnapshot | null>(null);
  const [usageLines, setUsageLines] = useState<string[]>([]);
  const [usageHistory, setUsageHistory] = useState<UsageHistory | null>(null); // WS10 — cross-session heatmap
  // PLUGIN-MARKETPLACE P4-desktop — the Marketplace panel's data slice (installed
  // plugins + registry search hits + the pending consent disclosure).
  const [market, setMarket] = useState<MarketplaceState>({ installed: null, hits: null, searching: false, error: '', consent: null });
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

  const { zoomFactor, zoomIn, zoomOut, resetZoom } = useZoom();
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
  // Tool enable/disable catalog for Settings → Tools (built-in + connected MCP).
  const [toolCatalog, setToolCatalog] = useState<ToolCatalog>({ builtin: [], mcp: [] });
  // §endpoint-driven-models — per-named-provider /models lists for the sub-agent
  // model pickers (keyed by provider name; fetched via list-models { provider }).
  const [providerModels, setProviderModels] = useState<Record<string, string[]>>({});
  const [modelsLoading, setModelsLoading] = useState(false);
  // §multi-select-models — probe state for the Models setup dialog: the live
  // GET /models a freshly-typed provider key unlocks. Kept in its OWN state
  // (never endpointModels) so a draft-key probe can't race the active-endpoint
  // model load. probeError: '' = none, 'no-models' = the key/endpoint returned 0.
  const [probedModels, setProbedModels] = useState<string[]>([]);
  const [probeLoading, setProbeLoading] = useState(false);
  const [probeError, setProbeError] = useState<string>('');
  // §multi-select-models — the default provider's saved allowlist (if any)
  // narrows the composer model picker. Empty ⇒ the picker shows the full
  // endpoint list, so providers without an allowlist behave exactly as before.
  const defaultProviderModels = useMemo<string[]>(() => {
    const dp = snapshot?.defaultProviderName;
    const p = dp ? snapshot?.providers?.find((x) => x.name === dp) : undefined;
    return p?.models ?? [];
  }, [snapshot]);
  // Item 10 — where a model pick is saved: 'global' = config.json (shared with
  // the CLI, every chat), 'session' = this chat only (sessionRuntimeStore).
  // Default to per-session so picking a model in one chat never syncs to the
  // others; the explicit "All chats" toggle sets the global default.
  const [modelScope, setModelScope] = useState<'global' | 'session'>('session');
  // T14 — scheduled tasks for the viewed session (cron/once), from the CLI store.
  const [schedules, setSchedules] = useState<ScheduleRecordView[]>([]);
  // REQUIREMENT-RECORDS — this workspace's Requirement Records, from the CLI store.
  const [requirements, setRequirements] = useState<RequirementRecord[]>([]);
  const [atlasGraph, setAtlasGraph] = useState<AtlasGraph | null>(null); // ATLAS-5 — codebase knowledge graph
  const [atlasBuilding, setAtlasBuilding] = useState(false);
  const [atlasEnriching, setAtlasEnriching] = useState(false); // ATLAS-4b — LLM enrichment in flight
  const [atlasAssessing, setAtlasAssessing] = useState<string | null>(null); // ATLAS-14 — path being assessed
  const [atlasAssessments, setAtlasAssessments] = useState<Record<string, import('./lib/atlas/atlasView.js').AtlasChangeAssessment>>({});
  const [atlasUiMap, setAtlasUiMap] = useState<UiMap | null>(null); // UI-TEST fusion — generated screen map for the Atlas Screens mode
  const [atlasStories, setAtlasStories] = useState<Story[]>([]); // UI Stories — named user journeys for the Atlas Screens mode
  // §a11y-inspect — component reference tags dragged from the Browser panel's
  // Accessibility list (and story chips); serialized into the prompt on send.
  const [componentTags, setComponentTags] = useState<ComponentTag[]>([]);
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
  // §vision — pasted screenshots staged for the next send. Unlike file
  // attachments (which the host text-extracts), these go to the model inline as
  // image blocks via start-turn `images`. Cleared on send.
  const [pastedImages, setPastedImages] = useState<Array<{ id: string; mediaType: string; dataBase64: string }>>([]);
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

  const trackOps = buildTrackOps(q);

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
    sideTabs, activeSideTab, sidePanelOpen, sideWidth, sideFullScreen, sidePinned, termDockOpen, termDockHeight, termTabs, activeTerm,
    setSideTabs, setActiveSideTab, setSidePanelOpen, setSideWidth, setSideFullScreen, setSidePinned, setTermDockOpen, setTermDockHeight, setTermTabs, setActiveTerm,
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

  // T6 — GitHub CI/CD (real `gh` status, kept separate from local tool success).
  const ci = useCi({ workspaceRoot: workspaces.current ?? info.workspaceRoot, onToast: setToast });

  // T1 — workflow/background dashboard. Workspace scope uses the live fleet +
  // finished tasks; All scope disk-reads every recent workspace via main.
  const [dashScope, setDashScope] = useState<'workspace' | 'all'>('workspace');
  const [dashTab, setDashTab] = useState<DashTab>('running');
  const [globalBoards, setGlobalBoards] = useState<WorkspaceDash[] | null>(null);
  const [dashBusy, setDashBusy] = useState(false);

  // T4 — session/workspace/panel ACTION functions (no command-catalog deps) live
  // in useSessionActions. Every symbol is destructured back so existing references
  // (render JSX, useAgentEvents ctx, effects) keep compiling unchanged. Called here
  // — after q / git state / panels / editor / ci / dashboard state are available —
  // so useAgentEvents below can reference refreshSession/refreshSidebar as consts.
  const {
    refreshSession, refreshSidebar, refreshGit, resumeSession, resumeSessionRef, resumeTimerRef,
    openTask, openWorkflow, viewToTop, answerInteraction, requestStop,
    switchToWorkspace, openProject, openWorktree, addProject, toggleProject,
    openSettings, openFile, closeEditorTab, openUrl, openCiPanel, refreshDashboard,
    closeSessionMenu, setMeta, togglePin, toggleComplete, toggleArchive, moveToGroup,
    startRename, commitRename, forkSessionAction, deleteSessionAction, openExternal, openSessionMenu,
  } = useSessionActions({
    q, running, stopping, interaction, renamingKey, renamingRoot, renameDraft, workspaces, info, projSessions, recentsOpenByRoot,
    runningSessionsRef, sessionKeyRef, activeWsRef, pendingWorkspaceRef, pendingResumeRef, pendingSessionsRef, sessionsRef,
    workspaceGenRef, expandedProjectsRef,
    liveBuf, chatRef, atBottomRef, errorsBySession, cachedSessionRowsRef,
    setStopping, setStatusLine, setReasoningTail, setLiveText, setRows, setRunning, setInteraction,
    setSessions, setSearchHits, setViewKey, setTaskView, setWorkflowView, setWorkspaces, setExpandedProjects, setTrustAsk,
    setHostUp, setGitInfo, setPrInfo, setBranches, setChangedFiles, setAllFiles, setFileView, setDiffView,
    setTokens, setContextUsage, setGateBlock, setLastPlan, setPlanHistory, setFleet, setLiveChildren, setRecentTasks, setFinishedTasks, setCommitSubjects, setToast,
    setProjSessions, setSettings, setSessionMenu, setRenamingKey, setRenamingRoot, setRenameDraft, setDashBusy, setGlobalBoards,
    pendingGitRef, ensurePanel, resetTermDock, editor, ci,
  });


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

  // T-effects — the shell's standalone side effects (host polling, event
  // listeners, localStorage persistence, document bindings) live in one hook now.
  // Its effects keep their original order + deps, so behavior is unchanged.
  useAppEffects({
    q, settingsOpen: settings.open, mode, info, hostUp, refreshGit, editorAnyDirty: editor.anyDirty, running,
    lastPlan, activeSideTab, setGlobalBoards, setWorkspaces, setProjSessions, taskView, workflowView,
    cardOpenRef, setTaskView, setWorkflowView, viewKey, chatWidth, chatSize, toast, setToast, envOpen,
    railWidth, railOpen, expandedProjects, workrowRef, setWorkW, setPaletteOpen, togglePanel, setSideFullScreen,
    setSidePanelOpen, setTermDockOpen, openSettings, sessionsRef, resumeSessionRef, zoomIn, zoomOut, resetZoom,
    sidePanelOpen, sidePinned, codeFont, theme, accent,
  });

  // DESK-5j — no auto-close at a px breakpoint: ⌘+/- zoom shrinks the CSS
  // viewport, and the rail vanishing mid-zoom read as the UI breaking apart.
  // Panels are user-controlled; columns shrink in place instead.

  useAgentEvents({
    setRows, setRunning, setStopping, setTurnStart, setStatusLine, setLastRouterFallback, setReasoningTail, setLiveText, setToolLog,
    setLiveChildren, setFinishedTasks, setLastPlan, setGoalState, setPlanHistory, setTokens, setLiveTurn, setEfficiency, setTrack, setInteraction, setPicked, setViewKey,
    setTaskView, setWorkflowView, setInfo, setWorkspaces, setRunningWs, setHostUp, setLastTurnFails,
    setDraft, setProjSessions, setSessions, setPrInfo, setContextUsage, setFleet, setRecentTasks, setChangedFiles,
    setDiffView, setInlineDiffs, setAllFiles, setFileView, setGitInfo, setCommitSubjects, setHomeStats,
    setBranches, setModelsLoading, setEndpointModels, setToolCatalog, setProviderModels, setProbedModels, setProbeLoading, setProbeError, setCatalog, setSnapshot, setUsageLines, setUsageHistory,
    setMarket,
    setSearchHits, setSchedules, setRequirements, setAnnotations, setArtifacts, setAtlasGraph, setAtlasBuilding, setAtlasEnriching, setAtlasAssessing, setAtlasAssessments, setAtlasUiMap, setAtlasStories, setWorktrees, setWorktreeDiffs, setReviewRunningByWs, setReviewByWs,
    setReviewGateByWs, setGateBlock, setGrepHits, setSessionGroups, setGitBusy, setInfoDialog, setToast,
    setFilesLoading, setFilesTruncated, setFilesError, setAttachmentUploads,
    setAtBottom,
    liveBuf, liveFlushPending, activeWsRef, sessionKeyRef, turnFailsRef, runningSessionsRef,
    pendingWorkspaceRef, pendingResumeRef, errorsBySession, lastPromptRef, planFeedbackRef, goalContPendingRef, workspaceGenRef, pendingSessionsRef, sessionsRef,
    atBottomRef, cardOpenRef, chatEnd, chatRef, pendingGitRef, pendingCmdRef, cachedSessionRowsRef,
    q, refreshSession, refreshSidebar, runGit, setSessionRunning, info, gitInfo, homeStats, branches,
  });

  // T-handlers — composer + attachment handlers (submit, AI PR review, file
  // attachments, pasted-image staging, header rename) live in a hook now. Every
  // symbol is destructured back so existing references (render JSX) are unchanged.
  const { submit, reviewPrWithAi, attachFiles, addPastedImages, renameCurrentSession } = useAppHandlers({
    q, draft, setDraft, attachmentUploads, setAttachmentUploads, pastedImages, setPastedImages,
    running, stopping, setToast, commands, cmdCtx, runBridge, sessionKeyRef, setRows, lastPromptRef,
    goalContPendingRef, setRunning, setSessionRunning, info, setTurnStart, turnFailsRef, branches,
    pendingSessionsRef, setSessions, sessionsRef, setProjSessions, activeWsRef, workspaces, refreshSession,
    ensurePanel, viewKey, componentTags, setComponentTags,
  });

  // T-dashtasks — the background/dashboard task derivations (Running list, boards,
  // cross-workspace indicators, open-task action) live in a hook now. Bodies + deps
  // are unchanged; every symbol is destructured back for the render + Sidebar.
  const { runningTasks, backgroundTasks, dashBoards, openDashboardTask, workspaceRunCount, runningWorkspaces } = useDashboardTasks({
    liveChildren, fleet, viewKey, dashScope, globalBoards, recentTasks, finishedTasks, activeRoot,
    reviewGate, runningWs, hostUp, openTask, switchToWorkspace,
  });
  // DESK-6u — if the chat on screen was forked, resolve its parent so we can show
  // a "Forked from conversation" link back to the original.
  const forkParent = useMemo(() => {
    const fk = sessions.find((s) => s.sessionKey === viewKey)?.forkedFrom;
    return fk ? { key: fk, title: sessions.find((s) => s.sessionKey === fk)?.firstUserMessage } : null;
  }, [sessions, viewKey]);
  // Item 9 — sessions that share an opening prompt get their age appended inline
  // so identical-looking rows stay distinguishable.
  const dupeTitleKeys = useMemo(() => duplicateTitleKeys(sessions), [sessions]);

  // DESK-6m — one sidebar chat node (status icon, inline rename, ⋮ menu) via a
  // build closure; the composed render + Sidebar consume it unchanged.
  const renderSessionNode = buildRenderSessionNode({
    runningSessions, ci, viewKey, sessionMenu, openSessionMenu, renamingKey, renameDraft, setRenameDraft,
    commitRename, setRenamingKey, resumeSession, dupeTitleKeys,
  });

  // DESK-5w (#4 lag) — render ONE transcript row via a build closure; memoized
  // below so streaming deltas don't re-render the whole history.
  const renderRow = buildRenderRow({
    q, inlineDiffs, openFile, setDiffTarget, ensurePanel, setRows, errorsBySession, forkSessionAction, sessionKeyRef,
  });
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

  // DESK-5f — tab CONTENT only; the tab strip owns titles and closing. The
  // switch body lives in buildRenderPanelBody now (every value it closes over is
  // passed on the ctx), so both the side rail and the terminal dock share it.
  // Run a UI Story: enrich its steps with resolver hints (label/type/route) from
  // the current map, hand them to the Browser panel, and ask the host to ensure
  // the app is served (probe → start the dev server → wait). The ensure-app result
  // carries the resolved URL back to the Browser panel, which replays it live.
  const enrichStorySteps = (story: Story, uiMap: UiMap | null): Array<Record<string, unknown>> => {
    const elByTestId = new Map<string, { label?: string; type?: string }>();
    const routeById = new Map<string, string | null>();
    for (const s of uiMap?.screens ?? []) {
      routeById.set(s.id, s.route ?? null);
      for (const e of s.elements) if (!elByTestId.has(e.testID)) elByTestId.set(e.testID, { label: e.label, type: e.type });
    }
    return story.steps.map((st) => {
      if (st.action === 'navigate') return { action: 'navigate', target: st.target, route: routeById.get(st.target) ?? null };
      const el = elByTestId.get(st.target);
      const base: Record<string, unknown> = { action: st.action, target: st.target, label: el?.label, type: el?.type };
      if (st.action === 'type') base.text = st.text;
      return base;
    });
  };
  const runStory = (story: Story): void => {
    const url = (localStorage.getItem('br-browser-url') || '').trim();
    try { localStorage.setItem('br-browser-runstory', JSON.stringify({ id: story.id, title: story.title, steps: enrichStorySteps(story, atlasUiMap) })); } catch { /* ignore */ }
    ensurePanel('uitest');
    setToast(`Preparing "${story.title}"…`);
    window.dispatchEvent(new CustomEvent('br-browser-log', { detail: { message: `▶ Preparing "${story.title}" — ensuring the app is served…` } }));
    q('q-uitest-ensure', 'uitest:ensure-app', url ? { url } : {});
  };

  // The Browser panel takes no props, so its "save this screenshot" and "story run
  // finished" handoffs arrive as window events carrying the payload; forward each
  // to the host, which writes files under .brainrouter/ui-tests/ (a report run also
  // registers a markdown Artifact). Results toast via useAgentEvents.
  useEffect(() => {
    const onSaveShot = (e: Event): void => {
      const d = (e as CustomEvent<{ dataUrl?: string; name?: string }>).detail;
      if (d?.dataUrl) q('q-uitest-shot', 'uitest:save-screenshot', { dataUrl: d.dataUrl, name: d.name });
    };
    const onRunResult = (e: Event): void => {
      const d = (e as CustomEvent<Record<string, unknown>>).detail;
      if (d) q('q-uitest-report', 'uitest:run-report', d);
    };
    // A11y-row -> source: the Browser panel asks App to open a file at a line.
    const onOpenFile = (e: Event): void => {
      const d = (e as CustomEvent<{ path?: string; line?: number }>).detail;
      if (d?.path) openFile(d.path, typeof d.line === 'number' ? d.line : undefined);
    };
    // The Browser panel wants the UI map but has none yet -> load the manifest;
    // its result lands in atlasUiMap and is mirrored back via localStorage.
    const onLoadUiMap = (): void => { q('q-uitest-manifest', 'uitest:manifest'); };
    window.addEventListener('br-browser-savescreenshot', onSaveShot);
    window.addEventListener('br-browser-runresult', onRunResult);
    window.addEventListener('br-browser-openfile', onOpenFile);
    window.addEventListener('br-browser-loaduimap', onLoadUiMap);
    return () => {
      window.removeEventListener('br-browser-savescreenshot', onSaveShot);
      window.removeEventListener('br-browser-runresult', onRunResult);
      window.removeEventListener('br-browser-openfile', onOpenFile);
      window.removeEventListener('br-browser-loaduimap', onLoadUiMap);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mirror the generated UI map to localStorage so the (propless) Browser panel
  // can resolve Accessibility rows to their source files, and notify an open panel.
  useEffect(() => {
    try {
      if (atlasUiMap) localStorage.setItem('br-browser-uimap', JSON.stringify(atlasUiMap));
      else localStorage.removeItem('br-browser-uimap');
    } catch { /* ignore quota / serialization errors */ }
    window.dispatchEvent(new CustomEvent('br-browser-uimap'));
  }, [atlasUiMap]);

  const renderPanelBody = buildRenderPanelBody({
    q, hostUp, running, info, gitInfo, branches, tokens, liveTurn, contextUsage, efficiency, runningTasks,
    allFiles, statuses, openFile, grepHits, filesLoading, filesTruncated, filesError, fileView, editor,
    closeEditorTab, openUrl, setToast, ci, reviewPrWithAi, track, trackOps, changedFiles, diffView, diffTarget,
    setDiffTarget, ensurePanel, setDiffView, runGit, gitBusy, reviewGate, reviewFindingsByFile, toolLog,
    backgroundTasks, recentTasks, finishedTasks, setFinishedTasks, openTask, submit, taskView, setTaskView, renderRow,
    requestStop, closeSideTab, dashScope, setDashScope,
    refreshDashboard, dashTab, setDashTab, dashBoards, dashBusy, openDashboardTask, switchToWorkspace, activeRoot,
    lastPlan, planHistory, planFeedbackRef, searchHits, schedules, worktrees, worktreeDiffs, openWorktree,
    review, reviewRunning, setReviewRunningByWs, setReviewByWs, setDraft, atlasGraph, atlasBuilding, atlasEnriching,
    atlasAssessments, atlasAssessing, setAtlasBuilding, setAtlasEnriching, setAtlasAssessing, requirements,
    annotations, artifacts,
    atlasUiMap, atlasStories, runStory,
  });
  const tabTitle = (id: PanelId): string =>
    id === 'file' && fileView?.path ? fileView.path.split('/').pop()!
      : id === 'task-detail' && taskView ? (taskView.title || taskView.role || 'Task')
      : PANEL_DEFS.find((d) => d.id === id)?.title ?? id;

  // DESK-5f/5h — animated presence for every show/hide surface.
  // Env column may ONLY appear when the chat keeps its full natural content
  // width (760px content + padding ≈ 820): opening Environment must never
  // visibly shrink the conversation. No room → column AND toggle yield.
  const envRoom = !sideFullScreen && (workW === 0 || workW - (sidePanelOpen ? sideWidth : 0) - 316 >= 820 / zoomFactor);
  const envLayout = environmentPanelLayout(envOpen, homeMode, envRoom);
  const railAnim = useClosable(railOpen);
  const sideAnim = useClosable(sidePanelOpen);
  const dockAnim = useClosable(termDockOpen);
  const envAnim = useClosable(envLayout.mounted, 150);

  return (
    <div className="app">
      <Sidebar railAnim={railAnim} railWidth={railWidth} setRailOpen={setRailOpen} setRailWidth={setRailWidth}
        setPaletteOpen={setPaletteOpen} ensurePanel={ensurePanel} setSidePanelOpen={setSidePanelOpen}
        recentsSort={recentsSort} setRecentsSort={setRecentsSort} workspaces={workspaces} info={info}
        projectRoots={projectRoots} activeReviewBadge={activeReviewBadge} prInfo={prInfo}
        recentsOpen={recentsOpen} setRecentsOpen={setRecentsOpen} visibleProjectSessions={visibleProjectSessions}
        renderSessionNode={renderSessionNode} openSessionMenu={openSessionMenu} hiddenProjectSessions={hiddenProjectSessions} ungroupedSessions={ungroupedSessions}
        renamingKey={renamingKey} renameDraft={renameDraft} setRenameDraft={setRenameDraft} setRenamingKey={setRenamingKey} commitRename={commitRename}
        setVisibleCount={setVisibleCount} groupedSessions={groupedSessions} archivedCount={archivedCount}
        setShowArchived={setShowArchived} showArchived={showArchived}
        expandedProjects={expandedProjects} projSessions={projSessions} runningWs={runningWorkspaces} runningSessions={runningSessions} workspaceRunCount={workspaceRunCount}
        openProject={openProject} toggleProject={toggleProject} reorderProject={reorderProject} addProject={addProject}
        mode={mode} setMode={setMode} openAccountSettings={() => openSettings('account')} />

      <MainContent
        mode={mode} setMode={setMode} workrowRef={workrowRef} track={track} trackOps={trackOps}
        railOpen={railOpen} setRailOpen={setRailOpen} sidePanelOpen={sidePanelOpen} sidePinned={sidePinned}
        sideFullScreen={sideFullScreen} setSidePanelOpen={setSidePanelOpen} setSidePinned={setSidePinned}
        sideAnim={sideAnim} sideWidth={sideWidth} setSideWidth={setSideWidth} activeSideTab={activeSideTab}
        sideTabs={sideTabs} setActiveSideTab={setActiveSideTab} closeSideTab={closeSideTab} reorderSideTab={reorderSideTab}
        tabTitle={tabTitle} renderPanelBody={renderPanelBody} openSideView={openSideView} lastPlan={lastPlan}
        changedFiles={changedFiles} backgroundTasks={backgroundTasks} fleet={fleet} toolLog={toolLog} schedules={schedules}
        worktrees={worktrees} review={review} requirements={requirements} annotations={annotations} artifacts={artifacts}
        ci={ci} envRoom={envRoom} envDrawer={envLayout.drawer} homeMode={homeMode} gitInfo={gitInfo} info={info} sessionTitle={sessionTitle}
        taskView={taskView} setTaskView={setTaskView} chatRef={chatRef} atBottomRef={atBottomRef} setAtBottom={setAtBottom}
        workflowView={workflowView} setWorkflowView={setWorkflowView} renderRow={renderRow} homeStats={homeStats}
        statsTab={statsTab} setStatsTab={setStatsTab} statsRange={statsRange} setStatsRange={setStatsRange}
        snapshot={snapshot} sessions={sessions} viewKey={viewKey} renameCurrentSession={renameCurrentSession}
        resumeSession={resumeSession} forkParent={forkParent} transcriptEls={transcriptEls} liveText={liveText}
        goalState={goalState} runBridge={runBridge} q={q} running={running} turnStart={turnStart}
        reasoningTail={reasoningTail} statusLine={statusLine} interaction={interaction} answerInteraction={answerInteraction}
        chatEnd={chatEnd} atBottom={atBottom} hasConversation={hasConversation} ensurePanel={ensurePanel}
        draft={draft} setDraft={setDraft} stopping={stopping} submit={submit} requestStop={requestStop}
        slashActive={slashActive} slashMatches={slashMatches} commands={commands} slashSel={slashSel} setSlashSel={setSlashSel}
        setSlashDismissed={setSlashDismissed} runSlash={runSlash} pop={pop} setPop={setPop} modeLabel={modeLabel}
        effort={effort} branches={branches} endpointModels={endpointModels} defaultProviderModels={defaultProviderModels}
        routerCatalog={snapshot?.routerCatalog} routerFallback={lastRouterFallback}
        modelsLoading={modelsLoading} setModelsLoading={setModelsLoading} modelChoices={modelChoices} modelScope={modelScope}
        setModelScope={setModelScope} contextUsage={contextUsage} tokens={tokens} openSettings={openSettings}
        attachFiles={attachFiles} attachmentUploads={attachmentUploads} canSubmit={readyAttachments(attachmentUploads).length > 0}
        setAttachmentUploads={setAttachmentUploads} pastedImages={pastedImages} addPastedImages={addPastedImages}
        setPastedImages={setPastedImages}
        componentTags={componentTags}
        onDropTag={(tag) => setComponentTags((prev) => prev.some((t) => t.ref === tag.ref) ? prev : [...prev, { ...tag, id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` }])}
        onClearComponentTag={(id) => setComponentTags((prev) => prev.filter((t) => t.id !== id))}
        envAnim={envAnim} setTermDockOpen={setTermDockOpen} commitSubjects={commitSubjects}
        openCiPanel={openCiPanel} lastTurnFails={lastTurnFails} openTask={openTask} dockAnim={dockAnim}
        termDockHeight={termDockHeight} resizeTerminal={resizeTerminal} termTabs={termTabs} activeTerm={activeTerm}
        setActiveTerm={setActiveTerm} closeBottomTab={closeBottomTab} addBottomTab={addBottomTab} envOpen={envOpen}
        setEnvOpen={setEnvOpen} termDockOpen={termDockOpen} setSideFullScreen={setSideFullScreen} openBottomDock={openBottomDock} />

      <AppDialogs
        pop={pop} setPop={setPop} q={q} cmdCtx={cmdCtx} commands={commands}
        paletteOpen={paletteOpen} setPaletteOpen={setPaletteOpen}
        settings={settings} setSettings={setSettings} snapshot={snapshot} usageLines={usageLines}
        usageHistory={usageHistory} tokens={tokens} catalog={catalog} setPreference={setPreference}
        endpointModels={endpointModels} providerModels={providerModels} probedModels={probedModels}
        probeLoading={probeLoading} probeError={probeError} setProbeLoading={setProbeLoading}
        setProbeError={setProbeError} setProbedModels={setProbedModels} toolCatalog={toolCatalog}
        market={market}
        execMode={execMode} codeFont={codeFont} setCodeFont={setCodeFont} theme={theme} setTheme={setTheme}
        chatWidth={chatWidth} setChatWidth={setChatWidth} chatSize={chatSize} setChatSize={setChatSize}
        accent={accent} setAccent={setAccent}
        interaction={interaction} picked={picked} setPicked={setPicked} answerInteraction={answerInteraction}
        trustAsk={trustAsk} setTrustAsk={setTrustAsk} switchToWorkspace={switchToWorkspace}
        sessionMenu={sessionMenu} sessions={sessions} closeSessionMenu={closeSessionMenu} openExternal={openExternal}
        togglePin={togglePin} toggleComplete={toggleComplete} startRename={startRename} forkSessionAction={forkSessionAction}
        moveToGroup={moveToGroup} sessionGroups={sessionGroups} toggleArchive={toggleArchive} deleteSessionAction={deleteSessionAction}
        infoDialog={infoDialog} setInfoDialog={setInfoDialog} gateBlock={gateBlock} setGateBlock={setGateBlock}
        activeRoot={activeRoot} ensurePanel={ensurePanel} setReviewRunningByWs={setReviewRunningByWs} setReviewByWs={setReviewByWs}
        pendingGitRef={pendingGitRef} runGit={runGit} setToast={setToast} setGitBusy={setGitBusy} toast={toast} />
    </div>
  );
}
