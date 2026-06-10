/**
 * DESK-1 — Electron main: window lifecycle + the renderer⇄host relay.
 * Security posture: contextIsolation ON, nodeIntegration OFF, a typed preload
 * bridge is the renderer's ONLY capability surface, and every inbound command
 * is shape-validated before it reaches the agent host.
 */
import { app, BrowserWindow, ipcMain, utilityProcess } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAgentCommand } from '@kinqs/brainrouter-agent-protocol';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let host = null;
let win = null;
function startHost(workspaceRoot) {
    host = utilityProcess.fork(path.join(__dirname, 'host.js'), [], {
        env: { ...process.env, BRAINROUTER_DESKTOP_WORKSPACE: workspaceRoot },
        serviceName: 'brainrouter-agent-host',
    });
    host.on('message', (msg) => { win?.webContents.send('agent-event', msg); });
    host.on('exit', (code) => {
        win?.webContents.send('agent-event', {
            seq: -1, ts: Date.now(), sessionKey: 'host',
            event: { kind: 'turn-error', message: `Agent host exited (code ${code ?? 'unknown'}).` },
        });
    });
}
function createWindow() {
    win = new BrowserWindow({
        width: 1280,
        height: 840,
        minWidth: 900,
        minHeight: 600,
        title: 'BrainRouter',
        backgroundColor: '#262624',
        titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });
    const devUrl = process.env.VITE_DEV_SERVER_URL;
    if (devUrl)
        void win.loadURL(devUrl);
    else
        void win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}
app.whenReady().then(() => {
    // v1 workspace = launch cwd (folder picker lands in DESK-5).
    startHost(process.env.BRAINROUTER_DESKTOP_WORKSPACE || process.cwd());
    createWindow();
    ipcMain.on('agent-command', (event, raw) => {
        // Validate sender + shape before anything reaches the host.
        if (event.senderFrame !== win?.webContents.mainFrame)
            return;
        if (!isAgentCommand(raw))
            return;
        host?.postMessage(raw);
    });
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0)
        createWindow(); });
});
app.on('window-all-closed', () => {
    host?.postMessage({ kind: 'shutdown' });
    if (process.platform !== 'darwin')
        app.quit();
});
