/**
 * DESK-3b/4a/5d — Electron main: ONE window whose host process is swapped
 * in place when the user switches projects (Codex-style — no window per
 * workspace), a native folder picker that only PICKS (the renderer runs the
 * trust gate before anything opens), and a persisted recent-workspaces list.
 * Security posture unchanged: contextIsolation on, typed preload only,
 * senderFrame + shape validation on every inbound command.
 */
import { app, BrowserWindow, dialog, ipcMain, shell, utilityProcess, type UtilityProcess } from 'electron';
// Connector Phase 2 — OAuth device flow + keychain secrets live in MAIN
// (safeStorage is unavailable in a utilityProcess); hosts read over the port.
import { requestDeviceCode, pollOnce, type DeviceCodeGrant } from './githubOauth.js';
import { getSecret, setSecret, deleteSecret, hasSecret, secretStorageMode } from './secretStore.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAgentCommand } from '@kinqs/brainrouter-agent-protocol';
import { isWorkspaceTrusted, trustWorkspace, untrustWorkspace, listTrustedWorkspaces } from '@kinqs/brainrouter-core/workspace';
import { listTranscripts, type TranscriptSummary } from '@kinqs/brainrouter-core/session';
import { getStateDir } from '@kinqs/brainrouter-core/storage';
// T1 — global dashboard disk reads (no live host needed): running tasks + last
// review gate per recent workspace.
import { collectDashboardTasks } from '@kinqs/brainrouter-core/background';
import { pidAlive, reconcileStaleBackgroundTasks } from '@kinqs/brainrouter-core/background';
import { reconcileBackgroundTasks } from '@kinqs/brainrouter-core/background';
import { recordTelemetry } from '@kinqs/brainrouter-core/telemetry';
import { TELEMETRY_EVENTS } from '@kinqs/brainrouter-core/telemetry';
import { getLatestReview } from '@kinqs/brainrouter-core/review';
import { reviewGate } from '@kinqs/brainrouter-core/review';
import { loadConfig, saveConfig, _resetCliKnobsCache } from '@kinqs/brainrouter-core/config';
import type { ComputerUseAction } from '@kinqs/brainrouter-agent-protocol';
import {
  emptyPool, planActivate, applyActivate, setRunning, removeEntry,
  type HostPoolState,
} from './hostPoolPolicy.js';
import { isAllowedNavigation, allowedOriginFor } from './windowSecurity.js';
import { addOpened, noteActivity, reorderWorkspace, type ActivityReason } from './recents.js';
import { createComputerUsePort } from './computerUse.js';
import { checkComputerUsePermissions, openAccessibilitySettings, openScreenRecordingSettings } from './computerUsePermissions.js';
import { setupTray } from './tray.js';
import { hardenWebviewPreferences, isAllowedWebviewSrc } from './webviewPolicy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function reconcileWorkspaceBackground(workspaceRoot: string): void {
  try { reconcileStaleBackgroundTasks(workspaceRoot, pidAlive); } catch { /* best-effort */ }
  try { reconcileBackgroundTasks(workspaceRoot, pidAlive); } catch { /* best-effort */ }
}

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
type WorkspaceSessionRow = TranscriptSummary & { lastRole?: string };
type WorkspaceSessionsResult = { rows: WorkspaceSessionRow[]; truncated?: boolean; error?: string };
const WORKSPACE_SESSIONS_CACHE_MS = 30_000;
const workspaceSessionsCache = new Map<string, { at: number; limit: number; rows: WorkspaceSessionRow[] }>();

type ComputerUseRequest =
  | { kind: 'computer-use-request'; id: string; op: 'screenshot' }
  | { kind: 'computer-use-request'; id: string; op: 'act'; action: ComputerUseAction };

function isComputerUseRequest(value: unknown): value is ComputerUseRequest {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v.kind === 'computer-use-request' && typeof v.id === 'string' && (v.op === 'screenshot' || v.op === 'act');
}

async function handleComputerUseRequest(wp: WinPool, host: UtilityProcess, request: ComputerUseRequest): Promise<void> {
  const port = createComputerUsePort(() => wp.win);
  try {
    const result = request.op === 'screenshot'
      ? await port.screenshot()
      : await port.act(request.action);
    host.postMessage({ kind: 'computer-use-response', id: request.id, ok: true, result });
  } catch (err) {
    host.postMessage({ kind: 'computer-use-response', id: request.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

// ── Connector Phase 2: keychain secrets (host → main) ─────────────────────────
// safeStorage only exists in the main process; the agent host requests values
// over its parent port (mirroring the computer-use bridge). Account sign-in is
// also hosted, so its two bounded account credentials may be set/deleted here.

type SecretRequest =
  | { kind: 'secret-request'; id: string; op: 'get'; key: string }
  | { kind: 'secret-request'; id: string; op: 'set'; key: string; value: string }
  | { kind: 'secret-request'; id: string; op: 'delete'; key: string };

const HOST_WRITABLE_ACCOUNT_SECRETS = new Set(['account:access-token', 'account:refresh-token']);

function isSecretRequest(value: unknown): value is SecretRequest {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.kind !== 'secret-request' || typeof v.id !== 'string' || typeof v.key !== 'string') return false;
  if (v.op === 'get' || v.op === 'delete') return true;
  return v.op === 'set' && typeof v.value === 'string';
}

function handleSecretRequest(host: UtilityProcess, request: SecretRequest): void {
  try {
    if (request.op === 'get') {
      const value = getSecret(app.getPath('userData'), request.key);
      host.postMessage({ kind: 'secret-response', id: request.id, ok: true, value });
      return;
    }
    if (!HOST_WRITABLE_ACCOUNT_SECRETS.has(request.key)) throw new Error('Host secret write is not allowed for this key.');
    if (request.op === 'delete') {
      deleteSecret(app.getPath('userData'), request.key);
      host.postMessage({ kind: 'secret-response', id: request.id, ok: true });
      return;
    }
    if (secretStorageMode() !== 'keychain') throw new Error('OS-protected credential storage is unavailable on this device.');
    setSecret(app.getPath('userData'), request.key, request.value);
    host.postMessage({ kind: 'secret-response', id: request.id, ok: true });
  } catch (err) {
    host.postMessage({ kind: 'secret-response', id: request.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

// ── Connector Phase 2: GitHub OAuth device flow (renderer-invoked) ────────────
// One pending grant per connector. The renderer drives the poll cadence with
// the interval we return; the token never leaves the main process — on success
// it goes straight into the keychain-backed secret store.
const pendingOauthGrants = new Map<string, { clientId: string; grant: DeviceCodeGrant }>();

async function handleGhOauth(payload: { op?: string; connectorId?: string; clientId?: string }): Promise<Record<string, unknown>> {
  const connectorId = typeof payload.connectorId === 'string' ? payload.connectorId : '';
  if (!connectorId) return { error: 'connectorId is required.' };
  const secretKey = `connector:${connectorId}:github-oauth`;
  switch (payload.op) {
    case 'start': {
      const clientId = typeof payload.clientId === 'string' ? payload.clientId.trim() : '';
      if (!clientId) return { error: 'No OAuth client id configured. Set cli.github.oauthClientId in Settings → Advanced (register a GitHub OAuth App with device flow enabled).' };
      try {
        const grant = await requestDeviceCode(clientId);
        pendingOauthGrants.set(connectorId, { clientId, grant });
        void shell.openExternal(grant.verificationUri).catch(() => { /* headless — the renderer shows the URL */ });
        return { userCode: grant.userCode, verificationUri: grant.verificationUri, intervalSec: grant.intervalSec, expiresAtMs: grant.expiresAtMs };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }
    case 'poll': {
      const entry = pendingOauthGrants.get(connectorId);
      if (!entry) return { status: 'error', error: 'No authorization in progress for this connector.' };
      const result = await pollOnce(entry.clientId, entry.grant, {});
      if (result.status === 'pending') {
        entry.grant.intervalSec = result.nextIntervalSec;
        return { status: 'pending', nextIntervalSec: result.nextIntervalSec, expiresAtMs: entry.grant.expiresAtMs };
      }
      pendingOauthGrants.delete(connectorId);
      if (result.status === 'authorized') {
        const stored = setSecret(app.getPath('userData'), secretKey, result.accessToken);
        return { status: 'authorized', scope: result.scope, storageMode: stored.mode };
      }
      if (result.status === 'error') return { status: 'error', error: result.message };
      return { status: result.status };
    }
    case 'cancel':
      pendingOauthGrants.delete(connectorId);
      return { ok: true };
    case 'disconnect':
      pendingOauthGrants.delete(connectorId);
      deleteSecret(app.getPath('userData'), secretKey);
      return { ok: true };
    case 'status':
      return { hasToken: hasSecret(app.getPath('userData'), secretKey), storageMode: secretStorageMode() };
    default:
      return { error: `Unknown gh-oauth op "${String(payload.op)}".` };
  }
}

function readRecents(): string[] {
  try { return JSON.parse(fs.readFileSync(recentsPath(), 'utf-8')) as string[]; } catch { return []; }
}
function writeRecents(next: string[]): void {
  try { fs.mkdirSync(path.dirname(recentsPath()), { recursive: true }); fs.writeFileSync(recentsPath(), JSON.stringify(next, null, 2)); } catch { /* best-effort */ }
}

function transcriptPathForSummary(root: string, s: TranscriptSummary): string {
  return s.sessionDir
    ? path.join(s.sessionDir, s.fileName)
    : path.join(getStateDir(root), 'transcripts', s.fileName);
}

function lastTranscriptRole(filePath: string): 'user' | 'assistant' | undefined {
  try {
    const fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 16_384);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const lines = buf.toString('utf-8').split('\n').filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const e = JSON.parse(lines[i]) as { role?: string; name?: string };
        if (e.role === 'assistant') return 'assistant';
        if (e.role === 'user' && !e.name) return 'user';
      } catch { /* the tail window may start mid-line */ }
    }
  } catch { /* unreadable */ }
  return undefined;
}

function readWorkspaceSessions(root: string, limit: number): WorkspaceSessionsResult {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(120, Math.floor(limit))) : 80;
  if (!root || !fs.existsSync(root)) return { rows: [], error: 'Workspace is not available.' };
  const now = Date.now();
  const cached = workspaceSessionsCache.get(root);
  if (cached && now - cached.at < WORKSPACE_SESSIONS_CACHE_MS && cached.limit >= safeLimit) {
    return { rows: cached.rows.slice(0, safeLimit), truncated: cached.rows.length >= safeLimit };
  }
  try {
    const summaries = listTranscripts(root, { limit: safeLimit });
    const rows = summaries.map((s) => ({ ...s, lastRole: lastTranscriptRole(transcriptPathForSummary(root, s)) }));
    workspaceSessionsCache.set(root, { at: now, limit: safeLimit, rows });
    return { rows, truncated: rows.length >= safeLimit };
  } catch (err) {
    return { rows: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** Membership without promotion — opening/switching/viewing a project must not
 *  move it. Manual drag/drop is the only ordering operation. */
function markWorkspaceOpened(workspaceRoot: string): void {
  writeRecents(addOpened(readRecents(), workspaceRoot));
}
/** Record real activity without changing user-controlled project order. */
function markWorkspaceActivity(workspaceRoot: string, reason: ActivityReason): void {
  workspaceSessionsCache.delete(workspaceRoot);
  const next = noteActivity(readRecents(), workspaceRoot);
  writeRecents(next);
  for (const wp of wins.values()) {
    if (!wp.win.isDestroyed()) wp.win.webContents.send('recents-changed', { recents: next, reason, workspaceRoot });
  }
}

function markWorkspaceReordered(dragged: string, target: string): string[] {
  const next = reorderWorkspace(readRecents(), dragged, target);
  writeRecents(next);
  for (const wp of wins.values()) {
    if (!wp.win.isDestroyed()) wp.win.webContents.send('recents-changed', { recents: next, reason: 'manual-reorder', workspaceRoot: dragged });
  }
  return next;
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
    if (isComputerUseRequest(msg)) {
      void handleComputerUseRequest(wp, host, msg);
      return;
    }
    if (isSecretRequest(msg)) {
      handleSecretRequest(host, msg);
      return;
    }
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
    wp.hosts.delete(workspaceRoot);
    wp.pool = removeEntry(wp.pool, workspaceRoot);
    if (wp.retiring.delete(workspaceRoot)) return; // intentional reap/shutdown — not an error
    reconcileWorkspaceBackground(workspaceRoot);
    if (!wp.win.isDestroyed()) wp.win.webContents.send('agent-event', {
      seq: -1, ts: Date.now(), sessionKey: wp.lastSession.get(workspaceRoot) ?? 'host', workspaceRoot,
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
  // Activating/switching is membership only; it must not change the user's
  // project order.
  markWorkspaceOpened(workspaceRoot);
  // §6 — workspace-refresh telemetry (local-first, best-effort, never throws).
  try { recordTelemetry({ name: TELEMETRY_EVENTS.workspace_refresh, workspaceRoot, props: { mode: plan.mode } }); } catch { /* advisory */ }
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
    // Pin the macOS traffic lights so their centre (~y20) sits on the 40px
    // titlebar band's centre regardless of macOS version — keeps the top row
    // consistent instead of the lights floating in the top third.
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 16, y: 13 } } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // §3 D3 — allow <webview>, hardened + src-gated by the will-attach-webview
      // handler below. Used by the prototype preview AND the Browser panel, which
      // renders the workspace's running web app (e.g. http://localhost:5173) for
      // UI testing.
      webviewTag: true,
    },
  });

  // §3 D3 — secure-webview gate: harden every attached webview (no preload/node,
  // sandboxed, isolated) and restrict its src to a self-contained data:text/html
  // doc or an authorized prototype file under THIS workspace. Anything else is
  // refused. The policy is a pure, unit-tested helper (webviewPolicy.ts).
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    hardenWebviewPreferences(webPreferences as unknown as Record<string, unknown>);
    if (!isAllowedWebviewSrc(typeof params.src === 'string' ? params.src : '', workspaceRoot)) {
      event.preventDefault();
    }
  });
  // The attach gate only vets the INITIAL src. A guest's own loadURL()/link
  // click/redirect must be gated too, or the omnibox could navigate to a remote
  // origin or file:// outside the workspace (arbitrary local-file read). Re-apply
  // the same policy to every guest navigation, and deny guest window.open.
  win.webContents.on('did-attach-webview', (_event, guest) => {
    const gate = (e: { preventDefault: () => void }, url: string): void => {
      if (!isAllowedWebviewSrc(url, workspaceRoot)) e.preventDefault();
    };
    guest.on('will-navigate', gate);
    guest.on('will-redirect', gate);
    guest.setWindowOpenHandler(() => ({ action: 'deny' }));
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

// §5.8 — the tray instance, kept in module scope so V8 never GCs it (which would
// make the icon vanish). Assigned once the app is ready.
let tray: ReturnType<typeof setupTray> = null;

app.whenReady().then(() => {
  // T1 — the folder the app launched in is implicitly trusted (the user chose
  // it); every OTHER workspace must be trusted before main will open it.
  const launchRoot = process.env.BRAINROUTER_DESKTOP_WORKSPACE || readRecents()[0] || process.cwd();
  trustWorkspace(launchRoot);
  openWorkspaceWindow(launchRoot);

  // §5.8 — system tray: quick show/hide, a live recent-workspaces submenu, quit.
  // Held in module scope so it isn't garbage-collected; failure is non-fatal.
  tray = setupTray({
    recents: () => readRecents(),
    isWindowVisible: () => [...wins.values()].some((wp) => !wp.win.isDestroyed() && wp.win.isVisible()),
    toggleWindow: () => {
      const live = [...wins.values()].filter((wp) => !wp.win.isDestroyed());
      if (live.length === 0) { openWorkspaceWindow(readRecents()[0] || launchRoot); return; }
      const anyVisible = live.some((wp) => wp.win.isVisible());
      for (const wp of live) { if (anyVisible) wp.win.hide(); else { wp.win.show(); wp.win.focus(); } }
    },
    openWorkspace: (root) => { try { trustWorkspace(root); } catch { /* best-effort */ } openWorkspaceWindow(root); },
    quit: () => app.quit(),
  });

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
  ipcMain.handle('workspace:sessions', (_event, root: unknown, rawLimit: unknown) => {
    const limit = typeof rawLimit === 'number' ? rawLimit : Number(rawLimit ?? 80);
    return readWorkspaceSessions(typeof root === 'string' ? root : '', limit);
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
  // Open a workspace in a SEPARATE window — always a new (or focused existing)
  // window, NEVER swapping the calling window in place. Used for git worktrees:
  // opening a worktree must not mutate the current window's projects list,
  // active workspace, or chat. Trust is still enforced (defense-in-depth).
  ipcMain.handle('workspace:open-window', (_event, workspaceRoot: unknown) => {
    if (typeof workspaceRoot !== 'string' || !fs.existsSync(workspaceRoot)) return { opened: false };
    if (!isWorkspaceTrusted(workspaceRoot)) return { opened: false, needsTrust: true };
    openWorkspaceWindow(workspaceRoot);
    return { opened: true };
  });
  // T1 — trust persistence lives in the shared CLI store (not renderer
  // localStorage), so CLI + desktop agree and it survives reinstalls.
  ipcMain.handle('workspace:isTrusted', (_e, root: unknown) => ({ trusted: typeof root === 'string' && isWorkspaceTrusted(root) }));
  // Connector Phase 2 — GitHub OAuth device flow (start/poll/cancel/disconnect/
  // status). Tokens never reach the renderer; success writes the keychain store.
  ipcMain.handle('gh-oauth', (_e, payload: unknown) =>
    handleGhOauth((payload && typeof payload === 'object' ? payload : {}) as { op?: string; connectorId?: string; clientId?: string }));
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
      let tasks: ReturnType<typeof collectDashboardTasks> = [];
      // §3/fix 4 — include active work AND recent terminal/stale outcomes so
      // Dashboard is a real workspace operations view, not only a running list.
      try { reconcileWorkspaceBackground(workspaceRoot); tasks = collectDashboardTasks(workspaceRoot); } catch { /* unreadable workspace */ }
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
  // agent-event stream (commit / push / create-pr). Activity refreshes project
  // state and membership; explicit drag/drop is the only order change.
  ipcMain.handle('workspace:activity', (_e, root: unknown, reason: unknown) => {
    if (typeof root === 'string' && typeof reason === 'string') markWorkspaceActivity(root, reason as ActivityReason);
    return { ok: true };
  });
  ipcMain.handle('workspace:reorder', (_e, dragged: unknown, target: unknown) => {
    if (typeof dragged !== 'string' || typeof target !== 'string') return { recents: readRecents() };
    return { recents: markWorkspaceReordered(dragged, target) };
  });
  ipcMain.handle('computerUse:checkPermissions', () => checkComputerUsePermissions());
  ipcMain.handle('computerUse:openAccessibilitySettings', () => openAccessibilitySettings());
  ipcMain.handle('computerUse:openScreenRecordingSettings', () => openScreenRecordingSettings());
  ipcMain.handle('computerUse:setMode', (_e, raw: unknown) => {
    const next = raw && typeof raw === 'object' ? raw as { enabled?: unknown; mode?: unknown } : {};
    const cfg = loadConfig();
    cfg.cli = cfg.cli ?? {};
    const current = cfg.cli.computerUse ?? {};
    cfg.cli.computerUse = {
      enabled: typeof next.enabled === 'boolean' ? next.enabled : current.enabled,
      mode: typeof next.mode === 'string' && next.mode.trim() ? next.mode.trim() : current.mode,
    };
    saveConfig(cfg);
    _resetCliKnobsCache();
    return { ok: true, computerUse: cfg.cli.computerUse };
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
