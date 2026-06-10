/**
 * DESK-3b/4a — Electron main: one window+host pair PER WORKSPACE, a native
 * folder picker to open more, and a persisted recent-workspaces list.
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
  win.on('closed', () => { host.postMessage({ kind: 'shutdown' }); pairs.delete(win.webContents.id); });
  pairs.set(win.webContents.id, { win, host, workspaceRoot });
  pushRecent(workspaceRoot);

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

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
  ipcMain.handle('workspace:add', async (event) => {
    const pair = pairs.get(event.sender.id);
    const res = await dialog.showOpenDialog(pair?.win ?? BrowserWindow.getFocusedWindow()!, {
      title: 'Open workspace folder', properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || res.filePaths.length === 0) return { opened: false };
    openWorkspaceWindow(res.filePaths[0]);
    return { opened: true, workspaceRoot: res.filePaths[0] };
  });
  ipcMain.handle('workspace:recents', (event) => {
    const pair = pairs.get(event.sender.id);
    return { current: pair?.workspaceRoot ?? null, recents: readRecents() };
  });
  ipcMain.handle('workspace:open', (event, workspaceRoot: unknown) => {
    if (typeof workspaceRoot !== 'string' || !fs.existsSync(workspaceRoot)) return { opened: false };
    openWorkspaceWindow(workspaceRoot);
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
