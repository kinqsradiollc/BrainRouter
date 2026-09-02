/**
 * DESK-3b/4a/5d — Electron main: ONE window whose host process is swapped
 * in place when the user switches projects (Codex-style — no window per
 * workspace), a native folder picker that only PICKS (the renderer runs the
 * trust gate before anything opens), and a persisted recent-workspaces list.
 * Security posture unchanged: contextIsolation on, typed preload only,
 * senderFrame + shape validation on every inbound command.
 */
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell, utilityProcess, type UtilityProcess } from 'electron';
// Connector Phase 2 — OAuth device flow + keychain secrets live in MAIN
// (safeStorage is unavailable in a utilityProcess); hosts read over the port.
import { requestDeviceCode, pollOnce, type DeviceCodeGrant } from './githubOauth.js';
import { getSecret, setSecret, deleteSecret, hasSecret, secretStorageMode } from './secretStore.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAgentCommand } from '@kinqs/brainrouter-agent-protocol';
import {
  isBrowserControlCancelMessage,
  isBrowserControlRequestMessage,
} from '@kinqs/brainrouter-core/browser';
import { isWorkspaceTrusted, trustWorkspace, untrustWorkspace, listTrustedWorkspaces } from '@kinqs/brainrouter-core/workspace';
import {
  getWorkspaceManifestInfo,
  previewWorkspaceOnboardingFromPayload,
  saveWorkspaceManifestFromPayload,
} from './workspaceOnboarding.js';
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
import { hardenWebviewPreferences, isAllowedArtifactWebviewSrc } from './webviewPolicy.js';
import { registerMeetingsBridge } from './meetingsBridge.js';
import { registerMeetingCaptureBridge } from './meetingCaptureBridge.js';
import { registerChatSyncBridge } from './chatSyncBridge.js';
import { checkComputerUsePermissions, openAccessibilitySettings, openScreenRecordingSettings } from './computerUsePermissions.js';
import { setupTray } from './tray.js';
import { BrowserViewManager } from './browser/browserViewManager.js';
import { BrowserAgentControlManager } from './browser/browserAgentControlManager.js';
import { isBrowserCommand } from './browser/protocol.js';
import { concreteRendererBrowserTarget } from './browser/rendererCommandTarget.js';
import { shouldBypassRendererVisibleQueue } from './browser/visibleQueuePolicy.js';
import { resolveDesktopBootstrapState } from './accountIntegration.js';
import {
  broadcastActiveOrgSelection,
  isActiveOrgSelectionQuery,
  isInternalActiveOrgResult,
} from './activeOrgHostBroadcast.js';
import { initAutoUpdate } from './updater.js';
import { configurePackagedSmokeProfile } from './packagedSmokeBootstrap.js';
import { runPackagedBrowserSmokeIfRequested } from './packagedBrowserSmoke.js';
import {
  APPEARANCE_PREFERENCES,
  appearanceWindowBackground,
  desktopAppearanceState,
  nativeThemeSource,
  normalizeAppearancePreference,
  type AppearancePreference,
  type DesktopAppearanceState,
} from './appearancePolicy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

configurePackagedSmokeProfile(app);

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
  browser: BrowserViewManager;
  hosts: Map<string, UtilityProcess>; // workspaceRoot → live host process
  lastSession: Map<string, string>;   // workspaceRoot → its last-viewed sessionKey
  pool: HostPoolState;                 // pure lifecycle state (tested policy)
  retiring: Set<string>;               // roots whose host we're intentionally killing
  agentBrowserControl: BrowserAgentControlManager;
}
const wins = new Map<number, WinPool>(); // webContents.id → WinPool
let activeOrgBroadcastSequence = 0;

// D26-1 — appearance is a small app-level preference rather than renderer-only
// state. Main resolves the native signals before BrowserWindow creation so the
// startup canvas, dialogs, and OS-owned chrome agree with the renderer.
let appearancePreference: AppearancePreference = 'system';

function appearancePath(): string {
  return path.join(app.getPath('userData'), 'appearance.json');
}

function readAppearancePreference(): AppearancePreference {
  try {
    const parsed = JSON.parse(fs.readFileSync(appearancePath(), 'utf8')) as { preference?: unknown };
    return normalizeAppearancePreference(parsed.preference);
  } catch {
    return 'system';
  }
}

function writeAppearancePreference(preference: AppearancePreference): void {
  try {
    const target = appearancePath();
    const temporary = `${target}.tmp`;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, preference }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, target);
  } catch {
    // Appearance persistence is best-effort. The renderer retains the same
    // preference in localStorage and will re-synchronize on its next launch.
  }
}

function currentAppearanceState(): DesktopAppearanceState {
  return desktopAppearanceState(appearancePreference, {
    dark: nativeTheme.shouldUseDarkColors,
    highContrast: nativeTheme.shouldUseHighContrastColors,
    reducedTransparency: nativeTheme.prefersReducedTransparency,
  });
}

function publishAppearanceState(): DesktopAppearanceState {
  const state = currentAppearanceState();
  const background = appearanceWindowBackground(state.resolved);
  for (const wp of wins.values()) {
    if (wp.win.isDestroyed()) continue;
    wp.win.setBackgroundColor(background);
    wp.win.webContents.send('appearance:changed', state);
  }
  return state;
}

function setAppearancePreference(preference: AppearancePreference): DesktopAppearanceState {
  appearancePreference = preference;
  writeAppearancePreference(preference);
  nativeTheme.themeSource = nativeThemeSource(preference);
  return publishAppearanceState();
}

// PERF — preload asks once, synchronously, before React renders. This is a tiny
// local config read (no network/keychain/host dependency) so the first frame can
// already show the durable signed-in identity instead of flashing signed-out.
ipcMain.on('desktop-bootstrap-state', (event) => {
  if (event.senderFrame !== event.sender.mainFrame) {
    event.returnValue = null;
    return;
  }
  event.returnValue = resolveDesktopBootstrapState(loadConfig(), os.userInfo().username);
});

// Synchronous by design: preload caches this tiny in-memory snapshot before
// React paints. It performs no disk or network work.
ipcMain.on('appearance:get-state', (event) => {
  if (event.senderFrame !== event.sender.mainFrame) {
    event.returnValue = null;
    return;
  }
  event.returnValue = currentAppearanceState();
});

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
    // No hard fail when the OS keychain is unavailable: setSecret already falls
    // back to a 0600 base64 file (the module's intended behavior — refusing to
    // store would push the token into plaintext config.json, which is worse). We
    // surface the mode so the UI can show a non-blocking "not OS-encrypted" note.
    const { mode } = setSecret(app.getPath('userData'), request.key, request.value);
    host.postMessage({ kind: 'secret-response', id: request.id, ok: true, mode });
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
  const unpackedNodeModules = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules')
    : null;
  const host = utilityProcess.fork(path.join(__dirname, 'hostBootstrap.js'), [], {
    env: {
      ...process.env,
      BRAINROUTER_DESKTOP_WORKSPACE: workspaceRoot,
      ...(unpackedNodeModules
        ? { BRAINROUTER_DESKTOP_UNPACKED_NODE_MODULES: unpackedNodeModules }
        : {}),
    },
    serviceName: `brainrouter-agent-host:${path.basename(workspaceRoot)}`,
  });
  host.on('message', (msg) => {
    if (wp.win.isDestroyed()) return;
    if (isBrowserControlRequestMessage(msg)) {
      void wp.agentBrowserControl.handleRequest(host, workspaceRoot, msg);
      return;
    }
    if (isBrowserControlCancelMessage(msg)) {
      wp.agentBrowserControl.cancelRequest(host, msg.id);
      return;
    }
    if (isComputerUseRequest(msg)) {
      void handleComputerUseRequest(wp, host, msg);
      return;
    }
    if (isSecretRequest(msg)) {
      handleSecretRequest(host, msg);
      return;
    }
    if (isInternalActiveOrgResult(msg)) {
      const result = (msg as { event?: { ok?: boolean; error?: string } }).event;
      if (result?.ok === false) {
        console.error(`[brainrouter-desktop main] background host org rebind failed: ${result.error ?? 'unknown error'}`);
      }
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
      // when the user switches back to a parked (reused) host. The Browser
      // records the active chat without rotating its workspace-scoped profile.
      else if (kind === 'session-changed' && typeof ev?.sessionKey === 'string') {
        wp.lastSession.set(workspaceRoot, ev.sessionKey);
        try { wp.browser?.setSession(ev.sessionKey); } catch (err) { console.error('[browser] setSession failed', err); }
      }
    }
    const tagged = (msg && typeof msg === 'object') ? { ...(msg as object), workspaceRoot } : msg;
    wp.win.webContents.send('agent-event', tagged);
  });
  host.on('exit', (code) => {
    wp.agentBrowserControl.releaseHost(host);
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
  setTimeout(() => { try { host.kill(); } catch { /* already exited */ } }, 5_000);
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
  const outgoingRoot = wp.pool.activeRoot;
  if (outgoingRoot && outgoingRoot !== workspaceRoot) {
    wp.agentBrowserControl.invalidateWorkspace();
  }
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
  // Browser tabs and storage are window-owned and restored through one
  // persistent, isolated profile per workspace.
  wp.browser.setWorkspaceRoot(workspaceRoot);
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
    backgroundColor: appearanceWindowBackground(currentAppearanceState().resolved),
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
      // Browser pages live in main-owned WebContentsViews. The only remaining
      // renderer-owned webview is the sandboxed local Artifact/prototype preview,
      // gated below so it cannot become a second general-purpose browser.
      webviewTag: true,
    },
  });
  const browser = new BrowserViewManager(win, workspaceRoot);
  let wp!: WinPool;
  const agentBrowserControl = new BrowserAgentControlManager({
    browser,
    window: {
      isDestroyed: () => win.isDestroyed(),
      isVisible: () => win.isVisible(),
      show: () => win.show(),
      focus: () => win.focus(),
      requestSurface: (command, generation) => {
        win.webContents.send('browser:open-request', {
          reason: 'agent',
          command,
          generation,
        });
      },
    },
    isWorkspaceOwner: (host, root) => (
      wp.pool.activeRoot === root && wp.hosts.get(root) === host
    ),
  });
  wp = {
    win,
    browser,
    hosts: new Map(),
    lastSession: new Map(),
    pool: emptyPool(),
    retiring: new Set(),
    agentBrowserControl,
  };
  browser.setAgentTakeoverHandler(() => wp.agentBrowserControl.handleUserTakeover());
  // ADR-055 P7 — a share/unshare from the tab strip moves per-chat tab
  // authority in the agent-control manager (the owner of that boundary).
  browser.setTabShareHandler(({ workspaceRoot, sessionKey, tabId, share }) => {
    if (!workspaceRoot || !sessionKey) return;
    if (share) wp.agentBrowserControl.grantTab(workspaceRoot, sessionKey, tabId);
    else wp.agentBrowserControl.revokeTab(workspaceRoot, sessionKey, tabId);
  });
  wins.set(win.webContents.id, wp);

  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    hardenWebviewPreferences(webPreferences as unknown as Record<string, unknown>);
    const activeRoot = wp.pool.activeRoot || workspaceRoot;
    if (!isAllowedArtifactWebviewSrc(typeof params.src === 'string' ? params.src : '', activeRoot)) event.preventDefault();
  });
  win.webContents.on('did-attach-webview', (_event, guest) => {
    const gate = (event: { preventDefault(): void }, url: string): void => {
      const activeRoot = wp.pool.activeRoot || workspaceRoot;
      if (!isAllowedArtifactWebviewSrc(url, activeRoot)) event.preventDefault();
    };
    guest.on('will-navigate', gate);
    guest.on('will-redirect', gate);
    guest.setWindowOpenHandler(() => ({ action: 'deny' }));
  });

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
      w.agentBrowserControl.dispose();
      for (const [root, host] of w.hosts) {
        w.retiring.add(root);
        try { host.postMessage({ kind: 'shutdown' }); } catch { /* gone */ }
        setTimeout(() => { try { host.kill(); } catch { /* already exited */ } }, 5_000);
      }
      w.browser.dispose();
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

/**
 * ADR-035 D6 — one process per `userData` directory, which Electron does not do
 * by default.
 *
 * The meeting capture store, its boot recovery pass and the transcription
 * supervisor all assume they are the only writer of that directory, and the
 * supervisor is what now answers "is somebody recording into this capture?" —
 * exactly, for every window, because every window is in this process. A SECOND
 * process is the one case that answer cannot cover, and it is not hypothetical:
 * the boot pass runs on every launch, so a second launch rewrote a live
 * capture's record to `stopped` and adopted the chunk the first one had just
 * written, after which every remaining chunk of that meeting failed `EEXIST` for
 * ever. Detecting that from inside was what the previous round's lease was for,
 * and a timing heuristic is a poor substitute for not having two writers.
 *
 * The lock is per user-data directory, so the browser e2e harness (which
 * launches with its own `--user-data-dir`) is unaffected. A second launch hands
 * its working directory to the primary instance and quits, which is what a
 * person double-clicking the app a second time means by it.
 */
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) {
  app.quit();
} else {
  app.on('second-instance', (_event, _argv, workingDirectory) => {
    // Deferred until ready: the primary instance may still be starting up when
    // a second launch arrives, and a `BrowserWindow` before `ready` throws.
    void app.whenReady().then(() => {
      const root = workingDirectory || readRecents()[0] || process.cwd();
      trustWorkspace(root);
      // Focuses an existing window for that workspace, or opens one — the same
      // call the first launch makes, so a second launch is not a second kind of
      // start-up.
      openWorkspaceWindow(root);
      for (const wp of wins.values()) {
        if (wp.win.isDestroyed()) continue;
        if (wp.win.isMinimized()) wp.win.restore();
      }
    });
  });
}

app.whenReady().then(() => {
  // `app.quit()` above is a request, and `ready` can still arrive before it
  // completes. A losing instance that went on to open a window and register the
  // capture bridge would be the second writer of the `userData` directory this
  // lock exists to prevent — for the seconds it took to die, which is long
  // enough for a boot pass to run.
  if (!isPrimaryInstance) return;
  appearancePreference = readAppearancePreference();
  nativeTheme.themeSource = nativeThemeSource(appearancePreference);
  nativeTheme.on('updated', publishAppearanceState);

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

  // DESK-6 — auto-update scaffold. No-op unless this is a PACKAGED build with
  // BRAINROUTER_UPDATE_CHANNEL set AND electron-updater installed (see updater.ts).
  // Forwards update lifecycle events to every window on the 'update-event' channel.
  void initAutoUpdate({
    emit: (event) => {
      for (const wp of wins.values()) {
        if (!wp.win.isDestroyed()) wp.win.webContents.send('update-event', event);
      }
    },
  });

  ipcMain.on('agent-command', (event, raw: unknown) => {
    const wp = wins.get(event.sender.id);
    if (!wp || event.senderFrame !== wp.win.webContents.mainFrame) return;
    if (!isAgentCommand(raw)) return;
    // Route to the ACTIVE workspace's host; background hosts keep running untouched.
    const host = wp.pool.activeRoot ? wp.hosts.get(wp.pool.activeRoot) : undefined;
    if (isActiveOrgSelectionQuery(raw)) {
      const selectedOrgId = typeof raw.args?.orgId === 'string' ? raw.args.orgId.trim() : '';
      if (selectedOrgId) {
        for (const candidate of wins.values()) {
          if (!candidate.win.isDestroyed()) {
            candidate.win.webContents.send('active-org-changed', { orgId: selectedOrgId });
          }
        }
      }
      const liveHosts = [...wins.values()].flatMap((candidate) => [...candidate.hosts.values()]);
      broadcastActiveOrgSelection(
        raw,
        host,
        liveHosts,
        `${Date.now().toString(36)}-${++activeOrgBroadcastSequence}`,
      );
      return;
    }
    host?.postMessage(raw);
  });

  // First-class Browser IPC. Every call is bound to the BrowserWindow whose
  // main renderer sent it; subframes and stale/detached renderers are refused.
  ipcMain.handle('browser:get-state', (event) => {
    const wp = wins.get(event.sender.id);
    if (!wp || event.senderFrame !== wp.win.webContents.mainFrame) return null;
    return wp.browser.getState();
  });
  ipcMain.handle('browser:command', (event, raw: unknown) => {
    const wp = wins.get(event.sender.id);
    if (!wp || event.senderFrame !== wp.win.webContents.mainFrame || !isBrowserCommand(raw)) {
      return { ok: false, requestId: 'renderer_invalid', code: 'INVALID_REQUEST', error: 'Invalid browser command sender or payload.' };
    }
    // Most user browser commands share the visible-operation queue with agent
    // actions. Recovery on the already-visible tab must remain re-entrant, and
    // selecting another tab skips this outer FIFO so an unrelated load cannot
    // make normal browser chrome unresponsive. The manager still defers a switch
    // while an exact-visible agent pin is active.
    const generation = wp.agentBrowserControl.generation;
    const targetTabId = concreteRendererBrowserTarget(raw, wp.browser.getState());
    const cancelled = () => ({
      ok: false as const,
      requestId: 'renderer_stale_workspace',
      code: 'CANCELLED' as const,
      error: 'Browser command was cancelled because the active workspace changed.',
    });
    const execute = async () => {
      if (!wp.agentBrowserControl.isGenerationCurrent(generation)) return cancelled();
      const result = await wp.browser.executeRaw(raw, targetTabId);
      return wp.agentBrowserControl.isGenerationCurrent(generation) ? result : cancelled();
    };
    const bypassVisibleQueue = shouldBypassRendererVisibleQueue(
      raw.op,
      Boolean(targetTabId && wp.browser.isTabVisible(targetTabId)),
    );
    return bypassVisibleQueue ? execute() : wp.agentBrowserControl.enqueueVisibleOperation(execute);
  });
  ipcMain.on('browser:set-surface', (event, raw: unknown) => {
    const wp = wins.get(event.sender.id);
    if (!wp || event.senderFrame !== wp.win.webContents.mainFrame) return;
    try {
      const envelope = raw && typeof raw === 'object' && 'surface' in raw
        ? raw as { surface: unknown; openGeneration?: unknown }
        : { surface: raw, openGeneration: undefined };
      const surface = wp.browser.setSurface(envelope.surface);
      if (Number.isSafeInteger(envelope.openGeneration)) {
        wp.agentBrowserControl.acknowledgeSurface(
          Number(envelope.openGeneration),
          surface.visible && surface.width > 1 && surface.height > 1,
        );
      }
    } catch { /* malformed renderer geometry */ }
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
  ipcMain.handle('appearance:set-preference', (event, raw: unknown) => {
    const wp = wins.get(event.sender.id);
    if (!wp || event.senderFrame !== wp.win.webContents.mainFrame) {
      throw new Error('Appearance preference sender is not an active BrainRouter window.');
    }
    if (typeof raw !== 'string' || !APPEARANCE_PREFERENCES.includes(raw as AppearancePreference)) {
      throw new Error('Unsupported appearance preference.');
    }
    return setAppearancePreference(raw as AppearancePreference);
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
  // Workspace onboarding manifest bridge. The renderer never
  // touches `.brainrouter/workspace.json`; main goes through the core
  // chokepoint. Trust, top-frame ownership, and the window's active workspace
  // are all enforced so a stale or embedded renderer cannot cross projects.
  ipcMain.handle('workspace:manifest-get', (event, root: unknown) => {
    if (typeof root !== 'string' || !fs.existsSync(root)) return { ok: false, error: 'Unknown workspace.' };
    const wp = wins.get(event.sender.id);
    if (!wp || event.senderFrame !== wp.win.webContents.mainFrame || wp.pool.activeRoot !== root) {
      return { ok: false, error: 'Workspace is no longer active.' };
    }
    if (!isWorkspaceTrusted(root)) return { ok: false, error: 'Workspace is not trusted.' };
    return { ok: true, ...getWorkspaceManifestInfo(root, loadConfig()) };
  });
  ipcMain.handle('workspace:manifest-preview', (event, root: unknown, payload: unknown) => {
    if (typeof root !== 'string' || !fs.existsSync(root)) {
      return { ok: false, error: 'Unknown workspace.' };
    }
    const wp = wins.get(event.sender.id);
    if (!wp || event.senderFrame !== wp.win.webContents.mainFrame || wp.pool.activeRoot !== root) {
      return { ok: false, error: 'Workspace is no longer active.' };
    }
    if (!isWorkspaceTrusted(root)) return { ok: false, error: 'Workspace is not trusted.' };
    return previewWorkspaceOnboardingFromPayload(root, payload, loadConfig());
  });
  ipcMain.handle('workspace:manifest-save', (event, root: unknown, payload: unknown) => {
    if (typeof root !== 'string' || !fs.existsSync(root)) return { saved: false, error: 'Unknown workspace.' };
    const wp = wins.get(event.sender.id);
    if (!wp || event.senderFrame !== wp.win.webContents.mainFrame || wp.pool.activeRoot !== root) {
      return { saved: false, stale: true, error: 'Workspace is no longer active.' };
    }
    if (!isWorkspaceTrusted(root)) return { saved: false, error: 'Workspace is not trusted.' };
    return saveWorkspaceManifestFromPayload(root, payload, loadConfig());
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
  registerMeetingsBridge();
  // ADR-035 D1 — meeting audio is written by main, which outlives a renderer
  // crash. Registered here so the boot recovery pass runs before any window can
  // press Record.
  registerMeetingCaptureBridge();
  registerChatSyncBridge();
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

  const packagedSmokeWindow = [...wins.values()][0]?.win;
  if (packagedSmokeWindow) {
    void runPackagedBrowserSmokeIfRequested(app, packagedSmokeWindow);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      openWorkspaceWindow(readRecents()[0] || process.cwd());
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
