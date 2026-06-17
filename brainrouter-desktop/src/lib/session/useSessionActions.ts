/**
 * T4 — session/workspace/panel ACTION functions extracted verbatim from App.tsx.
 *
 * These are the imperative handlers that do NOT depend on the command catalog
 * (`commands`/`cmdCtx`/`runCommand`, which are defined later in App): session
 * refresh, resume/fork/delete/rename, project switching + trust, the ⋮ menu
 * actions, file/settings/dashboard openers, and the stop/interaction handlers.
 * Everything they touch is injected via `SessionActionsCtx`; the App calls this
 * once and destructures every symbol back so existing references keep compiling.
 */
import { useRef } from 'react';
import type { InteractionRequest } from '@kinqs/brainrouter-agent-protocol';
import type { ChatRow, SessionRow, FleetRow, WorkflowDetail } from '../../types.js';
import type { SettingsSection } from '../commands/commands.js';
import type { WorkspaceDash } from '../workspace/dashboard.js';
import type { EditorApi } from '../editor/useEditor.js';
import type { CiApi } from '../ci/useCi.js';
import { rid } from '../rid.js';

export interface SessionActionsCtx {
  q: (id: string, name: string, args?: Record<string, unknown>) => void;
  // session state
  running: boolean;
  stopping: boolean;
  interaction: InteractionRequest | null;
  renamingKey: string | null;
  renameDraft: string;
  workspaces: { current: string | null; recents: string[] };
  info: { sessionKey?: string; model?: string; workspaceRoot?: string; username?: string };
  projSessions: Record<string, SessionRow[]>;
  runningSessionsRef: React.MutableRefObject<Set<string>>;
  sessionKeyRef: React.MutableRefObject<string | undefined>;
  pendingResumeRef: React.MutableRefObject<string | null>;
  workspaceGenRef: React.MutableRefObject<number>;
  expandedProjectsRef: React.MutableRefObject<string[]>;
  liveBuf: React.MutableRefObject<string>;
  chatRef: React.RefObject<HTMLDivElement>;
  atBottomRef: React.MutableRefObject<boolean>;
  // setters
  setStopping: React.Dispatch<React.SetStateAction<boolean>>;
  setStatusLine: React.Dispatch<React.SetStateAction<string>>;
  setReasoningTail: React.Dispatch<React.SetStateAction<string>>;
  setLiveText: React.Dispatch<React.SetStateAction<string>>;
  setRows: React.Dispatch<React.SetStateAction<ChatRow[]>>;
  setRunning: React.Dispatch<React.SetStateAction<boolean>>;
  setInteraction: React.Dispatch<React.SetStateAction<InteractionRequest | null>>;
  setSearchHits: React.Dispatch<React.SetStateAction<import('../../panels/index.js').SearchHit[] | null>>;
  setViewKey: React.Dispatch<React.SetStateAction<string>>;
  setTaskView: React.Dispatch<React.SetStateAction<{ id: string; kind: string; role?: string; goal?: string; status?: string; parentSessionKey?: string | null; rows: ChatRow[] } | null>>;
  setWorkflowView: React.Dispatch<React.SetStateAction<WorkflowDetail | null>>;
  setWorkspaces: React.Dispatch<React.SetStateAction<{ current: string | null; recents: string[] }>>;
  setExpandedProjects: React.Dispatch<React.SetStateAction<string[]>>;
  setTrustAsk: React.Dispatch<React.SetStateAction<{ root: string; resume?: string } | null>>;
  setHostUp: React.Dispatch<React.SetStateAction<boolean>>;
  setGitInfo: React.Dispatch<React.SetStateAction<{ repo: string; branch: string | null; insertions: number; deletions: number; gitRoot?: string | null; repoRelativePath?: string; isSubdir?: boolean } | null>>;
  setPrInfo: React.Dispatch<React.SetStateAction<{ number: number; state: string; title?: string } | null>>;
  setBranches: React.Dispatch<React.SetStateAction<{ current: string | null; branches: string[]; loading?: boolean }>>;
  setChangedFiles: React.Dispatch<React.SetStateAction<Array<{ status: string; path: string }>>>;
  setAllFiles: React.Dispatch<React.SetStateAction<string[]>>;
  setFileView: React.Dispatch<React.SetStateAction<{ path: string; content: string; error?: string } | null>>;
  setDiffView: React.Dispatch<React.SetStateAction<{ path: string; diff: string } | null>>;
  setTokens: React.Dispatch<React.SetStateAction<{ promptTokens: number; completionTokens: number; turns: number } | null>>;
  setGateBlock: React.Dispatch<React.SetStateAction<{ kind: 'commit' | 'push'; msg?: string; reason: string; status: string } | null>>;
  setLastPlan: React.Dispatch<React.SetStateAction<{ items: import('../../types.js').PlanItem[]; explanation?: string } | null>>;
  setFleet: React.Dispatch<React.SetStateAction<FleetRow[]>>;
  setLiveChildren: React.Dispatch<React.SetStateAction<Record<string, { childId: string; role: string; tool?: string; startedAt: number }>>>;
  setCommitSubjects: React.Dispatch<React.SetStateAction<string[]>>;
  setToast: React.Dispatch<React.SetStateAction<string>>;
  setProjSessions: React.Dispatch<React.SetStateAction<Record<string, SessionRow[]>>>;
  setSettings: React.Dispatch<React.SetStateAction<{ open: boolean; section: SettingsSection }>>;
  setSessionMenu: React.Dispatch<React.SetStateAction<{ key: string; x: number; y: number } | null>>;
  setRenamingKey: React.Dispatch<React.SetStateAction<string | null>>;
  setRenameDraft: React.Dispatch<React.SetStateAction<string>>;
  setDashBusy: React.Dispatch<React.SetStateAction<boolean>>;
  setGlobalBoards: React.Dispatch<React.SetStateAction<WorkspaceDash[] | null>>;
  pendingGitRef: React.MutableRefObject<{ kind: 'commit' | 'push'; msg?: string; root: string } | null>;
  // collaborators
  ensurePanel: (id: import('../../panels/index.js').PanelId) => void;
  resetTermDock: () => void;
  editor: EditorApi;
  ci: CiApi;
}

export interface SessionActions {
  refreshSession: () => void;
  refreshSidebar: () => void;
  refreshGit: () => void;
  resumeSession: (key: string) => void;
  resumeSessionRef: React.MutableRefObject<(key: string) => void>;
  resumeTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  openTask: (f: FleetRow) => void;
  openWorkflow: (slug: string) => void;
  viewToTop: () => void;
  answerInteraction: (response: { type: 'confirm'; approved: boolean } | { type: 'choice'; labels: string[] } | { type: 'dismissed' }) => void;
  requestStop: () => void;
  switchToWorkspace: (root: string, resumeKey?: string) => void;
  openProject: (root: string, resumeKey?: string) => void;
  addProject: () => void;
  toggleProject: (root: string) => void;
  openSettings: (section: SettingsSection) => void;
  openFile: (path: string) => void;
  closeEditorTab: (path: string) => void;
  openUrl: (url: string) => void;
  openCiPanel: () => void;
  refreshDashboard: () => void;
  openDashboard: () => void;
  closeSessionMenu: () => void;
  setMeta: (key: string, patch: Record<string, unknown>) => void;
  togglePin: (s: SessionRow) => void;
  toggleComplete: (s: SessionRow) => void;
  toggleArchive: (s: SessionRow) => void;
  moveToGroup: (key: string, group: string | null) => void;
  startRename: (s: SessionRow) => void;
  commitRename: () => void;
  forkSessionAction: (key: string, upToTs?: number) => void;
  deleteSessionAction: (key: string) => void;
  openExternal: (what: string) => void;
  openSessionMenu: (e: React.MouseEvent, key: string) => void;
}

export function useSessionActions(ctx: SessionActionsCtx): SessionActions {
  const {
    q, running, stopping, interaction, renamingKey, renameDraft, workspaces, info, projSessions,
    runningSessionsRef, sessionKeyRef, pendingResumeRef, workspaceGenRef, expandedProjectsRef,
    liveBuf, chatRef, atBottomRef,
    setStopping, setStatusLine, setReasoningTail, setLiveText, setRows, setRunning, setInteraction,
    setSearchHits, setViewKey, setTaskView, setWorkflowView, setWorkspaces, setExpandedProjects, setTrustAsk,
    setHostUp, setGitInfo, setPrInfo, setBranches, setChangedFiles, setAllFiles, setFileView, setDiffView,
    setTokens, setGateBlock, setLastPlan, setFleet, setLiveChildren, setCommitSubjects, setToast,
    setProjSessions, setSettings, setSessionMenu, setRenamingKey, setRenameDraft, setDashBusy, setGlobalBoards,
    pendingGitRef, ensurePanel, resetTermDock, editor, ci,
  } = ctx;

  // DESK-6t — debounce rapid session clicks: only the LAST target resumes.
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stable handle so the mount-once keyboard handler always calls the latest one.
  const resumeSessionRef = useRef<(key: string) => void>(() => {});

  const openUrl = (url: string): void => { if (url) q('q-open-url', 'action:open-external', { url }); };
  const openCiPanel = (): void => { ensurePanel('ci'); ci.refresh(); };

  const refreshDashboard = (): void => {
    if (!window.brainrouter.globalDashboard) return;
    setDashBusy(true);
    window.brainrouter.globalDashboard()
      .then((r) => setGlobalBoards((r.workspaces ?? []) as unknown as WorkspaceDash[]))
      .catch(() => { /* gh/disk unreadable */ })
      .finally(() => setDashBusy(false));
  };
  const openDashboard = (): void => { ensurePanel('dashboard'); refreshDashboard(); };

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
    q('q-req', 'requirement-list'); // REQUIREMENT-RECORDS — cheap store read; refresh after a turn
    q('q-annot', 'annotation-list'); // ANNOTATION-RECORDS — cheap store read; refresh after a turn
    // Keep expanded project folders fresh (host caches make this cheap).
    for (const root of expandedProjectsRef.current) q(`q-wsess:${root}`, 'workspace-sessions', { root });
  }
  // Git/workspace state is LIVE, not durable — re-read just the git surfaces
  // (branch, changes, last commit, PR) without the heavier session/list refresh.
  // Fired when the window regains focus so an external `git checkout` (another
  // terminal) is reflected instead of showing a stale branch.
  function refreshGit(): void {
    q('q-git', 'git-info');
    q('q-branches', 'git-branches');
    q('q-files', 'changed-files');
    q('q-gitlog', 'git-log');
    q('q-pr', 'git-pr');
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

  return {
    refreshSession, refreshSidebar, refreshGit, resumeSession, resumeSessionRef, resumeTimerRef,
    openTask, openWorkflow, viewToTop, answerInteraction, requestStop,
    switchToWorkspace, openProject, addProject, toggleProject,
    openSettings, openFile, closeEditorTab, openUrl, openCiPanel, refreshDashboard, openDashboard,
    closeSessionMenu, setMeta, togglePin, toggleComplete, toggleArchive, moveToGroup,
    startRename, commitRename, forkSessionAction, deleteSessionAction, openExternal, openSessionMenu,
  };
}
