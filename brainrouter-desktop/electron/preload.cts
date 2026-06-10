/**
 * DESK-1 — the renderer's ONLY capability surface (contextBridge). Typed in
 * src/bridge.d.ts; commands are re-validated in main before reaching the host.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('brainrouter', {
  send(command: unknown): void {
    ipcRenderer.send('agent-command', command);
  },
  onEvent(listener: (msg: unknown) => void): () => void {
    const wrapped = (_e: unknown, msg: unknown) => listener(msg);
    ipcRenderer.on('agent-event', wrapped);
    return () => ipcRenderer.removeListener('agent-event', wrapped);
  },
});
