/**
 * DESK-4c — the app shell: left rail · chat thread · resizable panel columns.
 * Panels open as full-height window columns right of the chat (drag the left
 * edge to resize). Every CLI slash command surfaces here: ⌘K palette, the
 * composer "/" popup, and the categorized Settings modal.
 */
import React, { useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react';
import type { AgentEvent, AgentEventMessage, InteractionRequest } from '@kinqs/brainrouter-agent-protocol';
import {
  DiffPanel, FilesPanel, FileViewerPanel, PlanPanel, SearchPanel, SchedulePanel, WorktreesPanel, ReviewPanel,
  TasksPanel, TerminalPanel, ToolsPanel, PANEL_DEFS, type PanelId, type SearchHit, type ReviewFindingView,
} from './panels/index.js';
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
import type { PlanItem, ToolItem, ChatRow, SessionRow, FleetRow } from './types.js';
import { fileFromSummary, fmtAge, fmt, download } from './lib/format.js';
import { FOREGROUND_ONLY_KINDS } from './constants.js';
import { useClosable } from './lib/useClosable.js';
import { rid } from './lib/rid.js';
import { useAgentEvents } from './lib/agent/useAgentEvents.js';
import { useEditor } from './lib/editor/useEditor.js';
import { useCi } from './lib/ci/useCi.js';
import { CIPanel } from './panels/CIPanel.js';
import { DashboardPanel } from './panels/DashboardPanel.js';
import { type DashTab, type DashTask, type WorkspaceDash } from './lib/workspace/dashboard.js';
// Monaco is ~5MB — lazy-load the editor panel so it only loads when first opened.
const EditorPanel = lazy(() => import('./panels/EditorPanel.js').then((m) => ({ default: m.EditorPanel })));
import { MessageRow } from './chat/MessageRow.js';
import { SessionStatus } from './components/SessionStatus.js';
import { Composer } from './components/Composer.js';
import { useComposerDerived } from './lib/composer/useComposerDerived.js';
import { useSessionSidebar } from './lib/session/useSessionSidebar.js';
import { useGitState } from './lib/git/useGitState.js';
import { useSessionState } from './lib/session/useSessionState.js';
import { useSessionActions } from './lib/session/useSessionActions.js';
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
  const [rows, setRows] = useState<ChatRow[]>([]);
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
    sessionMenu, setSessionMenu, sessionKeyRef, cardOpenRef, errorsBySession, lastPromptRef, turnFailsRef,
    workspaces, setWorkspaces, expandedProjects, setExpandedProjects, expandedProjectsRef, projSessions, setProjSessions,
    activeWsRef, workspaceGenRef, pendingResumeRef, trustAsk, setTrustAsk, runningWs, setRunningWs,
    setSessionRunning,
  } = useSessionState();
  const [statusLine, setStatusLine] = useState('');
  const [reasoningTail, setReasoningTail] = useState('');
  const [liveText, setLiveText] = useState('');
  const [fleet, setFleet] = useState<FleetRow[]>([]);
  const [info, setInfo] = useState<{ sessionKey?: string; model?: string; workspaceRoot?: string; username?: string }>({});
  const [hostUp, setHostUp] = useState(false);
  const [interaction, setInteraction] = useState<InteractionRequest | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
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
  const [modelsLoading, setModelsLoading] = useState(false);
  // Item 10 — where a model pick is saved: 'global' = config.json (shared with
  // the CLI, every chat), 'session' = this chat only (sessionRuntimeStore).
  const [modelScope, setModelScope] = useState<'global' | 'session'>('global');
  // T14 — scheduled tasks for the viewed session (cron/once), from the CLI store.
  const [schedules, setSchedules] = useState<ScheduleRecordView[]>([]);
  const [chatWidth, setChatWidth] = useState(() => localStorage.getItem('br-chat-w') ?? 'medium');
  const [chatSize, setChatSize] = useState(() => localStorage.getItem('br-chat-fs') ?? 'medium');
  const [accent, setAccent] = useState(() => localStorage.getItem('br-accent') ?? '');
  const [prInfo, setPrInfo] = useState<{ number: number; state: string; title?: string } | null>(null);
  const [recentsOpen, setRecentsOpen] = useState(true);
  // Item 9 — how many of the current project's chats are shown (grows a page at
  // a time via the show-more button). Collapsed view always shows the base few.
  const [visibleCount, setVisibleCount] = useState(SESSION_BASE);
  const commands = useMemo(() => buildCommandList(catalog), [catalog]);

  const q = (id: string, name: string, args?: Record<string, unknown>) =>
    window.brainrouter.send({ kind: 'query', id: tagQueryId(id, workspaceGenRef.current), name, args });

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
    refreshSession, refreshSidebar, resumeSession, resumeSessionRef, resumeTimerRef,
    openTask, openWorkflow, viewToTop, answerInteraction, requestStop,
    switchToWorkspace, openProject, addProject, toggleProject,
    openSettings, openFile, closeEditorTab, openUrl, openCiPanel, refreshDashboard, openDashboard,
    closeSessionMenu, setMeta, togglePin, toggleComplete, toggleArchive, moveToGroup,
    startRename, commitRename, forkSessionAction, deleteSessionAction, openExternal, openSessionMenu,
  } = useSessionActions({
    q, running, stopping, interaction, renamingKey, renameDraft, workspaces, info, projSessions,
    runningSessionsRef, sessionKeyRef, pendingResumeRef, workspaceGenRef, expandedProjectsRef,
    liveBuf, chatRef, atBottomRef,
    setStopping, setStatusLine, setReasoningTail, setLiveText, setRows, setRunning, setInteraction,
    setSearchHits, setViewKey, setTaskView, setWorkflowView, setWorkspaces, setExpandedProjects, setTrustAsk,
    setHostUp, setGitInfo, setPrInfo, setBranches, setChangedFiles, setAllFiles, setFileView, setDiffView,
    setTokens, setGateBlock, setLastPlan, setFleet, setLiveChildren, setCommitSubjects, setToast,
    setProjSessions, setSettings, setSessionMenu, setRenamingKey, setRenameDraft, setDashBusy, setGlobalBoards,
    pendingGitRef, ensurePanel, resetTermDock, editor, ci,
  });

  const dashBoards = useMemo<WorkspaceDash[]>(() => {
    if (dashScope === 'all') return globalBoards ?? [];
    const tasks: DashTask[] = [
      ...fleet.map((f) => ({ kind: f.kind, id: f.id, label: f.label, startedAt: f.startedAt, role: f.role, worktree: f.worktree, parentSessionKey: f.parentSessionKey, workspaceRoot: activeRoot, status: 'running' })),
      ...finishedTasks.map((t) => ({ kind: 'agent', id: t.id, label: t.label, status: /fail/i.test(t.status) ? 'failed' : 'completed', workspaceRoot: activeRoot })),
    ];
    return [{ workspaceRoot: activeRoot, tasks, reviewGate }];
  }, [dashScope, globalBoards, fleet, finishedTasks, activeRoot, reviewGate]);

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

  useAgentEvents({
    setRows, setRunning, setStopping, setStatusLine, setReasoningTail, setLiveText, setToolLog,
    setLiveChildren, setFinishedTasks, setLastPlan, setTokens, setInteraction, setPicked, setViewKey,
    setTaskView, setWorkflowView, setInfo, setWorkspaces, setRunningWs, setHostUp, setLastTurnFails,
    setDraft, setProjSessions, setSessions, setPrInfo, setContextUsage, setFleet, setChangedFiles,
    setDiffView, setInlineDiffs, setAllFiles, setFileView, setGitInfo, setCommitSubjects, setHomeStats,
    setBranches, setModelsLoading, setEndpointModels, setCatalog, setSnapshot, setUsageLines,
    setSearchHits, setSchedules, setWorktrees, setWorktreeDiffs, setReviewRunningByWs, setReviewByWs,
    setReviewGateByWs, setGateBlock, setGrepHits, setSessionGroups, setGitBusy, setInfoDialog, setToast,
    setAtBottom,
    liveBuf, liveFlushPending, activeWsRef, sessionKeyRef, turnFailsRef, runningSessionsRef,
    pendingResumeRef, errorsBySession, lastPromptRef, workspaceGenRef, pendingSessionsRef, sessionsRef,
    atBottomRef, cardOpenRef, chatEnd, chatRef, pendingGitRef, pendingCmdRef,
    q, refreshSession, refreshSidebar, runGit, setSessionRunning, info, gitInfo, homeStats, branches,
  });

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
      <Sidebar railAnim={railAnim} railWidth={railWidth} setRailOpen={setRailOpen} setRailWidth={setRailWidth}
        setPaletteOpen={setPaletteOpen} ensurePanel={ensurePanel} setSidePanelOpen={setSidePanelOpen}
        recentsSort={recentsSort} setRecentsSort={setRecentsSort} workspaces={workspaces} info={info}
        currentProjectName={currentProjectName} activeReviewBadge={activeReviewBadge} prInfo={prInfo}
        recentsOpen={recentsOpen} setRecentsOpen={setRecentsOpen} visibleProjectSessions={visibleProjectSessions}
        renderSessionNode={renderSessionNode} hiddenProjectSessions={hiddenProjectSessions} ungroupedSessions={ungroupedSessions}
        setVisibleCount={setVisibleCount} groupedSessions={groupedSessions} archivedCount={archivedCount}
        setShowArchived={setShowArchived} showArchived={showArchived} otherProjects={otherProjects}
        expandedProjects={expandedProjects} projSessions={projSessions} runningWs={runningWs}
        openProject={openProject} toggleProject={toggleProject} addProject={addProject} />

      <div className="main">
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
              <Composer
                draft={draft} setDraft={setDraft} running={running} stopping={stopping} submit={submit} requestStop={requestStop}
                slashActive={slashActive} slashMatches={slashMatches} commands={commands} slashSel={slashSel} setSlashSel={setSlashSel}
                setSlashDismissed={setSlashDismissed} onRunSlash={runSlash} pop={pop} setPop={setPop} q={q}
                modeLabel={modeLabel} execMode={execMode} effort={effort} info={info} branches={branches}
                endpointModels={endpointModels} modelsLoading={modelsLoading} setModelsLoading={setModelsLoading}
                modelChoices={modelChoices} modelScope={modelScope} setModelScope={setModelScope}
                hasConversation={hasConversation} contextUsage={contextUsage} tokens={tokens} openSettings={openSettings} />
            } />

          {/* DESK-5h — Environment as a LAYOUT COLUMN: the chat reflows next
              to it; it can never cover content. Yields via envRoom. */}
          <EnvironmentPanel envAnim={envAnim} openSettings={openSettings} gitInfo={gitInfo} ensurePanel={ensurePanel}
            setTermDockOpen={setTermDockOpen} branches={branches} q={q} commitSubjects={commitSubjects} ci={ci}
            openCiPanel={openCiPanel} lastTurnFails={lastTurnFails} activeSessionTasks={activeSessionTasks} openTask={openTask} />

          <ViewsRail sideAnim={sideAnim} sideWidth={sideWidth} setSideWidth={setSideWidth} setSidePanelOpen={setSidePanelOpen}
            activeSideTab={activeSideTab} sideTabs={sideTabs} setActiveSideTab={setActiveSideTab} closeSideTab={closeSideTab}
            pop={pop} setPop={setPop} ensurePanel={ensurePanel} openBottomDock={openBottomDock} tabTitle={tabTitle}
            renderPanelBody={renderPanelBody} openSideView={openSideView} lastPlan={lastPlan} changedFiles={changedFiles}
            activeSessionTasks={activeSessionTasks} fleet={fleet} toolLog={toolLog} schedules={schedules}
            worktrees={worktrees} review={review} ci={ci} />
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
