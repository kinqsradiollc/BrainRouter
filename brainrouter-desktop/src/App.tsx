/**
 * DESK-4c — the app shell: left rail · chat thread · resizable panel columns.
 * Panels open as full-height window columns right of the chat (drag the left
 * edge to resize). Every CLI slash command surfaces here: ⌘K palette, the
 * composer "/" popup, and the categorized Settings modal.
 */
import React, { useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react';
import remarkGfm from 'remark-gfm';
import type { AgentEvent, AgentEventMessage, InteractionRequest } from '@kinqs/brainrouter-agent-protocol';
import {
  DiffPanel, FilesPanel, FileViewerPanel, PlanPanel, SearchPanel, SchedulePanel, WorktreesPanel, ReviewPanel,
  TasksPanel, TerminalPanel, ToolsPanel, PANEL_DEFS, type PanelId, type SearchHit, type ReviewFindingView,
} from './panels/index.js';
import type { ScheduleRecordView } from './lib/schedule/scheduleView.js';
import { parseWorktreeList, type WorktreeEntry } from './lib/worktree/worktreeParser.js';
import { toggleVisible, moreLabel, showToggle, SESSION_BASE } from './lib/session/sessionPagination.js';
import { mergeOptimistic, dropPending } from './lib/session/sessionOrder.js';
import { gitActionTag } from './lib/review/reviewGateUi.js';
import { activeEntry, setEntry, shouldProceedGate, reviewBadgeFor } from './lib/review/reviewWorkspace.js';
import { usePanels } from './lib/panels/usePanels.js';
import { buildCommandList, runCommand, resolveSlashInput, type CmdCtx, type CommandsCatalog, type DeskCommand, type SettingsSection } from './lib/commands/commands.js';
import { isStaleWorkspaceEvent, nextActiveWorkspace, workspaceChanged, tagQueryId, parseQueryId, isStaleQueryResult, nextRunningWorkspaces } from './lib/workspace/workspaceEvents.js';
import { duplicateTitleKeys } from './lib/session/sessionDisplay.js';
import { CommandPalette } from './palette.js';
import { SettingsDialog, type ConfigSnapshot } from './settings.js';
import { installDevBridge } from './devBridge.js';
import { Icon } from './icons.js';
import type { PlanItem, ToolItem, ChatRow, SessionRow, FleetRow, WorkflowDetail } from './types.js';
import { fileFromSummary, fmtAge, fmt, download } from './lib/format.js';
import { VIEW_MENU, FOREGROUND_ONLY_KINDS } from './constants.js';
import { useClosable } from './lib/useClosable.js';
import { rid } from './lib/rid.js';
import { useEditor } from './lib/editor/useEditor.js';
import { useCi } from './lib/ci/useCi.js';
import { CIPanel } from './panels/CIPanel.js';
import { DashboardPanel } from './panels/DashboardPanel.js';
import { type DashTab, type DashTask, type WorkspaceDash } from './lib/workspace/dashboard.js';
// Monaco is ~5MB — lazy-load the editor panel so it only loads when first opened.
const EditorPanel = lazy(() => import('./panels/EditorPanel.js').then((m) => ({ default: m.EditorPanel })));
import { Markdown, MD_COMPONENTS } from './chat/markdown.js';
import { MessageRow } from './chat/MessageRow.js';
import { WorkflowCard } from './chat/WorkflowCard.js';
import { SessionStatus } from './components/SessionStatus.js';
import { WorkElapsed } from './components/WorkElapsed.js';
import { HomeView } from './components/HomeView.js';
import { Composer } from './components/Composer.js';
import { useComposerDerived } from './lib/composer/useComposerDerived.js';
import { useSessionSidebar } from './lib/session/useSessionSidebar.js';
import { TopbarRight } from './components/TopbarRight.js';
import { EnvironmentPanel } from './components/EnvironmentPanel.js';
import { TerminalDock } from './components/TerminalDock.js';
import { InfoAndGateDialogs } from './components/InfoAndGateDialogs.js';
import { InteractionDialogs } from './components/InteractionDialogs.js';
import { ExportAndMenuDialogs } from './components/ExportAndMenuDialogs.js';

installDevBridge();

export function App(): React.ReactElement {
  const [rows, setRows] = useState<ChatRow[]>([]);
  const [draft, setDraft] = useState('');
  // `running` = the VIEWED session has a turn in flight (drives the composer).
  const [running, setRunning] = useState(false);
  // DESK-6 — Stop was pressed and we're waiting for the turn to actually unwind.
  // Gives immediate visual feedback (the old code only fired IPC and showed a
  // volatile status line that the next 'Thinking…' overwrote). Cleared when the
  // turn really ends (turn-complete/turn-error) or on a session switch.
  const [stopping, setStopping] = useState(false);
  // DESK-5v — CONCURRENT SESSIONS: every session key with a turn in flight, so
  // switching away never stops a turn and the sidebar shows a spinner on each
  // chat that's still working. `running` above is just "is the viewed one in
  // this set". Ref mirror so the persistent onEvent listener reads live state.
  const runningSessionsRef = useRef<Set<string>>(new Set());
  const [runningSessions, setRunningSessions] = useState<string[]>([]);
  // DESK-5w — the viewed session key as REACTIVE state (sessionKeyRef is the
  // ref mirror). Drives session-scoped background-task views.
  const [viewKey, setViewKey] = useState<string>('');
  const setSessionRunning = (key: string, on: boolean): void => {
    const s = runningSessionsRef.current;
    if (on) s.add(key); else s.delete(key);
    setRunningSessions([...s]);
  };
  // Stability item 4 — which WORKSPACES (projects) currently have a turn in
  // flight, including ones not on screen. The host pool keeps that work alive
  // in the background; this lets the sidebar show a "running" dot on other
  // projects so the user knows it didn't vanish when they switched away.
  const [runningWs, setRunningWs] = useState<Set<string>>(() => new Set());
  const [statusLine, setStatusLine] = useState('');
  const [reasoningTail, setReasoningTail] = useState('');
  const [liveText, setLiveText] = useState('');
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [fleet, setFleet] = useState<FleetRow[]>([]);
  // DESK-5n — in-turn child agents (workers/sub-agents) live ONLY in the
  // streamed child-* events, never in the disk-backed fleet the host polls,
  // so the Background-tasks panel was blind to them mid-turn. Track them live
  // here keyed by childId; upsert on child-tool-start/end, drop on complete.
  const [liveChildren, setLiveChildren] = useState<Record<string, { childId: string; role: string; tool?: string; startedAt: number }>>({});
  const [info, setInfo] = useState<{ sessionKey?: string; model?: string; workspaceRoot?: string; username?: string }>({});
  const [hostUp, setHostUp] = useState(false);
  const [interaction, setInteraction] = useState<InteractionRequest | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [workspaces, setWorkspaces] = useState<{ current: string | null; recents: string[] }>({ current: null, recents: [] });
  const [railOpen, setRailOpen] = useState(true);
  // DESK-5i — the left sidebar is drag-resizable too (persisted).
  const [railWidth, setRailWidth] = useState(() => {
    const v = Number(localStorage.getItem('br-rail-w'));
    return v >= 220 && v <= 420 ? v : 268;
  });

  // DESK-5f — ONE tabbed side panel (Codex model): views are tabs you switch
  // between, never extra window columns. Empty tab list = the view chooser.
  // DESK-5h — measured room: the Environment COLUMN (it reserves layout space,
  // never overlays the chat) and its toggle yield when the chat would squeeze.
  const workrowRef = useRef<HTMLDivElement>(null);
  const [workW, setWorkW] = useState(0);
  const [toolLog, setToolLog] = useState<Array<{ id: number; tool: string; ok: boolean; summary: string }>>([]);
  const [changedFiles, setChangedFiles] = useState<Array<{ status: string; path: string }>>([]);
  const [diffView, setDiffView] = useState<{ path: string; diff: string } | null>(null);
  // T3 — when "Open diff" is clicked on a review finding, remember its line so the
  // diff view scrolls/flashes to that hunk once the file-diff loads.
  const [diffTarget, setDiffTarget] = useState<{ path: string; line?: number } | null>(null);
  const [allFiles, setAllFiles] = useState<string[]>([]);
  const [fileView, setFileView] = useState<{ path: string; content: string; error?: string } | null>(null);
  const [gitInfo, setGitInfo] = useState<{ repo: string; branch: string | null; insertions: number; deletions: number; gitRoot?: string | null; repoRelativePath?: string; isSubdir?: boolean } | null>(null);
  const [commitSubjects, setCommitSubjects] = useState<string[]>([]);
  const [tokens, setTokens] = useState<{ promptTokens: number; completionTokens: number; turns: number } | null>(null);
  const [lastPlan, setLastPlan] = useState<{ items: PlanItem[]; explanation?: string } | null>(null);
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
  // DESK-6m — per-chat ⋮ context menu + its sub-flows.
  const [sessionMenu, setSessionMenu] = useState<{ key: string; x: number; y: number } | null>(null);
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [sessionGroups, setSessionGroups] = useState<string[]>([]);
  const [homeStats, setHomeStats] = useState<{
    sessions: number; turns: number; activeDays: number; currentStreak: number;
    longestStreak: number; model: string; perDay: Record<string, number>;
  } | null>(null);
  const [statsTab, setStatsTab] = useState<'overview' | 'models'>('overview');
  const [statsRange, setStatsRange] = useState<'all' | '30d' | '7d'>('all');
  // DESK-4m — popovers (one open at a time) across composer, top bar, and menus.
  const [pop, setPop] = useState<'' | 'mode' | 'model' | 'effort' | 'ctx' | 'export' | 'branch' | 'plus' | 'splus' | 'bplus' | 'repo' | 'local' | 'commit' | 'title' | 'editor'>('');
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
  const sessionsRef = useRef<SessionRow[]>([]);
  // Wave 2 — optimistic new-chat rows not yet confirmed by the host's
  // list-sessions. Kept across refreshes (merged) so a fresh chat's row never
  // flickers out while the transcript flush races the refresh.
  const pendingSessionsRef = useRef<SessionRow[]>([]);
  const lastPromptRef = useRef('');
  // T2/T3 — the workspace the on-screen surfaces belong to, set authoritatively
  // by session-changed. Events tagged with a DIFFERENT workspace are dropped so
  // one project's stream can never paint into another's surfaces.
  const activeWsRef = useRef<string | null>(null);
  // Stability fix — workspace GENERATION: bumped on every workspace switch so
  // late async query results from the previous project are dropped, never
  // painting workspace A's data into workspace B's surfaces.
  const workspaceGenRef = useRef(0);
  // DESK-5u — current viewed session key, kept in a ref so the (mount-once)
  // event handler can read it without going stale.
  const sessionKeyRef = useRef<string | undefined>(undefined);
  // DESK-5u — error cards aren't part of the persisted transcript, so cache
  // them per session here and re-inject on resume — a turn failure stays
  // visible when you switch away and come back.
  const errorsBySession = useRef<Record<string, Array<{ id: number; text: string; detail?: string; ts: number }>>>({});
  const chatEnd = useRef<HTMLDivElement>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  // DESK-6w — true while a read-only card view (task convo / workflow) is open,
  // so the transcript auto-scroll never yanks the card down on a refresh.
  const cardOpenRef = useRef(false);
  const [atBottom, setAtBottom] = useState(true);
  const [turnStart, setTurnStart] = useState(0);
  // DESK-5e — the Environment "Checks" row is real signal: failed tool calls
  // in the last completed turn (null until a turn has finished here).
  const [lastTurnFails, setLastTurnFails] = useState<number | null>(null);
  const turnFailsRef = useRef(0);
  // DESK-5j — Changes tab review actions (commit/push/pull via the host's
  // user-command shell path — same trust level as the terminal input row).
  const [gitBusy, setGitBusy] = useState(false);
  // Wave 4 — review gate: a pending commit/push waiting on the gate check, and
  // the block dialog shown when the gate refuses (with an explicit bypass).
  const pendingGitRef = useRef<{ kind: 'commit' | 'push'; msg?: string; root: string } | null>(null);
  const [gateBlock, setGateBlock] = useState<{ kind: 'commit' | 'push'; msg?: string; reason: string; status: string } | null>(null);
  const [finishedTasks, setFinishedTasks] = useState<Array<{ id: string; label: string; status: string }>>([]);
  // DESK-5w — the background task whose conversation is open (read-only),
  // shown in place of the chat. null = normal chat view.
  const [taskView, setTaskView] = useState<{ id: string; kind: string; role?: string; goal?: string; status?: string; parentSessionKey?: string | null; rows: ChatRow[] } | null>(null);
  // DESK-6w — a workflow run's breakdown (Claude /workflows-style card), shown
  // in place of the chat when you click a workflow background task.
  const [workflowView, setWorkflowView] = useState<WorkflowDetail | null>(null);
  const [grepHits, setGrepHits] = useState<import('./panels/index.js').GrepHit[] | null>(null);
  const [inlineDiffs, setInlineDiffs] = useState<Record<string, string>>({});
  const [branches, setBranches] = useState<{ current: string | null; branches: string[]; loading?: boolean }>({ current: null, branches: [] });
  const [endpointModels, setEndpointModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  // Item 10 — where a model pick is saved: 'global' = config.json (shared with
  // the CLI, every chat), 'session' = this chat only (sessionRuntimeStore).
  const [modelScope, setModelScope] = useState<'global' | 'session'>('global');
  // T14 — scheduled tasks for the viewed session (cron/once), from the CLI store.
  const [schedules, setSchedules] = useState<ScheduleRecordView[]>([]);
  // T13 — git worktrees for this repo + a per-worktree diff cache.
  const [worktrees, setWorktrees] = useState<WorktreeEntry[]>([]);
  const [worktreeDiffs, setWorktreeDiffs] = useState<Record<string, string>>({});
  // T12 / Review v2 + T2 multi-workspace — findings + the commit/push gate +
  // running flag, ALL keyed by workspace root so switching projects shows that
  // project's review (never leaks across workspaces). The active workspace's
  // view is derived below; the q-review-* handlers write under activeWsRef.current.
  type ReviewView = { findings: ReviewFindingView[]; summary: string; files: number };
  type GateView = { status: string; blocked: boolean; reason: string };
  const [reviewByWs, setReviewByWs] = useState<Record<string, ReviewView | null>>({});
  const [reviewGateByWs, setReviewGateByWs] = useState<Record<string, GateView | null>>({});
  const [reviewRunningByWs, setReviewRunningByWs] = useState<Record<string, boolean>>({});
  const activeRoot = workspaces.current ?? info.workspaceRoot ?? '';
  const review = activeEntry(reviewByWs, activeRoot);
  const reviewGate = activeEntry(reviewGateByWs, activeRoot);
  const reviewRunning = !!reviewRunningByWs[activeRoot];
  // T2 — the active project's sidebar review badge (needs/reviewing/blocked/passed/stale).
  const activeReviewBadge = reviewBadgeFor(reviewGate, changedFiles.length, reviewRunning);
  // §4 — per-file count of OPEN findings, for the Changes-list badges.
  const reviewFindingsByFile = useMemo<Record<string, number>>(() => {
    const m: Record<string, number> = {};
    for (const f of review?.findings ?? []) if (!f.status || f.status === 'open') m[f.file] = (m[f.file] ?? 0) + 1;
    return m;
  }, [review]);
  const [chatWidth, setChatWidth] = useState(() => localStorage.getItem('br-chat-w') ?? 'medium');
  const [chatSize, setChatSize] = useState(() => localStorage.getItem('br-chat-fs') ?? 'medium');
  // DESK-5d — the trust gate runs BEFORE a project opens (and before a chat
  // in another project resumes); `resume` carries the chat to land on.
  const [trustAsk, setTrustAsk] = useState<{ root: string; resume?: string } | null>(null);
  const [accent, setAccent] = useState(() => localStorage.getItem('br-accent') ?? '');
  // DESK-5d — per-project chat histories + expansion (lazy-fetched), the
  // current branch's PR chip, and the chat to resume after a host swap.
  const [projSessions, setProjSessions] = useState<Record<string, SessionRow[]>>({});
  const [expandedProjects, setExpandedProjects] = useState<string[]>([]);
  const expandedProjectsRef = useRef<string[]>([]);
  const [prInfo, setPrInfo] = useState<{ number: number; state: string; title?: string } | null>(null);
  const pendingResumeRef = useRef<string | null>(null);
  // DESK-6t — debounce rapid session clicks: only the LAST target resumes.
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stable handle so the mount-once keyboard handler always calls the latest one.
  const resumeSessionRef = useRef<(key: string) => void>(() => {});
  const [recentsOpen, setRecentsOpen] = useState(true);
  // Item 9 — how many of the current project's chats are shown (grows a page at
  // a time via the show-more button). Collapsed view always shows the base few.
  const [visibleCount, setVisibleCount] = useState(SESSION_BASE);
  const commands = useMemo(() => buildCommandList(catalog), [catalog]);

  const q = (id: string, name: string, args?: Record<string, unknown>) =>
    window.brainrouter.send({ kind: 'query', id: tagQueryId(id, workspaceGenRef.current), name, args });

  // T4 — panel/dock state + handlers live in usePanels (q injected so ensurePanel
  // can refresh worktrees/review on open).
  const {
    sideTabs, activeSideTab, sidePanelOpen, sideWidth, termDockOpen, termDockHeight, termTabs, activeTerm,
    setSideTabs, setActiveSideTab, setSidePanelOpen, setSideWidth, setTermDockOpen, setTermDockHeight, setTermTabs, setActiveTerm,
    ensurePanel, closeSideTab, togglePanel, openSideView, openBottomDock, addBottomTab, closeBottomTab, resizeTerminal, resetTermDock,
  } = usePanels(q);

  // T5 — in-app code editor. Self-contained (own host round-trips); on a save it
  // refreshes git status + changed files and re-checks the review gate (the
  // working tree just changed). Reads/writes go through the host, never the fs.
  const editor = useEditor({
    onSaved: () => { q('q-git', 'git-info'); q('q-files', 'changed-files'); q('q-review-gate', 'review-gate'); },
    onToast: setToast,
  });
  // T5 — warn before a reload/close drops unsaved editor changes.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => { if (editor.anyDirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [editor.anyDirty]);

  // T6 — GitHub CI/CD (real `gh` status, kept separate from local tool success).
  const ci = useCi({ onToast: setToast });
  const openUrl = (url: string): void => { if (url) q('q-open-url', 'action:open-external', { url }); };
  const openCiPanel = (): void => { ensurePanel('ci'); ci.refresh(); };

  // T1 — workflow/background dashboard. Workspace scope uses the live fleet +
  // finished tasks; All scope disk-reads every recent workspace via main.
  const [dashScope, setDashScope] = useState<'workspace' | 'all'>('workspace');
  const [dashTab, setDashTab] = useState<DashTab>('running');
  const [globalBoards, setGlobalBoards] = useState<WorkspaceDash[] | null>(null);
  const [dashBusy, setDashBusy] = useState(false);
  const refreshDashboard = (): void => {
    if (!window.brainrouter.globalDashboard) return;
    setDashBusy(true);
    window.brainrouter.globalDashboard()
      .then((r) => setGlobalBoards((r.workspaces ?? []) as unknown as WorkspaceDash[]))
      .catch(() => { /* gh/disk unreadable */ })
      .finally(() => setDashBusy(false));
  };
  const openDashboard = (): void => { ensurePanel('dashboard'); refreshDashboard(); };
  const dashBoards = useMemo<WorkspaceDash[]>(() => {
    if (dashScope === 'all') return globalBoards ?? [];
    const tasks: DashTask[] = [
      ...fleet.map((f) => ({ kind: f.kind, id: f.id, label: f.label, startedAt: f.startedAt, role: f.role, worktree: f.worktree, parentSessionKey: f.parentSessionKey, workspaceRoot: activeRoot, status: 'running' })),
      ...finishedTasks.map((t) => ({ kind: 'agent', id: t.id, label: t.label, status: /fail/i.test(t.status) ? 'failed' : 'completed', workspaceRoot: activeRoot })),
    ];
    return [{ workspaceRoot: activeRoot, tasks, reviewGate }];
  }, [dashScope, globalBoards, fleet, finishedTasks, activeRoot, reviewGate]);

  // T5 — opening a file now lands in the editable Monaco editor (not the
  // read-only viewer). The 'file' panel + read-only viewer remain available.
  function openFile(path: string): void {
    ensurePanel('editor');
    editor.open(path);
  }
  /** Close an editor tab, confirming first if it has unsaved changes. */
  function closeEditorTab(path: string): void {
    const tab = editor.tabs.find((t) => t.path === path);
    if (tab && tab.content !== tab.saved && !tab.readOnly && !tab.binary) {
      if (!window.confirm(`Discard unsaved changes to ${path.split('/').pop()}?`)) return;
    }
    editor.close(path);
  }
  function openSettings(section: SettingsSection): void {
    setSettings({ open: true, section });
    q('q-snapshot', 'config-snapshot');
    q('q-usage', 'usage-breakdown');
  }

  // ---- DESK-5d — single-window project switching --------------------------
  /** Swap the host to another workspace in THIS window; optionally land on a chat. */
  function switchToWorkspace(root: string, resumeKey?: string): void {
    const current = workspaces.current ?? info.workspaceRoot;
    if (root === current) {
      if (resumeKey) window.brainrouter.send({ kind: 'resume-session', sessionKey: resumeKey });
      return;
    }
    pendingResumeRef.current = resumeKey ?? null;
    // Stability fix — bump the workspace generation the moment a switch STARTS,
    // so any old-workspace query results still in flight are dropped instead of
    // repainting the now-cleared surfaces with the previous project's data.
    workspaceGenRef.current++;
    setToast(`Opening ${root.split('/').pop()}…`);
    // Clear workspace-scoped surfaces; the new host's boot session-changed
    // refreshes everything against the new root.
    setHostUp(false);
    setRows([]);
    setGitInfo(null);
    setPrInfo(null);
    // Stability fix — show a LOADING branch chip during the switch instead of
    // letting the selector silently vanish; the new host's full refresh fills it.
    setBranches({ current: null, branches: [], loading: true });
    setChangedFiles([]);
    setAllFiles([]);
    setFileView(null);
    setDiffView(null);
    setTokens(null);
    // T2 — review MAPS are keyed by workspace, so they survive the switch and the
    // derived active view flips for free. But the pending-git + gate dialog are
    // single-shot and must NOT carry into the new project.
    pendingGitRef.current = null;
    setGateBlock(null);
    setLastPlan(null);
    setFleet([]);
    setLiveChildren({});
    setCommitSubjects([]);
    // Terminal tabs belong to the retiring host's shells — close the dock so
    // reopening spawns fresh shells in the new workspace.
    resetTermDock();
    void window.brainrouter.openWorkspace(root).then((r) => {
      if (!r.opened) { setToast('✗ Could not open that folder.'); pendingResumeRef.current = null; }
    }).catch(() => { setToast('✗ Could not open that folder.'); pendingResumeRef.current = null; });
  }

  /** Trust gate in front of every project switch (Codex-style: ask first).
   *  T1 — trust now comes from the shared CLI store via main, not localStorage. */
  function openProject(root: string, resumeKey?: string): void {
    void window.brainrouter.isWorkspaceTrusted(root).then(({ trusted }) => {
      if (trusted) switchToWorkspace(root, resumeKey);
      else setTrustAsk({ root, resume: resumeKey });
    });
  }

  /** DESK-5j / Wave 4 — Changes-tab git actions. commit/push are GATED by the
   *  local AI review: the gate is checked first; if it blocks, a dialog explains
   *  why and offers an explicit bypass. pull is never gated. */
  function runGit(kind: 'commit' | 'push' | 'pull', msg?: string, opts?: { bypass?: boolean; reviewed?: boolean }): void {
    // commit/push run the gate first UNLESS we're already cleared — either the
    // gate came back clean (reviewed) or the user explicitly bypassed it.
    if ((kind === 'commit' || kind === 'push') && !opts?.bypass && !opts?.reviewed) {
      // T2 — remember which workspace this action is for, so a gate result that
      // arrives after a workspace switch can't clear it in the wrong project.
      pendingGitRef.current = { kind, msg, root: workspaces.current ?? info.workspaceRoot ?? '' };
      setToast('Checking review status…');
      q('q-review-gate', 'review-gate');
      return;
    }
    const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const cmd = kind === 'commit'
      ? `git add -A && git commit -m ${sq(msg ?? '')}`
      : kind === 'push' ? 'git push' : 'git pull --ff-only';
    setGitBusy(true);
    // §7 — a CLEAN gate is "reviewed", NOT a bypass: no warning, no "bypassed" label.
    if (opts?.bypass) console.warn(`[review-gate] ${kind} BYPASSED without a clean review`);
    const state = gitActionTag(opts); // '' | 'reviewed' | 'bypassed'
    const tag = state === 'bypassed' ? ' (review bypassed)' : state === 'reviewed' ? ' (reviewed)' : '';
    setToast(kind === 'commit' ? `Committing${tag}…` : kind === 'push' ? `Pushing${tag}…` : 'Pulling…');
    q('a-git', 'action:term-exec', { cmd });
    // Wave 1 (D) — commit/push are real ACTIVITY → promote this project.
    if (kind !== 'pull') { const r = workspaces.current ?? info.workspaceRoot; if (r) void window.brainrouter.markActivity?.(r, kind); }
  }

  /** Add project = pick folder → trust dialog right away → open in place.
   *  T1 — optimistically insert the folder into the sidebar's project list the
   *  moment it's picked, so it appears instantly (the real recents reconcile on
   *  open). De-duped against the existing recents. */
  function addProject(): void {
    void window.brainrouter.addWorkspace().then((res) => {
      if (!res?.workspaceRoot) return;
      const root = res.workspaceRoot;
      setWorkspaces((prev) => prev.recents.includes(root) ? prev : { ...prev, recents: [root, ...prev.recents] });
      openProject(root);
    }).catch(() => {});
  }

  /** Expand/collapse a project folder; first expand lazy-loads its chats. */
  function toggleProject(root: string): void {
    setExpandedProjects((prev) => {
      const next = prev.includes(root) ? prev.filter((r) => r !== root) : [...prev, root];
      expandedProjectsRef.current = next;
      return next;
    });
    if (!projSessions[root]) q(`q-wsess:${root}`, 'workspace-sessions', { root });
  }

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

  // DESK-5w — keep the per-session background-task list fresh even when the
  // VIEWED chat is idle: another chat may be running work whose tasks should
  // appear/clear in the sidebar (and reflect the boot-time stale reconcile).
  useEffect(() => {
    const t = setInterval(() => q('q-fleet', 'fleet'), 3000);
    q('q-fleet', 'fleet');
    return () => clearInterval(t);
  }, []);

  // T14 — keep the Schedules panel fresh (cheap store read) so nextRun/lastRun
  // tick and another head's /schedule edits show up.
  useEffect(() => {
    const t = setInterval(() => q('q-schedule', 'schedule-list'), 5000);
    q('q-schedule', 'schedule-list');
    return () => clearInterval(t);
  }, []);

  // Wave 1 — live project reorder: main pushes the reordered recents the moment
  // a workspace sees REAL activity (turn/output/commit). Merely opening/viewing
  // a project does NOT fire this, so the list stays stable while you browse.
  useEffect(() => {
    const off = window.brainrouter.onRecentsChanged?.((data) => {
      setWorkspaces((w) => ({ ...w, recents: data.recents }));
    });
    return () => off?.();
  }, []);

  // DESK-5w — while a task's conversation is open, refresh it so a running
  // worker/subagent's chat updates as it works.
  useEffect(() => {
    if (!taskView) return;
    const { kind, id, parentSessionKey } = taskView;
    const t = setInterval(() => q('q-task-transcript', 'task-transcript', { kind, id, parentSessionKey: parentSessionKey ?? '' }), 2500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskView?.id, taskView?.kind]);

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
      case 'q-grep': if (Array.isArray(result)) setGrepHits(result as import('./panels/index.js').GrepHit[]); return;
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

  // DESK-6t — FAST, session-scoped refresh: the sidebar chat list, active-session
  // info, running tasks, and the context ring — NO git/gh calls. Fired on every
  // session switch / New chat so creating or switching a chat stays snappy and
  // never blocks the host's message loop on `git ls-files` / `gh pr view`.
  function refreshSession(): void {
    q('q-sessions', 'list-sessions');
    q('q-info', 'session-info');
    q('q-fleet', 'fleet');
    q('q-ctx', 'context-usage');
  }
  // Full refresh INCL. the slow git/workspace queries — only needed on boot, a
  // workspace switch, and after a turn (files may have changed), NOT on every
  // session switch (the git state is identical across chats in one workspace).
  function refreshSidebar(): void {
    void window.brainrouter.workspaceRecents().then(setWorkspaces).catch(() => {});
    refreshSession();
    q('q-files', 'changed-files');
    q('q-list', 'list-files');
    q('q-git', 'git-info');
    q('q-home', 'home-stats');
    q('q-branches', 'git-branches');
    q('q-pr', 'git-pr');
    q('q-gitlog', 'git-log'); // pinned Environment card shows the last commit
    // Keep expanded project folders fresh (host caches make this cheap).
    for (const root of expandedProjectsRef.current) q(`q-wsess:${root}`, 'workspace-sessions', { root });
  }

  function answerInteraction(response: { type: 'confirm'; approved: boolean } | { type: 'choice'; labels: string[] } | { type: 'dismissed' }): void {
    if (!interaction) return;
    window.brainrouter.send({ kind: 'interaction-response', id: interaction.id, response });
    setInteraction(null);
  }

  // DESK-6 — press Stop: fire the interrupt AND give instant feedback. The host
  // now aborts the in-flight LLM call / tool / children, so the turn unwinds in
  // well under a second; this just makes the UI say so immediately instead of
  // looking frozen behind a status line the next event overwrites.
  function requestStop(): void {
    if (!running || stopping) return;
    window.brainrouter.send({ kind: 'interrupt' });
    setStopping(true);
    setStatusLine('Stopping…');
    setRows((r) => [...r, { id: rid(), kind: 'status', text: '⏹ Stopping…', ts: Date.now() }]);
  }

  function submit(): void {
    const prompt = draft.trim();
    if (!prompt || running || stopping) return;
    // T8 — a slash command is NEVER sent to the LLM. Route it through the
    // command registry: bridge runs against the CLI stores, known commands run
    // their wire (panel/settings/native/cli fallback), and an UNKNOWN slash
    // surfaces a command-output card instead of becoming a chat prompt.
    const slash = resolveSlashInput(prompt, commands);
    if (slash.kind !== 'not-slash') {
      setDraft('');
      if (slash.kind === 'bridge') runBridge(slash.cmd, slash.args);
      else if (slash.kind === 'command') runCommand(slash.command, cmdCtx);
      else setRows((r) => [...r, { id: rid(), kind: 'cmd-out', cmd: prompt,
        lines: [`Unknown command \`${slash.base}\` — type \`/\` to browse commands, or run it in the terminal CLI.`], ts: Date.now() }]);
      return;
    }
    lastPromptRef.current = prompt;
    setRows((r) => [...r, { id: rid(), kind: 'user', text: prompt, ts: Date.now() }]);
    setDraft('');
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
      const optimistic: SessionRow = { sessionKey: sk, firstUserMessage: prompt, modifiedAt: new Date().toISOString(), turnCount: 1, lastRole: 'user' };
      // Wave 2 — track it as pending so subsequent list-sessions refreshes MERGE
      // it (instead of replacing it away) until the host transcript confirms it.
      if (!pendingSessionsRef.current.some((s) => s.sessionKey === sk)) pendingSessionsRef.current = [optimistic, ...pendingSessionsRef.current];
      setSessions((prev) => mergeOptimistic(prev.filter((s) => s.sessionKey !== sk), [optimistic]));
      sessionsRef.current = mergeOptimistic(sessionsRef.current.filter((s) => s.sessionKey !== sk), [optimistic]);
      setTimeout(() => refreshSession(), 400);
    }
    window.brainrouter.send({ kind: 'start-turn', prompt });
  }

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
  // DESK-5w — disk-backed tasks grouped by the chat that owns them, for nesting
  // each task UNDER its session in the sidebar (#2).
  const tasksBySession = useMemo(() => {
    const m = new Map<string, FleetRow[]>();
    for (const f of fleet) {
      const k = f.parentSessionKey ?? '';
      const arr = m.get(k); if (arr) arr.push(f); else m.set(k, [f]);
    }
    return m;
  }, [fleet]);
  // DESK-5w — only the VIEWED chat's tasks, for the Background-tasks panel + env
  // card (#5: switching main session must not show another session's tasks).
  const activeSessionTasks = useMemo<FleetRow[]>(
    () => runningTasks.filter((t) => (t.parentSessionKey ?? '') === (viewKey ?? '')),
    [runningTasks, viewKey],
  );
  // Tasks to nest under a given session row: the viewed session shows live +
  // disk; others show their disk-backed tasks.
  // DESK-6w (#5) — ONLY the active/viewed chat expands its background tasks in
  // the sidebar; switching chats must not surface other sessions' tasks. Inactive
  // sessions get a count chip instead (see the session row), so the info isn't lost.
  const tasksForSession = (key: string): FleetRow[] => (key === viewKey ? activeSessionTasks : []);
  const bgTaskCount = (key: string): number => (key === viewKey ? activeSessionTasks.length : (tasksBySession.get(key)?.length ?? 0));
  // DESK-6u — if the chat on screen was forked, resolve its parent so we can show
  // a "Forked from conversation" link back to the original.
  const forkParent = useMemo(() => {
    const fk = sessions.find((s) => s.sessionKey === viewKey)?.forkedFrom;
    return fk ? { key: fk, title: sessions.find((s) => s.sessionKey === fk)?.firstUserMessage } : null;
  }, [sessions, viewKey]);
  // DESK-5w/6w — open a background task. A workflow opens the /workflows-style
  // card (phases + agents); an agent/worker opens its conversation. Read-only
  // views open at the TOP and don't auto-follow new content.
  const viewToTop = (): void => { atBottomRef.current = false; setTimeout(() => { if (chatRef.current) chatRef.current.scrollTop = 0; }, 50); };

  // DESK-6t — switch chats responsively: a no-op when you're already there;
  // otherwise show the loading state INSTANTLY (so the click never feels stuck)
  // and debounce the actual resume so spam-clicking only loads the final target.
  const resumeSession = (key: string): void => {
    if (!key || key === sessionKeyRef.current) return;
    setTaskView(null); setWorkflowView(null);
    sessionKeyRef.current = key; setViewKey(key);
    setRows([{ id: rid(), kind: 'loading', ts: Date.now() }]);
    setSearchHits(null); setStatusLine(''); setReasoningTail(''); setLiveText(''); liveBuf.current = '';
    setRunning(runningSessionsRef.current.has(key));
    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
    resumeTimerRef.current = setTimeout(() => { window.brainrouter.send({ kind: 'resume-session', sessionKey: key }); }, 120);
  };
  resumeSessionRef.current = resumeSession;

  const openTask = (f: FleetRow): void => {
    if (f.kind === 'workflow') { openWorkflow(f.id); return; }
    setTaskView({ id: f.id, kind: f.kind, role: f.role, status: 'running', parentSessionKey: f.parentSessionKey, rows: [{ id: rid(), kind: 'loading', ts: Date.now() }] });
    q('q-task-transcript', 'task-transcript', { kind: f.kind, id: f.id, parentSessionKey: f.parentSessionKey ?? '' });
    viewToTop();
  };
  const openWorkflow = (slug: string): void => {
    const now = new Date().toISOString();
    setWorkflowView({ slug, kind: '', status: 'running', startedAt: now, updatedAt: now, totalAgents: 0, totalTokens: 0, phases: [], steps: [] });
    q('q-workflow-detail', 'workflow-detail', { slug });
    viewToTop();
  };

  // DESK-6m — per-chat ⋮ menu actions. Each writes the shared CLI store via a
  // host action, then refreshes the sidebar list.
  const closeSessionMenu = (): void => setSessionMenu(null);
  const setMeta = (key: string, patch: Record<string, unknown>): void => { q('q-session-meta', 'action:session-meta', { sessionKey: key, patch }); closeSessionMenu(); };
  const togglePin = (s: SessionRow): void => setMeta(s.sessionKey, { pinned: !s.pinned });
  const toggleComplete = (s: SessionRow): void => setMeta(s.sessionKey, { status: s.status === 'completed' ? 'active' : 'completed' });
  const toggleArchive = (s: SessionRow): void => setMeta(s.sessionKey, { archived: !s.archived });
  const moveToGroup = (key: string, group: string | null): void => setMeta(key, { group });
  const startRename = (s: SessionRow): void => { setRenamingKey(s.sessionKey); setRenameDraft(s.firstUserMessage || ''); closeSessionMenu(); };
  const commitRename = (): void => { if (renamingKey) q('q-session-meta', 'action:session-meta', { sessionKey: renamingKey, patch: { title: renameDraft.trim() } }); setRenamingKey(null); };
  // DESK-6v — upToTs (a message's epoch-ms ts) branches the fork at that message;
  // omitted (the ⋮ menu) forks the whole conversation.
  const forkSessionAction = (key: string, upToTs?: number): void => { q('q-session-fork', 'action:session-fork', { sessionKey: key, ...(upToTs != null ? { upToTs } : {}) }); closeSessionMenu(); };
  const deleteSessionAction = (key: string): void => {
    closeSessionMenu();
    if (!window.confirm('Delete this chat permanently? This removes its transcript from disk.')) return;
    q('q-session-delete', 'action:session-delete', { sessionKey: key });
    if (sessionKeyRef.current === key) window.brainrouter.send({ kind: 'new-session' });
  };
  const openExternal = (what: string): void => { q('q-open-external', 'action:open-external', { what }); closeSessionMenu(); };
  const openSessionMenu = (e: React.MouseEvent, key: string): void => {
    e.preventDefault(); e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    q('q-session-groups', 'action:session-groups'); // refresh the Move-to-group list
    setSessionMenu({ key, x: Math.min(r.left, window.innerWidth - 250), y: r.bottom + 4 });
  };

  // Item 9 — sessions that share an opening prompt get their age appended inline
  // so identical-looking rows stay distinguishable.
  const dupeTitleKeys = useMemo(() => duplicateTitleKeys(sessions), [sessions]);

  // DESK-6m — one chat row (with its ⋮ menu trigger + pinned/completed state +
  // inline rename) plus its nested background tasks. Reused for grouped sections.
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
            {s.sessionKey !== viewKey && bgTaskCount(s.sessionKey) > 0
              ? <span className="session-bg" title={`${bgTaskCount(s.sessionKey)} background task(s) — open this chat to view`}>{bgTaskCount(s.sessionKey)}</span> : null}
            {s.modifiedAt && !dupeTitleKeys.has(s.sessionKey) ? <span className="session-age">{fmtAge(s.modifiedAt)}</span> : null}
          </button>
        )}
        <button className="session-menu-btn icon-btn" aria-label="Chat options" onClick={(e) => openSessionMenu(e, s.sessionKey)}><Icon name="dots" size={13} /></button>
      </div>
      {tasksForSession(s.sessionKey).map((f) => (
        <button key={f.id} className={`project-session task nested${taskView?.id === f.id ? ' active' : ''}`}
          title={`${f.kind} · ${f.id}${f.role ? ' · ' + f.role : ''} — click to view its conversation`}
          onClick={() => openTask(f)}>
          <span className={`st st-task ${f.kind}`}>{f.worktree ? <Icon name="merge" size={11} /> : <span className="task-dot" />}</span>
          <span className="session-title">{f.label}</span>
          <span className="st"><span className="spinner sm" /></span>
        </button>
      ))}
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
  // T4 — sidebar groupings (archived/pinned/grouped split + visible window +
  // other projects) live in a pure hook now.
  const { archivedCount, ungroupedSessions, groupedSessions, visibleProjectSessions, hiddenProjectSessions, currentProjectName, otherProjects } =
    useSessionSidebar({ sessions, showArchived, recentsSort, recentsOpen, visibleCount, workspaces, info });

  function runSlash(c: DeskCommand): void {
    setDraft('');
    setSlashSel(0);
    runCommand(c, cmdCtx);
  }

  // DESK-5f — tab CONTENT only; the tab strip owns titles and closing.
  const renderPanelBody = (id: PanelId): React.ReactElement | null => {
    switch (id) {
      case 'context': return (
        <>
          <div className="kv"><span>Host</span><b><span className={`dot ${hostUp ? 'on' : 'off'}`} />{hostUp ? 'online' : 'starting…'}</b></div>
          <div className="kv"><span>Model</span><b>{info.model ?? '—'}</b></div>
          <div className="kv"><span>Workspace</span><b title={info.workspaceRoot}>{info.workspaceRoot?.split('/').pop() ?? '—'}</b></div>
          {/* Stability fix (T4) — when the workspace is a SUBDIR of a larger repo
              (monorepo / nested clone), show the owning git repo + the repo-
              relative path so it's clear what git operations are scoped to. */}
          {gitInfo?.isSubdir && gitInfo.gitRoot ? (
            <div className="kv"><span>Git repo</span><b title={gitInfo.gitRoot}>{gitInfo.repo}<span style={{ opacity: 0.55 }}>{` / ${gitInfo.repoRelativePath}`}</span></b></div>
          ) : null}
          <div className="kv"><span>Tokens</span><b>{tokens ? `${tokens.promptTokens.toLocaleString()} in / ${tokens.completionTokens.toLocaleString()} out` : '—'}</b></div>
          <div className="kv"><span>Config</span><b>~/.config/brainrouter</b></div>
        </>);
      case 'files': return <FilesPanel files={allFiles} statuses={statuses} onOpen={openFile} grepHits={grepHits} onGrep={(gq) => q('q-grep', 'search-content', { q: gq })} />;
      case 'file': return <FileViewerPanel view={fileView} />;
      case 'editor': return (
        <Suspense fallback={<div className="row status"><span className="spinner" /> Loading editor…</div>}>
          <EditorPanel
            tabs={editor.tabs} activePath={editor.activePath} conflictPaths={editor.conflictPaths} saving={editor.saving}
            onSelect={editor.select} onChange={editor.change} onSave={editor.save} onSaveAll={editor.saveAll}
            onRevert={editor.revert} onClose={closeEditorTab} />
        </Suspense>
      );
      case 'ci': return <CIPanel ci={ci} onOpenExternal={openUrl} />;
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
      case 'tasks': return <TasksPanel fleet={activeSessionTasks} finished={finishedTasks} onClear={() => setFinishedTasks([])} onOpen={(id) => { const f = activeSessionTasks.find((t) => t.id === id); if (f) openTask(f); }} />;
      case 'dashboard': return <DashboardPanel scope={dashScope} setScope={(s) => { setDashScope(s); if (s === 'all') refreshDashboard(); }}
        tab={dashTab} setTab={setDashTab} boards={dashBoards} busy={dashBusy} onRefresh={refreshDashboard}
        onOpenTask={(t) => { if (t.workspaceRoot && t.workspaceRoot !== activeRoot) switchToWorkspace(t.workspaceRoot, t.parentSessionKey ?? undefined); else { const f = fleet.find((x) => x.id === t.id); if (f) openTask(f); } }}
        onStopTask={(t) => { if (!t.workspaceRoot || t.workspaceRoot === activeRoot) { window.brainrouter.send({ kind: 'interrupt' }); setToast('Interrupt sent to this workspace.'); } else setToast('Open that workspace to stop its tasks.'); }} />;
      case 'plan': return <PlanPanel plan={lastPlan} />;
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
          onOpenFile={(f) => openFile(f.file)}
          onOpenDiff={(f) => { setDiffTarget({ path: f.file, line: f.line }); ensurePanel('diff'); q('q-diff', 'file-diff', { path: f.file }); }} />;
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
  const envRoom = workW === 0 || workW - (sidePanelOpen ? sideWidth : 0) - 316 >= 820;
  const envVisible = envOpen && !homeMode && envRoom;
  const railAnim = useClosable(railOpen);
  const sideAnim = useClosable(sidePanelOpen);
  const dockAnim = useClosable(termDockOpen);
  const envAnim = useClosable(envVisible, 150);

  return (
    <div className="app">
      {railAnim.mounted ? (
        <nav className={`rail${railAnim.closing ? ' closing' : ''}`} style={{ width: railWidth }}>
          <div className="rail-grip" title="Drag to resize · drag far left to hide"
            onPointerDown={(e) => {
              e.preventDefault();
              const startX = e.clientX;
              const startW = railWidth;
              const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
              // DESK-5k — Codex swipe-to-hide: dragging well past the minimum
              // collapses the sidebar (exit animation plays); width survives
              // for the next open.
              const move = (ev: PointerEvent) => {
                const w = startW + ev.clientX - startX;
                if (w < 165) { up(); setRailOpen(false); return; }
                setRailWidth(Math.max(220, Math.min(420, w)));
              };
              window.addEventListener('pointermove', move);
              window.addEventListener('pointerup', up);
            }} />
          <div className="rail-top">
            <button className="icon-btn" title="Toggle sidebar" onClick={() => setRailOpen(false)}><Icon name="layout" size={15} /></button>
            <button className="icon-btn" title="Search commands (⌘K)" onClick={() => setPaletteOpen(true)}><Icon name="search" size={14} /></button>
          </div>
          <div className="rail-card">
            <div className="rail-actions">
              <button className="rail-action primary" onClick={() => window.brainrouter.send({ kind: 'new-session' })}><Icon name="plus" size={13} />New chat</button>
              <button className="rail-action" title="Search chats" onClick={() => ensurePanel('search')}><Icon name="search" size={13} /></button>
              <button className="rail-action" title="Command palette (⌘K)" onClick={() => setPaletteOpen(true)}><Icon name="command" size={13} /></button>
              <button className="rail-action" title="Workbench" onClick={() => setSidePanelOpen(true)}><Icon name="panels" size={13} /></button>
            </div>
            <div className="projects-head">
              <span>Projects</span>
              <button className="icon-btn" title={`Sort chats: ${recentsSort}`} onClick={() => setRecentsSort((s) => (s === 'recent' ? 'alpha' : 'recent'))}><Icon name="sort" size={12} /></button>
            </div>
            <div className="projects-scroll">
              <div className="project-block">
                <button className="project-row active" title={workspaces.current ?? info.workspaceRoot} onClick={() => setRecentsOpen((o) => !o)}>
                  <Icon name="folder-open" size={15} />
                  <span>{currentProjectName}</span>
                  <span className="project-meta">
                    {activeReviewBadge ? (
                      <span className={`review-badge rb-${activeReviewBadge}`} title={`Review: ${activeReviewBadge.replace('-', ' ')}`}>
                        {activeReviewBadge === 'blocked' ? '⚠' : activeReviewBadge === 'passed' ? '✓' : activeReviewBadge === 'stale' ? '↻' : activeReviewBadge === 'reviewing' ? '…' : '○'}
                      </span>
                    ) : null}
                    {prInfo ? (
                      <span className={`pr-chip ${prInfo.state.toLowerCase()}`}
                        title={`#${prInfo.number} · ${prInfo.state.charAt(0)}${prInfo.state.slice(1).toLowerCase()}${prInfo.title ? ` — ${prInfo.title}` : ''}`}>
                        <Icon name="merge" size={12} />
                      </span>
                    ) : null}
                    <Icon name={recentsOpen ? 'chev-down' : 'chev-right'} size={10} className="project-chev" />
                  </span>
                </button>
                <div className="project-sessions">
                  {/* DESK-5w/6m — chats (with per-chat ⋮ menu) + their nested
                      background tasks; pinned first, grouped sections below. */}
                  {visibleProjectSessions.map((s, i) => renderSessionNode(s, i))}
                  {!recentsOpen && hiddenProjectSessions > 0 ? (
                    <button className="show-more" onClick={() => setRecentsOpen(true)}>{`Show ${hiddenProjectSessions} more`}</button>
                  ) : recentsOpen && showToggle(ungroupedSessions.length, visibleProjectSessions.length) ? (
                    <button className="show-more" onClick={() => setVisibleCount((c) => toggleVisible(c, ungroupedSessions.length))}>
                      {moreLabel(ungroupedSessions.length, visibleProjectSessions.length)}
                    </button>
                  ) : null}
                  {/* DESK-6m — grouped chats as their own labeled sections. */}
                  {groupedSessions.map(([group, items]) => (
                    <div key={group} className="session-group">
                      <div className="session-group-head"><Icon name="folder" size={11} /><span>{group}</span><span className="dim">{items.length}</span></div>
                      {items.map((s, i) => renderSessionNode(s, i))}
                    </div>
                  ))}
                  {archivedCount > 0 ? (
                    <button className="show-more" onClick={() => setShowArchived((a) => !a)}>
                      {showArchived ? 'Hide archived' : `Show ${archivedCount} archived`}
                    </button>
                  ) : null}
                </div>
              </div>
              {otherProjects.map((w) => {
                const open = expandedProjects.includes(w);
                const list = projSessions[w];
                return (
                  <div key={w} className="project-block">
                    <button className="project-row" title={runningWs.has(w) ? `${w} — running in the background` : w} onClick={() => toggleProject(w)}>
                      <Icon name={open ? 'folder-open' : 'folder'} size={15} />
                      <span>{w.split('/').pop()}</span>
                      <span className="project-meta">
                        {runningWs.has(w) ? <span className="ws-running-dot" title="Running in the background" /> : null}
                        <span className="icon-btn project-open" title="Open this project here"
                          onClick={(ev) => { ev.stopPropagation(); openProject(w); }}>
                          <Icon name="arrow-right" size={12} />
                        </span>
                        <Icon name={open ? 'chev-down' : 'chev-right'} size={10} className="project-chev" />
                      </span>
                    </button>
                    {open ? (
                      <div className="project-sessions">
                        {list === undefined ? <div className="proj-empty">Loading…</div>
                          : list.length === 0 ? <div className="proj-empty">No chats yet</div>
                          : list.slice(0, 6).map((s) => (
                            <button key={s.sessionKey} className="project-session" title={`${s.sessionKey} — opens ${w.split('/').pop()}`}
                              onClick={() => openProject(w, s.sessionKey)}>
                              <SessionStatus s={s} />
                              <span className="session-title">{s.firstUserMessage || s.sessionKey}</span>
                              {s.modifiedAt ? <span className="session-age">{fmtAge(s.modifiedAt)}</span> : null}
                            </button>
                          ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
              <button className="project-row add-project" onClick={addProject}><Icon name="folder-plus" size={15} /><span>Add project</span></button>
            </div>
          {/* DESK-5m — plain identity row: Settings lives in the top-right
              gear and All commands in ⌘K, so no menu and no chevron here. */}
          <div className="account-row" title={workspaces.current ?? info.workspaceRoot}>
            <span className="avatar">{(info.username ?? 'br').slice(0, 2)}</span>
            <span className="account-name">{info.username ?? 'BrainRouter'}</span>
          </div>
          </div>
        </nav>
      ) : null}

      <div className="main">
        <div className="workrow" ref={workrowRef}>
          <main className={`center${homeMode ? ' home-mode' : ''}${railOpen ? '' : ' no-rail'}`}>
            <header className="chat-head">
              {!railOpen ? <button className="icon-btn" title="Open sidebar" onClick={() => setRailOpen(true)}><Icon name="layout" size={15} /></button> : null}
              <span className="crumb">
                <b>{gitInfo?.repo ?? info.workspaceRoot?.split('/').pop() ?? 'BrainRouter'}</b>
                <span className="crumb-sep">/</span>
                {taskView ? (
                  /* DESK-6v — viewing a sub-agent: ONE breadcrumb (no second header
                     bar). The parent session is clickable = back. */
                  <>
                    <button className="crumb-link" onClick={() => setTaskView(null)}>{sessionTitle}</button>
                    <span className="crumb-sep">/</span>
                    <span className="crumb-cur">{taskView.role || taskView.kind}</span>
                    {taskView.status ? <span className={`task-status ${taskView.status}`}>{taskView.status}</span> : null}
                  </>
                ) : sessionTitle}
              </span>
            </header>
            <div className="chat" ref={chatRef} onScroll={() => {
              const el = chatRef.current;
              if (!el) return;
              const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
              atBottomRef.current = pinned;
              setAtBottom(pinned);
            }}>
              {workflowView ? (
                /* DESK-6w — the /workflows-style card for a workflow run. */
                <WorkflowCard wf={workflowView} onBack={() => setWorkflowView(null)} />
              ) : taskView ? (
                /* DESK-6v — a background task's conversation, read-only, in place
                   of the chat. The header breadcrumb (Repo / Session / Role +
                   status) now carries the title and back-link, so there's no
                   second header bar here — that double header was the confusing
                   part. The prompt is already the first user bubble. */
                <div className="task-convo">
                  {taskView.rows.map((r) => renderRow(r, false))}
                </div>
              ) : (
                <>
                  {homeMode ? (
                    <HomeView username={info.username} stats={homeStats} tab={statsTab} setTab={setStatsTab}
                      range={statsRange} setRange={setStatsRange} model={info.model} provider={snapshot?.provider}
                      repo={gitInfo?.repo ?? info.workspaceRoot?.split('/').pop()}
                      recents={sessions}
                      onResume={(key) => resumeSession(key)} />
                  ) : null}
                  {!homeMode && forkParent ? (
                    <button className="fork-banner" onClick={() => resumeSession(forkParent.key)}
                      title="Open the original conversation this was forked from">
                      <Icon name="branch" size={12} />
                      <span>Forked from <strong>{forkParent.title || 'conversation'}</strong></span>
                    </button>
                  ) : null}
                  {transcriptEls}
                </>
              )}
              {!taskView && !workflowView && liveText ? (
                <div className="row assistant md live">
                  <Markdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{liveText}</Markdown>
                  <span className="caret">▍</span>
                </div>
              ) : null}
              {!taskView && !workflowView && running ? (
                <div className="row workline">
                  <span className="spinner sm" />
                  <WorkElapsed startedAt={turnStart} />
                  <span>·</span>
                  <span>{liveText ? 'writing…' : reasoningTail ? 'thinking…' : statusLine || 'working…'}</span>
                  {reasoningTail && !liveText ? <span className="reasoning"> {reasoningTail.slice(-90)}</span> : null}
                </div>
              ) : null}
              {!taskView && !workflowView && interaction && interaction.type === 'confirm' ? (
                <div className="approval-card" onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) answerInteraction({ type: 'confirm', approved: true });
                }}>
                  <div className="approval-head">
                    <span className="approval-dot" />
                    <span className="approval-title">{interaction.title}</span>
                    <span className="approval-scope">Project (local)</span>
                  </div>
                  {interaction.tool ? <div className="approval-sub">{interaction.tool}</div> : null}
                  {interaction.dangerous ? <div className="approval-warn">This action is flagged as potentially dangerous.</div> : null}
                  {interaction.detail ? <pre className="approval-detail">{interaction.detail}</pre> : null}
                  <div className="approval-actions">
                    <button className="btn-deny" onClick={() => answerInteraction({ type: 'confirm', approved: false })}>Deny</button>
                    <span className="spacer" />
                    <button className="btn-always" onClick={() => {
                      const rule = `${interaction.tool ?? 'run_command'}(*)`;
                      q('a-allow-rule', 'action:allow-rule', { rule });
                      answerInteraction({ type: 'confirm', approved: true });
                    }}>Always allow</button>
                    <button className="btn-once" autoFocus onClick={() => answerInteraction({ type: 'confirm', approved: true })}>Allow once<kbd>Ctrl+⏎</kbd></button>
                  </div>
                </div>
              ) : null}
              <div ref={chatEnd} />
            </div>
            {hasConversation && !atBottom ? (
              <button className="jump-latest" onClick={() => {
                atBottomRef.current = true;
                setAtBottom(true);
                chatEnd.current?.scrollIntoView({ behavior: 'smooth' });
              }}>↓ Latest</button>
            ) : null}
            {hasConversation && gitInfo?.branch && (gitInfo.insertions + gitInfo.deletions > 0) ? (
              <div className="branchbar" onClick={() => ensurePanel('diff')}>
                <Icon name="diff" size={12} />
                <span><span className="add-n">+{gitInfo.insertions.toLocaleString()}</span> <span className="del-n">-{gitInfo.deletions.toLocaleString()}</span></span>
                <span className="dim">{changedFiles.length} files changed — view diff</span>
              </div>
            ) : null}
            <Composer
              draft={draft} setDraft={setDraft} running={running} stopping={stopping} submit={submit} requestStop={requestStop}
              slashActive={slashActive} slashMatches={slashMatches} commands={commands} slashSel={slashSel} setSlashSel={setSlashSel}
              setSlashDismissed={setSlashDismissed} onRunSlash={runSlash} pop={pop} setPop={setPop} q={q}
              modeLabel={modeLabel} execMode={execMode} effort={effort} info={info} branches={branches}
              endpointModels={endpointModels} modelsLoading={modelsLoading} setModelsLoading={setModelsLoading}
              modelChoices={modelChoices} modelScope={modelScope} setModelScope={setModelScope}
              hasConversation={hasConversation} contextUsage={contextUsage} tokens={tokens} openSettings={openSettings} />
          </main>

          {/* DESK-5h — Environment as a LAYOUT COLUMN: the chat reflows next
              to it; it can never cover content. Yields via envRoom. */}
          <EnvironmentPanel envAnim={envAnim} openSettings={openSettings} gitInfo={gitInfo} ensurePanel={ensurePanel}
            setTermDockOpen={setTermDockOpen} branches={branches} q={q} commitSubjects={commitSubjects} ci={ci}
            openCiPanel={openCiPanel} lastTurnFails={lastTurnFails} activeSessionTasks={activeSessionTasks} openTask={openTask} />

          {sideAnim.mounted ? (
            <aside className={`views-rail${sideAnim.closing ? ' closing' : ''}`} style={{ width: sideWidth }}>
              <div className="col-grip" title="Drag to resize · drag far right to hide"
                onPointerDown={(e) => {
                  e.preventDefault();
                  const startX = e.clientX;
                  const startW = sideWidth;
                  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
                  // DESK-5k — swipe-to-hide, mirroring the left rail's grip.
                  const move = (ev: PointerEvent) => {
                    const w = startW + (startX - ev.clientX);
                    if (w < 215) { up(); setSidePanelOpen(false); return; }
                    setSideWidth(Math.max(280, Math.min(760, w)));
                  };
                  window.addEventListener('pointermove', move);
                  window.addEventListener('pointerup', up);
                }} />
              {activeSideTab ? (
                <>
                  {/* DESK-5f — tabs, not windows: one view at a time, switchable */}
                  <div className="side-tabs">
                    {sideTabs.map((t) => (
                      <button key={t} className={`term-tab${t === activeSideTab ? ' active' : ''}`} onClick={() => setActiveSideTab(t)}>
                        <Icon name={PANEL_DEFS.find((d) => d.id === t)?.icon ?? 'file'} size={11} />
                        <span className="tab-label">{tabTitle(t)}</span>
                        <span className="icon-btn term-tab-x" onClick={(ev) => { ev.stopPropagation(); closeSideTab(t); }}><Icon name="close" size={9} /></span>
                      </button>
                    ))}
                    <span className="pop-wrap">
                      {pop === 'splus' ? (
                        /* right-aligned: opens INTO the panel — a left-aligned
                           menu runs past the window edge when the panel is
                           the rightmost column */
                        <div className="menu-pop down">
                          {VIEW_MENU.filter((v) => !sideTabs.includes(v.id)).map((v) => (
                            <button key={v.id} className="menu-item" onClick={() => { setPop(''); ensurePanel(v.id); }}>
                              <span className="mi-check"><Icon name={v.icon} size={13} /></span>{v.title}
                            </button>
                          ))}
                          <div className="menu-sep" />
                          <button className="menu-item" onClick={() => { setPop(''); openBottomDock(); }}>
                            <span className="mi-check"><Icon name="terminal" size={13} /></span>Terminal<span className="mi-hint">⌃`</span>
                          </button>
                        </div>
                      ) : null}
                      <button className="icon-btn" title="Add view" onClick={() => setPop(pop === 'splus' ? '' : 'splus')}><Icon name="plus" size={12} /></button>
                    </span>
                    <span className="composer-spacer" />
                  </div>
                  <div className="side-body panel-body" key={activeSideTab}>{renderPanelBody(activeSideTab)}</div>
                </>
              ) : (
                /* DESK-5f — no tab yet: ask the user to choose a view (Codex) */
                <div className="side-chooser">
                  {([
                    { id: 'plan' as PanelId, title: 'Plan', hint: '⌃⇧G', icon: 'review',
                      badge: lastPlan?.items.length ? `${lastPlan.items.filter((it) => it.status === 'completed').length}/${lastPlan.items.length}` : '' },
                    { id: 'terminal' as PanelId, title: 'Terminal', hint: '⌃`', icon: 'terminal', badge: '' },
                    { id: 'files' as PanelId, title: 'Files', hint: '⌘P', icon: 'folder', badge: '' },
                    { id: 'diff' as PanelId, title: 'Changes', hint: '⇧⌘D', icon: 'diff',
                      badge: changedFiles.length ? String(changedFiles.length) : '' },
                    { id: 'tasks' as PanelId, title: 'Background tasks', hint: '', icon: 'tasks',
                      badge: activeSessionTasks.length ? String(activeSessionTasks.length) : '', live: activeSessionTasks.length > 0 },
                    { id: 'dashboard' as PanelId, title: 'Dashboard', hint: '', icon: 'tasks',
                      badge: fleet.length ? String(fleet.length) : '' },
                    { id: 'tools' as PanelId, title: 'Tool calls', hint: '', icon: 'bolt',
                      badge: toolLog.length ? String(toolLog.length) : '' },
                    { id: 'search' as PanelId, title: 'Search session', hint: '', icon: 'search', badge: '' },
                    { id: 'schedule' as PanelId, title: 'Schedules', hint: '', icon: 'clock',
                      badge: schedules.filter((s) => s.enabled).length ? String(schedules.filter((s) => s.enabled).length) : '' },
                    { id: 'worktrees' as PanelId, title: 'Worktrees', hint: '', icon: 'branch',
                      badge: worktrees.length ? String(worktrees.length) : '' },
                    { id: 'review' as PanelId, title: 'Review', hint: '', icon: 'review',
                      badge: review?.findings.length ? String(review.findings.length) : '' },
                    { id: 'ci' as PanelId, title: 'CI / Checks', hint: '', icon: 'check-circle',
                      badge: ci.checks.length ? String(ci.checks.length) : '' },
                    { id: 'context' as PanelId, title: 'Context', hint: '', icon: 'layout-right', badge: '' },
                  ] as Array<{ id: PanelId; title: string; hint: string; icon: string; badge: string; live?: boolean }>).map((l) => (
                    <button key={l.id} className="side-launcher" onClick={() => openSideView(l.id)}>
                      <Icon name={l.icon} size={18} />
                      <span>{l.title}</span>
                      <span className="launcher-meta">
                        {l.live ? <span className="spinner sm" /> : null}
                        {l.badge ? <span className="launcher-badge">{l.badge}</span> : null}
                        {l.hint ? <kbd>{l.hint}</kbd> : null}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </aside>
          ) : null}
        </div>

        <TerminalDock dockAnim={dockAnim} termDockHeight={termDockHeight} resizeTerminal={resizeTerminal}
          termTabs={termTabs} activeTerm={activeTerm} setActiveTerm={setActiveTerm} closeBottomTab={closeBottomTab}
          pop={pop} setPop={setPop} addBottomTab={addBottomTab} setTermDockOpen={setTermDockOpen}
          tabTitle={tabTitle} gitInfo={gitInfo} renderPanelBody={renderPanelBody} />

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
          setSidePanelOpen={setSidePanelOpen} pop={pop} setPop={setPop} openSettings={openSettings} />
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
        onPref={(key, value) => q('a-pref', 'action:set-pref', { key, value })}
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
