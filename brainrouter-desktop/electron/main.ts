/**
 * DESK-3b/4a/5d — Electron main: ONE window whose host process is swapped
 * in place when the user switches projects (Codex-style — no window per
 * workspace), a native folder picker that only PICKS (the renderer runs the
 * trust gate before anything opens), and a persisted recent-workspaces list.
 * Security posture unchanged: contextIsolation on, typed preload only,
 * senderFrame + shape validation on every inbound command.
 */
import { app, BrowserWindow, dialog, ipcMain, utilityProcess, type UtilityProcess } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAgentCommand } from '@kinqs/brainrouter-agent-protocol';
import { isWorkspaceTrusted, trustWorkspace, untrustWorkspace, listTrustedWorkspaces } from '@kinqs/brainrouter-cli/dist/state/workspaceTrust.js';
// T1 — global dashboard disk reads (no live host needed): running tasks + last
// review gate per recent workspace.
import { collectRunningTasks } from '@kinqs/brainrouter-cli/dist/runtime/backgroundTasks.js';
import { getLatestReview } from '@kinqs/brainrouter-cli/dist/state/reviewStore.js';
import { reviewGate } from '@kinqs/brainrouter-cli/dist/orchestration/reviewModel.js';
import {
  emptyPool, planActivate, applyActivate, setRunning, removeEntry,
  type HostPoolState,
} from './hostPoolPolicy.js';
import { isAllowedNavigation, allowedOriginFor } from './windowSecurity.js';
import { addOpened, bumpActivity, type ActivityReason } from './recents.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Stability items 3 + 4 — a window keeps a POOL of agent hosts keyed by
 * workspaceRoot instead of a single host it kills on every switch. Switching
 * only changes which host is active; running work in other workspaces keeps
 * going in the background and is reaped only when idle past a TTL (see
 * hostPoolPolicy — the pure, unit-tested decision layer).
 */
interface WinPool {
  win: BrowserWindow;
  hosts: Map<string, UtilityProcess>; // workspaceRoot → live host process
  lastSession: Map<string, string>;   // workspaceRoot → its last-viewed sessionKey
  pool: HostPoolState;                 // pure lifecycle state (tested policy)
  retiring: Set<string>;               // roots whose host we're intentionally killing
}
const wins = new Map<number, WinPool>(); // webContents.id → WinPool

const recentsPath = (): string => path.join(app.getPath('userData'), 'recent-workspaces.json');
function readRecents(): string[] {
  try { return JSON.parse(fs.readFileSync(recentsPath(), 'utf-8')) as string[]; } catch { return []; }
}
function writeRecents(next: string[]): void {
  try { fs.mkdirSync(path.dirname(recentsPath()), { recursive: true }); fs.writeFileSync(recentsPath(), JSON.stringify(next, null, 2)); } catch { /* best-effort */ }
}
/** Membership without promotion — opening/switching/viewing a project must NOT
 *  move it to the top (only real activity does). */
function markWorkspaceOpened(workspaceRoot: string): void {
  writeRecents(addOpened(readRecents(), workspaceRoot));
}
/** Promote a workspace after REAL activity (a turn, output, commit/push/PR).
 *  Notifies open windows so the sidebar reorders live. */
function markWorkspaceActivity(workspaceRoot: string, reason: ActivityReason): void {
  const next = bumpActivity(readRecents(), workspaceRoot);
  writeRecents(next);
  for (const wp of wins.values()) {
    if (!wp.win.isDestroyed()) wp.win.webContents.send('recents-changed', { recents: next, reason, workspaceRoot });
  }
}

/** Fork an agent host for a workspace, pool it, and pipe its events into the
 *  window. Tags every event with the owning workspaceRoot (so the renderer
 *  keeps surfaces straight with multiple hosts live) and tracks turn-running
 *  state so a busy workspace is never reaped. */
function spawnHost(wp: WinPool, workspaceRoot: string): UtilityProcess {
  const host = utilityProcess.fork(path.join(__dirname, 'host.js'), [], {
    env: { ...process.env, BRAINROUTER_DESKTOP_WORKSPACE: workspaceRoot },
    serviceName: `brainrouter-agent-host:${path.basename(workspaceRoot)}`,
  });
  host.on('message', (msg) => {
    if (wp.win.isDestroyed()) return;
    if (msg && typeof msg === 'object') {
      const ev = (msg as { event?: { kind?: string; sessionKey?: string } }).event;
      const kind = ev?.kind;
      // Track work-in-flight so the pool never reaps a running workspace.
      if (kind === 'turn-start') { wp.pool = setRunning(wp.pool, workspaceRoot, true); markWorkspaceActivity(workspaceRoot, 'user-message'); }
      else if (kind === 'turn-complete' || kind === 'turn-error') { wp.pool = setRunning(wp.pool, workspaceRoot, false); markWorkspaceActivity(workspaceRoot, 'agent-response'); }
      // Real background work (a child/worker produced output) is activity too.
      else if (kind === 'child-tool-end' || kind === 'child-complete') markWorkspaceActivity(workspaceRoot, 'background-task');
      // Remember each workspace's last-viewed session so we can re-announce it
      // when the user switches back to a parked (reused) host.
      else if (kind === 'session-changed' && typeof ev?.sessionKey === 'string') wp.lastSession.set(workspaceRoot, ev.sessionKey);
    }
    const tagged = (msg && typeof msg === 'object') ? { ...(msg as object), workspaceRoot } : msg;
    wp.win.webContents.send('agent-event', tagged);
  });
  host.on('exit', (code) => {
    const wasActive = wp.pool.activeRoot === workspaceRoot;
    wp.hosts.delete(workspaceRoot);
    wp.pool = removeEntry(wp.pool, workspaceRoot);
    if (wp.retiring.delete(workspaceRoot)) return; // intentional reap/shutdown — not an error
    if (!wp.win.isDestroyed() && wasActive) wp.win.webContents.send('agent-event', {
      seq: -1, ts: Date.now(), sessionKey: 'host', workspaceRoot,
      event: { kind: 'turn-error', message: `Agent host exited (code ${code ?? 'unknown'}).` },
    });
  });
  wp.hosts.set(workspaceRoot, host);
  return host;
}

/** Gracefully retire a pooled host (idle reap, window close). Leaves the exit
 *  listener attached but flags the root as retiring, so its exit is silent. */
function retireHost(wp: WinPool, workspaceRoot: string): void {
  const host = wp.hosts.get(workspaceRoot);
  if (!host) return;
  wp.retiring.add(workspaceRoot);
  wp.hosts.delete(workspaceRoot);
  wp.lastSession.delete(workspaceRoot);
  try { host.postMessage({ kind: 'shutdown' }); } catch { /* already gone */ }
  setTimeout(() => { try { host.kill(); } catch { /* already exited */ } }, 1_500);
}

/**
 * Make `workspaceRoot` the active workspace in this window. Spawns a host if
 * none exists yet; otherwise REUSES the parked one (its background work is
 * intact). Idle, non-active, non-running hosts past their TTL are reaped. A
 * spawned host announces itself with a boot `session-changed`; a reused host is
 * nudged to re-announce its last session — so the renderer's reset contract is
 * identical to the old swap model, but running work never dies on a switch.
 */
function activateWorkspace(wp: WinPool, workspaceRoot: string): void {
  const now = Date.now();
  const plan = planActivate(wp.pool, workspaceRoot, now);
  for (const root of plan.reap) retireHost(wp, root);
  const wasActive = wp.pool.activeRoot;
  wp.pool = applyActivate(wp.pool, plan, now);
  if (plan.mode === 'spawn') {
    spawnHost(wp, workspaceRoot); // boots → emits session-changed (renderer resets)
  } else if (wasActive !== workspaceRoot) {
    // Reuse: the parked host won't re-announce on its own. Nudge it to re-emit
    // its current session-changed (idempotent for a pooled session — does NOT
    // disturb a running turn) so the renderer re-renders this workspace.
    const host = wp.hosts.get(workspaceRoot);
    const last = wp.lastSession.get(workspaceRoot);
    if (host && last) { try { host.postMessage({ kind: 'resume-session', sessionKey: last }); } catch { /* gone */ } }
  }
  wp.win.setTitle(`BrainRouter — ${path.basename(workspaceRoot)}`);
  // Activating/switching is "opened", NOT activity — it must not promote the
  // project to the top. Only real work (turn/output/commit) does that.
  markWorkspaceOpened(workspaceRoot);
}

function openWorkspaceWindow(workspaceRoot: string): void {
  // Focus an existing window that already hosts this workspace (active OR parked).
  for (const wp of wins.values()) {
    if (wp.pool.activeRoot === workspaceRoot || wp.hosts.has(workspaceRoot)) { wp.win.focus(); return; }
  }
  const win = new BrowserWindow({
    width: 1280, height: 840, minWidth: 900, minHeight: 600,
    title: `BrainRouter — ${path.basename(workspaceRoot)}`,
    backgroundColor: '#262624',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const wp: WinPool = { win, hosts: new Map(), lastSession: new Map(), pool: emptyPool(), retiring: new Set() };
  wins.set(win.webContents.id, wp);

  // SEC: deny all renderer-initiated window.open (target=_blank, window.open, etc.).
  // The renderer has no legitimate need to spawn a second BrowserWindow.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // SEC: block top-level navigation away from the app's own origin (phishing,
  // data:/javascript: payloads). Allowed: the packaged file:// load and, in dev,
  // the Vite dev origin. Policy is a pure, unit-tested helper.
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  const allowedOrigin = allowedOriginFor(devUrl);
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url, allowedOrigin)) event.preventDefault();
  });

  win.on('closed', () => {
    for (const [id, w] of wins) {
      if (w.win !== win) continue;
      for (const [root, host] of w.hosts) { w.retiring.add(root); try { host.postMessage({ kind: 'shutdown' }); } catch { /* gone */ } }
      wins.delete(id);
    }
  });
  activateWorkspace(wp, workspaceRoot); // spawns the first host
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

// DESK-5o — overlay scrollbars: thin, auto-hiding, and (crucially) reserving
// ZERO layout width, so a scrollable column never carves a hard 8px strip
// between it and its neighbor. This is what makes Codex/native apps look
// clean; classic Chromium scrollbars reserve space and draw a hard divider.
app.commandLine.appendSwitch('enable-features', 'OverlayScrollbar');

app.whenReady().then(() => {
  // T1 — the folder the app launched in is implicitly trusted (the user chose
  // it); every OTHER workspace must be trusted before main will open it.
  const launchRoot = process.env.BRAINROUTER_DESKTOP_WORKSPACE || readRecents()[0] || process.cwd();
  trustWorkspace(launchRoot);
  openWorkspaceWindow(launchRoot);

  ipcMain.on('agent-command', (event, raw: unknown) => {
    const wp = wins.get(event.sender.id);
    if (!wp || event.senderFrame !== wp.win.webContents.mainFrame) return;
    if (!isAgentCommand(raw)) return;
    // Route to the ACTIVE workspace's host; background hosts keep running untouched.
    const host = wp.pool.activeRoot ? wp.hosts.get(wp.pool.activeRoot) : undefined;
    host?.postMessage(raw);
  });

  // Workspace management — main-process concerns, separate channel from the
  // agent protocol. invoke/handle so the renderer gets results back.
  // DESK-5d — `add` only PICKS a folder; the renderer shows the trust dialog
  // first and then calls `open`, which swaps the host inside this window.
  ipcMain.handle('workspace:add', async (event) => {
    const wp = wins.get(event.sender.id);
    const res = await dialog.showOpenDialog(wp?.win ?? BrowserWindow.getFocusedWindow()!, {
      title: 'Add project folder', properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || res.filePaths.length === 0) return { opened: false };
    return { opened: false, workspaceRoot: res.filePaths[0] };
  });
  ipcMain.handle('workspace:recents', (event) => {
    const wp = wins.get(event.sender.id);
    return { current: wp?.pool.activeRoot ?? null, recents: readRecents() };
  });
  ipcMain.handle('workspace:open', (event, workspaceRoot: unknown) => {
    if (typeof workspaceRoot !== 'string' || !fs.existsSync(workspaceRoot)) return { opened: false };
    // T1 — main ENFORCES trust (defense-in-depth): even if the renderer gate is
    // bypassed, an untrusted workspace is never opened. The renderer asks, then
    // calls workspace:trust, then retries open.
    if (!isWorkspaceTrusted(workspaceRoot)) return { opened: false, needsTrust: true };
    const wp = wins.get(event.sender.id);
    if (wp) activateWorkspace(wp, workspaceRoot); // park the old host, don't kill running work
    else openWorkspaceWindow(workspaceRoot);
    return { opened: true };
  });
  // T1 — trust persistence lives in the shared CLI store (not renderer
  // localStorage), so CLI + desktop agree and it survives reinstalls.
  ipcMain.handle('workspace:isTrusted', (_e, root: unknown) => ({ trusted: typeof root === 'string' && isWorkspaceTrusted(root) }));
  ipcMain.handle('workspace:trust', (_e, root: unknown) => { if (typeof root === 'string') trustWorkspace(root); return { trusted: true }; });
  ipcMain.handle('workspace:untrust', (_e, root: unknown) => { if (typeof root === 'string') untrustWorkspace(root); return { trusted: false }; });
  ipcMain.handle('workspace:trustedList', () => ({ trusted: listTrustedWorkspaces() }));
  // T1 — cross-workspace dashboard. The per-workspace host can't see other
  // workspaces, so main disk-reads each recent root's running tasks + last
  // review gate (pure file reads; no live host needed). The review gate is the
  // LAST run's verdict (no per-workspace git diff — that would be too costly to
  // poll), so it reflects the workspace as of its last review.
  ipcMain.handle('dashboard:global', () => {
    const roots = readRecents();
    const workspaces = roots.map((workspaceRoot) => {
      let tasks: Array<{ kind: string; id: string; label: string; startedAt?: string; role?: string; worktree?: boolean }> = [];
      try { tasks = collectRunningTasks(workspaceRoot) as typeof tasks; } catch { /* unreadable workspace */ }
      let gate: { status: string; blocked: boolean; reason: string } | null = null;
      try {
        const run = getLatestReview(workspaceRoot);
        if (run) { const g = reviewGate(run, run.diffHash); gate = { status: g.status, blocked: g.blocked, reason: g.reason }; }
      } catch { /* no review */ }
      return { workspaceRoot, tasks: tasks.map((t) => ({ ...t, workspaceRoot })), reviewGate: gate };
    });
    return { workspaces };
  });
  // Wave 1/4 — the renderer reports real activity that main can't see on the
  // agent-event stream (commit / push / create-pr) so the project promotes.
  ipcMain.handle('workspace:activity', (_e, root: unknown, reason: unknown) => {
    if (typeof root === 'string' && typeof reason === 'string') markWorkspaceActivity(root, reason as ActivityReason);
    return { ok: true };
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      openWorkspaceWindow(readRecents()[0] || process.cwd());
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
