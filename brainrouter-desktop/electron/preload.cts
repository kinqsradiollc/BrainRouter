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
  // User-controlled project ordering: main pushes updated recents for activity
  // membership changes and explicit drag/drop reorders.
  onRecentsChanged(listener: (data: { recents: string[]; reason: string; workspaceRoot: string }) => void): () => void {
    const wrapped = (_e: unknown, data: { recents: string[]; reason: string; workspaceRoot: string }) => listener(data);
    ipcRenderer.on('recents-changed', wrapped);
    return () => ipcRenderer.removeListener('recents-changed', wrapped);
  },
  addWorkspace(): Promise<{ opened: boolean; workspaceRoot?: string }> {
    return ipcRenderer.invoke('workspace:add');
  },
  workspaceRecents(): Promise<{ current: string | null; recents: string[] }> {
    return ipcRenderer.invoke('workspace:recents');
  },
  workspaceSessions(root: string, limit?: number): Promise<{ rows: Array<Record<string, unknown>>; truncated?: boolean; error?: string }> {
    return ipcRenderer.invoke('workspace:sessions', root, limit);
  },
  openWorkspace(workspaceRoot: string): Promise<{ opened: boolean; needsTrust?: boolean }> {
    return ipcRenderer.invoke('workspace:open', workspaceRoot);
  },
  // Open a workspace in a SEPARATE window (git worktrees) — never swaps the
  // current window's active workspace / projects / chat.
  openWorkspaceWindow(workspaceRoot: string): Promise<{ opened: boolean; needsTrust?: boolean }> {
    return ipcRenderer.invoke('workspace:open-window', workspaceRoot);
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
  markActivity(workspaceRoot: string, reason: string): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke('workspace:activity', workspaceRoot, reason);
  },
  reorderWorkspace(dragged: string, target: string): Promise<{ recents: string[] }> {
    return ipcRenderer.invoke('workspace:reorder', dragged, target);
  },
  // T1 — cross-workspace dashboard (running tasks + last review gate per recent root).
  globalDashboard(): Promise<{ workspaces: Array<{ workspaceRoot: string; tasks: Array<Record<string, unknown>>; reviewGate: { status: string; blocked: boolean; reason: string } | null }> }> {
    return ipcRenderer.invoke('dashboard:global');
  },
});
