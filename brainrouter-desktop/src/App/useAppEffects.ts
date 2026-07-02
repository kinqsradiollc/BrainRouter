/**
 * App shell — the shell's standalone side effects: host polling (fleet, global
 * dashboard, schedules, Track auto-refresh, context ring), event listeners
 * (git wake/poll, keyboard shortcuts, Esc-to-close drawer, before-unload),
 * localStorage persistence (chat width, rail, env, theme, accent, code font),
 * and small document-level bindings. Extracted from App.tsx verbatim; each
 * effect keeps its original deps and body, so behavior is unchanged.
 */
import { useEffect, useRef } from 'react';
import type React from 'react';
import { hostQuery } from '../lib/hostQuery.js';
import { detectOS, captureCombo } from '../lib/shortcuts/shortcuts.js';
import { saveExpandedProjects } from '../lib/session/expandedProjectsStore.js';
import { GIT_VISIBLE_POLL_MS, gitPollRefreshDue, gitRefreshDue } from '../lib/git/gitFreshness.js';
import type { WorkspaceDash } from '../lib/workspace/dashboard.js';
import type { PanelId } from '../panels/index.js';
import type { SessionRow, TaskViewState, WorkflowDetail } from '../types.js';
import type { ProjectSessionsByRoot } from '../lib/session/projectSessionsView.js';
import type { SettingsSection } from '../lib/commands/commands.js';

type Query = (id: string, name: string, args?: Record<string, unknown>) => void;

export interface AppEffectsCtx {
  q: Query;
  settingsOpen: boolean;
  mode: 'chat' | 'track' | 'code';
  info: { workspaceRoot?: string; sessionKey?: string };
  hostUp: boolean;
  refreshGit: () => void;
  editorAnyDirty: boolean;
  running: boolean;
  lastPlan: { items: Array<{ step: string }> } | null;
  activeSideTab: PanelId | null;
  setGlobalBoards: React.Dispatch<React.SetStateAction<WorkspaceDash[] | null>>;
  setWorkspaces: React.Dispatch<React.SetStateAction<{ current: string | null; recents: string[] }>>;
  setProjSessions: React.Dispatch<React.SetStateAction<ProjectSessionsByRoot>>;
  taskView: TaskViewState | null;
  workflowView: WorkflowDetail | null;
  cardOpenRef: React.MutableRefObject<boolean>;
  setTaskView: React.Dispatch<React.SetStateAction<TaskViewState | null>>;
  setWorkflowView: React.Dispatch<React.SetStateAction<WorkflowDetail | null>>;
  viewKey: string;
  chatWidth: string;
  chatSize: string;
  toast: string;
  setToast: (t: string) => void;
  envOpen: boolean;
  railWidth: number;
  railOpen: boolean;
  expandedProjects: string[];
  workrowRef: React.RefObject<HTMLDivElement>;
  setWorkW: (w: number) => void;
  setPaletteOpen: React.Dispatch<React.SetStateAction<boolean>>;
  togglePanel: (id: PanelId) => void;
  setSideFullScreen: React.Dispatch<React.SetStateAction<boolean>>;
  setSidePanelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setTermDockOpen: React.Dispatch<React.SetStateAction<boolean>>;
  openSettings: (section: SettingsSection) => void;
  sessionsRef: React.MutableRefObject<SessionRow[]>;
  resumeSessionRef: React.MutableRefObject<(key: string) => void>;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  sidePanelOpen: boolean;
  sidePinned: boolean;
  codeFont: string;
  theme: string;
  accent: string;
}

export function useAppEffects(ctx: AppEffectsCtx): void {
  const {
    q, settingsOpen, mode, info, hostUp, refreshGit, editorAnyDirty, running, lastPlan, activeSideTab,
    setGlobalBoards, setWorkspaces, setProjSessions, taskView, workflowView, cardOpenRef, setTaskView,
    setWorkflowView, viewKey, chatWidth, chatSize, toast, setToast, envOpen, railWidth, railOpen,
    expandedProjects, workrowRef, setWorkW, setPaletteOpen, togglePanel, setSideFullScreen, setSidePanelOpen,
    setTermDockOpen, openSettings, sessionsRef, resumeSessionRef, zoomIn, zoomOut, resetZoom, sidePanelOpen,
    sidePinned, codeFont, theme, accent,
  } = ctx;

  // Fetch the tool enable/disable catalog (built-in + connected MCP tools) when
  // Settings opens, so the Tools section can render a toggle per tool.
  useEffect(() => {
    if (settingsOpen) q('q-toolcat', 'tool-catalog');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsOpen]);

  // Track mode — fetch the project + work items on entering Track or switching
  // workspace; mutations return the updated list (handled in useAgentEvents).
  useEffect(() => {
    if (mode !== 'track') return;
    q('q-track-project', 'track-project');
    q('q-track-items', 'track-items');
    q('q-track-sprints', 'track-sprints');
    q('q-track-modules', 'track-modules');
    q('q-track-views', 'track-views');
    q('q-track-automations', 'track-automations');
    q('q-track-members', 'track-members');
    q('q-track-sync-config', 'track-sync-config');
    q('q-track-git-context', 'track-git-context');
    q('q-track-pr-status', 'track-pr-status');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, info.workspaceRoot]);

  // Auto-refresh Track every 25s while it's open, so board items, sync state,
  // git context, and PR status reflect external changes (commits, GitHub) on
  // their own — no manual Refresh. Quiet + flicker-free: results replace state
  // in useAgentEvents, and identical data produces no DOM change.
  useEffect(() => {
    if (mode !== 'track') return;
    const t = window.setInterval(() => {
      q('q-track-items', 'track-items');
      q('q-track-sync-config', 'track-sync-config');
      q('q-track-git-context', 'track-git-context');
      q('q-track-pr-status', 'track-pr-status');
    }, 25_000);
    return () => window.clearInterval(t);
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

  // T5 — warn before a reload/close drops unsaved editor changes.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => { if (editorAnyDirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [editorAnyDirty]);

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

  useEffect(() => {
    if (!running) return;
    // DESK-5r — context ring: lastSeenPromptTokens grows after each LLM call
    // within the turn, so polling shows context fill rise live. (The elapsed
    // timer is now self-contained in <WorkElapsed/>, so no app-wide tick here.)
    const fp = setInterval(() => { q('q-ctx', 'context-usage'); }, 2000);
    q('q-ctx', 'context-usage'); // immediate, don't wait the first interval
    return () => { clearInterval(fp); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    const sig = (lastPlan?.items ?? []).map((it) => it.step).join('');
    if (sig && sig !== planSigRef.current) {
      planSigRef.current = sig;
      // small delay so core has flushed recordPlanDecision before we read.
      const t = setTimeout(() => q('q-plan-history', 'plan-history'), 200);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastPlan]);

  // The Worktrees panel only fetched on its FIRST open (ensurePanel). Switching
  // back to an already-open tab (or restoring it in full-screen) left the list
  // at its stale empty state → "No worktrees" even when the repo has some.
  // Re-read whenever it becomes the active side tab, or the workspace changes.
  useEffect(() => {
    if (activeSideTab === 'worktrees') q('q-worktrees', 'git-worktrees');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSideTab, info.workspaceRoot]);

  // DESK-5w — keep the per-session background-task list fresh even when the
  // VIEWED chat is idle: another chat may be running work whose tasks should
  // appear/clear in the sidebar (and reflect the boot-time stale reconcile).
  useEffect(() => {
    const tick = (): void => { q('q-fleet', 'fleet'); q('q-tasks-recent', 'tasks-list', { scope: 'workspace', status: 'all' }); };
    const t = setInterval(tick, 3000);
    tick();
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // T14 — keep the Schedules panel fresh (cheap store read) so nextRun/lastRun
  // tick and another head's /schedule edits show up.
  useEffect(() => {
    const t = setInterval(() => q('q-schedule', 'schedule-list'), 5000);
    q('q-schedule', 'schedule-list');
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  useEffect(() => { cardOpenRef.current = !!(taskView || workflowView); }, [taskView, workflowView, cardOpenRef]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // §5.9 — user shortcut overrides (cli.shortcuts), read once; dispatched
  // ADDITIVELY below (an override fires its action; the built-in defaults stay).
  const shortcutOverridesRef = useRef<Record<string, string>>({});
  useEffect(() => { void hostQuery<{ overrides?: Record<string, string> }>('shortcuts-get').then((r) => { if (r?.overrides) shortcutOverridesRef.current = r.overrides; }); }, []);

  useEffect(() => {
    const os = detectOS();
    // App-action map for the registry ids that have a handler here.
    const ACTIONS: Record<string, () => void> = {
      palette: () => setPaletteOpen((p) => !p),
      'panel-diff': () => togglePanel('diff'),
      'panel-files': () => togglePanel('files'),
      'panel-files-alt': () => togglePanel('files'),
      'panel-plan': () => togglePanel('plan'),
      'panel-fullscreen': () => { setSideFullScreen((v) => !v); setSidePanelOpen(true); },
      terminal: () => setTermDockOpen((o) => !o),
      settings: () => openSettings('general'),
    };
    const h = (e: KeyboardEvent) => {
      // §5.9 — honour a user override first (additive: matches only when set).
      const overrides = shortcutOverridesRef.current;
      if (Object.keys(overrides).length) {
        const pressed = captureCombo(e, os);
        if (pressed) {
          for (const id in overrides) {
            if (overrides[id] === pressed && ACTIONS[id]) { e.preventDefault(); ACTIONS[id](); return; }
          }
        }
      }
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
      // Zoom shortcuts
      if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomIn(); }
      if (mod && e.key === '-') { e.preventDefault(); zoomOut(); }
      if (mod && e.key === '0') { e.preventDefault(); resetZoom(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // §panel-drawer — Esc closes the drawer (only when unpinned). Skipped while
  // focus is in the composer / an input, where Esc has its own meaning (e.g.
  // stopping a turn) so a quick Esc there never also dismisses the panel.
  useEffect(() => {
    if (!sidePanelOpen || sidePinned) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const ae = document.activeElement as HTMLElement | null;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.closest('.composer'))) return;
      setSidePanelOpen(false);
    };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [sidePanelOpen, sidePinned, setSidePanelOpen]);

  useEffect(() => {
    document.documentElement.style.setProperty('--mono',
      codeFont.trim() ? `"${codeFont.trim()}", "SF Mono", Consolas, monospace` : '"SF Mono", "Cascadia Code", "JetBrains Mono", Consolas, monospace');
    localStorage.setItem('br-code-font', codeFont);
  }, [codeFont]);

  useEffect(() => {
    // DESK-5m — mark macOS so the rail can reserve the traffic-light strip
    // (the frameless hiddenInset window puts the lights over the top-left).
    // §shortcuts — expose the OS (mac/windows/linux) so CSS and the shortcut
    // formatter render platform-correct keys (was mac-only for the traffic lights).
    document.documentElement.dataset.os = detectOS();
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
}
