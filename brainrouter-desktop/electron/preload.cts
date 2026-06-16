/**
 * DESK-3b — the renderer's ONLY capability surface. Agent protocol on one
 * channel; workspace management (main-process dialogs) on invoke channels.
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
  addWorkspace(): Promise<{ opened: boolean; workspaceRoot?: string }> {
    return ipcRenderer.invoke('workspace:add');
  },
  workspaceRecents(): Promise<{ current: string | null; recents: string[] }> {
    return ipcRenderer.invoke('workspace:recents');
  },
  openWorkspace(workspaceRoot: string): Promise<{ opened: boolean; needsTrust?: boolean }> {
    return ipcRenderer.invoke('workspace:open', workspaceRoot);
  },
  // T1 — workspace trust, backed by the shared CLI store (not localStorage).
  isWorkspaceTrusted(workspaceRoot: string): Promise<{ trusted: boolean }> {
    return ipcRenderer.invoke('workspace:isTrusted', workspaceRoot);
  },
  trustWorkspace(workspaceRoot: string): Promise<{ trusted: boolean }> {
    return ipcRenderer.invoke('workspace:trust', workspaceRoot);
  },
  untrustWorkspace(workspaceRoot: string): Promise<{ trusted: boolean }> {
    return ipcRenderer.invoke('workspace:untrust', workspaceRoot);
  },
  trustedWorkspaces(): Promise<{ trusted: string[] }> {
    return ipcRenderer.invoke('workspace:trustedList');
  },
});
