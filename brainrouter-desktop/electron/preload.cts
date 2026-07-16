/**
 * DESK-3b — the renderer's ONLY capability surface. Agent protocol on one
 * channel; workspace management (main-process dialogs) on invoke channels.
 */
const { contextBridge, ipcRenderer, webFrame } = require('electron');

// Credential-free, local-only identity captured before the utility host boots.
// sendSync is deliberate here: one small config read removes the signed-out
// first-frame flash and never waits on network or safeStorage.
let desktopBootstrapState: unknown = null;
try { desktopBootstrapState = ipcRenderer.sendSync('desktop-bootstrap-state'); } catch { /* older main process */ }

contextBridge.exposeInMainWorld('brainrouter', {
  getBootstrapState(): unknown {
    return desktopBootstrapState;
  },
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
  // Connector Phase 2 — GitHub OAuth device flow, brokered by MAIN (tokens
  // never reach the renderer; only user_code/status/metadata come back).
  ghOauth(payload: { op: 'start' | 'poll' | 'cancel' | 'disconnect' | 'status'; connectorId: string; clientId?: string }): Promise<Record<string, unknown>> {
    return ipcRenderer.invoke('gh-oauth', payload);
  },
  // T1 — cross-workspace dashboard (running tasks + last review gate per recent root).
  globalDashboard(): Promise<{ workspaces: Array<{ workspaceRoot: string; tasks: Array<Record<string, unknown>>; reviewGate: { status: string; blocked: boolean; reason: string } | null }> }> {
    return ipcRenderer.invoke('dashboard:global');
  },
  getZoomFactor(): number {
    return webFrame.getZoomFactor();
  },
  setZoomFactor(factor: number): void {
    webFrame.setZoomFactor(factor);
  },
  computerUse: {
    checkPermissions(): Promise<unknown> {
      return ipcRenderer.invoke('computerUse:checkPermissions');
    },
    openAccessibilitySettings(): Promise<unknown> {
      return ipcRenderer.invoke('computerUse:openAccessibilitySettings');
    },
    openScreenRecordingSettings(): Promise<unknown> {
      return ipcRenderer.invoke('computerUse:openScreenRecordingSettings');
    },
    setMode(args: { enabled?: boolean; mode?: string }): Promise<unknown> {
      return ipcRenderer.invoke('computerUse:setMode', args);
    },
  },
  // Meetings (ADR-018) — the renderer never holds the account bearer, so meeting
  // reads/writes are proxied through the main process to the account backend.
  meetings: {
    list(): Promise<unknown> { return ipcRenderer.invoke('meetings:list'); },
    get(id: string): Promise<unknown> { return ipcRenderer.invoke('meetings:get', id); },
    create(input: { title: string; transcript: string }): Promise<unknown> { return ipcRenderer.invoke('meetings:create', input); },
    regenerate(id: string): Promise<unknown> { return ipcRenderer.invoke('meetings:regenerate', id); },
    setScope(id: string, scope: string, opts?: { teamId?: string }): Promise<unknown> { return ipcRenderer.invoke('meetings:setScope', id, scope, opts); },
    actionToTrack(meetingId: string, actionId: string): Promise<unknown> { return ipcRenderer.invoke('meetings:actionToTrack', meetingId, actionId); },
    actionUntrack(meetingId: string, actionId: string): Promise<unknown> { return ipcRenderer.invoke('meetings:actionUntrack', meetingId, actionId); },
    toggleAction(meetingId: string, actionId: string, done: boolean): Promise<unknown> { return ipcRenderer.invoke('meetings:toggleAction', meetingId, actionId, done); },
    // SERVER Track board (org-scoped /api/track), surfaced inside Meetings mode.
    serverTracks(): Promise<unknown> { return ipcRenderer.invoke('meetings:serverTracks'); },
    serverTrackSetDone(id: string, done: boolean): Promise<unknown> { return ipcRenderer.invoke('meetings:serverTrackSetDone', id, done); },
    serverTrackRemove(id: string): Promise<unknown> { return ipcRenderer.invoke('action:meetings:serverTrackRemove', id); },
  },
});
