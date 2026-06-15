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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface Pair { win: BrowserWindow; host: UtilityProcess; workspaceRoot: string }
const pairs = new Map<number, Pair>(); // webContents.id → pair

const recentsPath = (): string => path.join(app.getPath('userData'), 'recent-workspaces.json');
function readRecents(): string[] {
  try { return JSON.parse(fs.readFileSync(recentsPath(), 'utf-8')) as string[]; } catch { return []; }
}
function pushRecent(workspaceRoot: string): void {
  const next = [workspaceRoot, ...readRecents().filter((w) => w !== workspaceRoot)].slice(0, 10);
  try { fs.mkdirSync(path.dirname(recentsPath()), { recursive: true }); fs.writeFileSync(recentsPath(), JSON.stringify(next, null, 2)); } catch { /* best-effort */ }
}

/** Fork an agent host for a workspace and pipe its events into the window. */
function spawnHost(win: BrowserWindow, workspaceRoot: string): UtilityProcess {
  const host = utilityProcess.fork(path.join(__dirname, 'host.js'), [], {
    env: { ...process.env, BRAINROUTER_DESKTOP_WORKSPACE: workspaceRoot },
    serviceName: `brainrouter-agent-host:${path.basename(workspaceRoot)}`,
  });
  host.on('message', (msg) => { if (!win.isDestroyed()) win.webContents.send('agent-event', msg); });
  host.on('exit', (code) => {
    if (!win.isDestroyed()) win.webContents.send('agent-event', {
      seq: -1, ts: Date.now(), sessionKey: 'host',
      event: { kind: 'turn-error', message: `Agent host exited (code ${code ?? 'unknown'}).` },
    });
  });
  return host;
}

/**
 * DESK-5d — switch the workspace INSIDE the window: retire the old host
 * (graceful shutdown, hard kill as backstop) and fork a fresh one. The new
 * host announces itself with a boot `session-changed`, which is the
 * renderer's cue to reset its surfaces — no second window, ever.
 */
function switchWorkspace(pair: Pair, workspaceRoot: string): void {
  if (pair.workspaceRoot === workspaceRoot) return;
  const old = pair.host;
  old.removeAllListeners('message');
  old.removeAllListeners('exit'); // a retiring host's exit is not an error
  try { old.postMessage({ kind: 'shutdown' }); } catch { /* already gone */ }
  setTimeout(() => { try { old.kill(); } catch { /* already exited */ } }, 1_500);
  pair.workspaceRoot = workspaceRoot;
  pair.host = spawnHost(pair.win, workspaceRoot);
  pair.win.setTitle(`BrainRouter — ${path.basename(workspaceRoot)}`);
  pushRecent(workspaceRoot);
}

function openWorkspaceWindow(workspaceRoot: string): void {
  // Focus an existing window for this workspace instead of duplicating it.
  for (const pair of pairs.values()) {
    if (pair.workspaceRoot === workspaceRoot) { pair.win.focus(); return; }
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
  const host = spawnHost(win, workspaceRoot);
  win.on('closed', () => {
    const pair = [...pairs.values()].find((p) => p.win === win);
    pair?.host.postMessage({ kind: 'shutdown' });
    for (const [id, p] of pairs) { if (p.win === win) pairs.delete(id); }
  });
  pairs.set(win.webContents.id, { win, host, workspaceRoot });
  pushRecent(workspaceRoot);

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

// DESK-5o — overlay scrollbars: thin, auto-hiding, and (crucially) reserving
// ZERO layout width, so a scrollable column never carves a hard 8px strip
// between it and its neighbor. This is what makes Codex/native apps look
// clean; classic Chromium scrollbars reserve space and draw a hard divider.
app.commandLine.appendSwitch('enable-features', 'OverlayScrollbar');

app.whenReady().then(() => {
  openWorkspaceWindow(process.env.BRAINROUTER_DESKTOP_WORKSPACE || readRecents()[0] || process.cwd());

  ipcMain.on('agent-command', (event, raw: unknown) => {
    const pair = pairs.get(event.sender.id);
    if (!pair || event.senderFrame !== pair.win.webContents.mainFrame) return;
    if (!isAgentCommand(raw)) return;
    pair.host.postMessage(raw);
  });

  // Workspace management — main-process concerns, separate channel from the
  // agent protocol. invoke/handle so the renderer gets results back.
  // DESK-5d — `add` only PICKS a folder; the renderer shows the trust dialog
  // first and then calls `open`, which swaps the host inside this window.
  ipcMain.handle('workspace:add', async (event) => {
    const pair = pairs.get(event.sender.id);
    const res = await dialog.showOpenDialog(pair?.win ?? BrowserWindow.getFocusedWindow()!, {
      title: 'Add project folder', properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || res.filePaths.length === 0) return { opened: false };
    return { opened: false, workspaceRoot: res.filePaths[0] };
  });
  ipcMain.handle('workspace:recents', (event) => {
    const pair = pairs.get(event.sender.id);
    return { current: pair?.workspaceRoot ?? null, recents: readRecents() };
  });
  ipcMain.handle('workspace:open', (event, workspaceRoot: unknown) => {
    if (typeof workspaceRoot !== 'string' || !fs.existsSync(workspaceRoot)) return { opened: false };
    const pair = pairs.get(event.sender.id);
    if (pair) switchWorkspace(pair, workspaceRoot);
    else openWorkspaceWindow(workspaceRoot);
    return { opened: true };
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
