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

// D26-1 — cached synchronously so the renderer can resolve System appearance
// before React paints. Future OS changes arrive on the bounded event below.
let desktopAppearanceState: unknown = null;
try { desktopAppearanceState = ipcRenderer.sendSync('appearance:get-state'); } catch { /* older main process */ }

contextBridge.exposeInMainWorld('brainrouter', {
  getBootstrapState(): unknown {
    return desktopBootstrapState;
  },
  appearance: {
    getState(): unknown {
      return desktopAppearanceState;
    },
    setPreference(preference: unknown): Promise<unknown> {
      return ipcRenderer.invoke('appearance:set-preference', preference);
    },
    onChanged(listener: (state: unknown) => void): () => void {
      const wrapped = (_event: unknown, state: unknown) => {
        desktopAppearanceState = state;
        listener(state);
      };
      ipcRenderer.on('appearance:changed', wrapped);
      return () => ipcRenderer.removeListener('appearance:changed', wrapped);
    },
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
  // Onboarding manifest bridge (main owns all file access).
  workspaceManifest(workspaceRoot: string): Promise<Record<string, unknown>> {
    return ipcRenderer.invoke('workspace:manifest-get', workspaceRoot);
  },
  previewWorkspaceOnboarding(workspaceRoot: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return ipcRenderer.invoke('workspace:manifest-preview', workspaceRoot, payload);
  },
  saveWorkspaceManifest(workspaceRoot: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return ipcRenderer.invoke('workspace:manifest-save', workspaceRoot, payload);
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
  /**
   * First-class in-app browser. The renderer controls browser chrome and reports
   * the rectangle reserved for the native WebContentsView; page lifecycle and
   * automation remain in Electron main. Keeping this as four bounded IPC calls
   * means remote pages never receive a preload or a reference to ipcRenderer.
   */
  browser: {
    getState(): Promise<unknown> {
      return ipcRenderer.invoke('browser:get-state');
    },
    command(command: unknown): Promise<unknown> {
      return ipcRenderer.invoke('browser:command', command);
    },
    setSurface(surface: unknown, openGeneration?: number): void {
      ipcRenderer.send('browser:set-surface', openGeneration === undefined ? surface : { surface, openGeneration });
    },
    onEvent(listener: (event: unknown) => void): () => void {
      const wrapped = (_e: unknown, event: unknown) => listener(event);
      ipcRenderer.on('browser:event', wrapped);
      return () => ipcRenderer.removeListener('browser:event', wrapped);
    },
    onOpenRequest(listener: (request: unknown) => void): () => void {
      const wrapped = (_e: unknown, request: unknown) => listener(request);
      ipcRenderer.on('browser:open-request', wrapped);
      return () => ipcRenderer.removeListener('browser:open-request', wrapped);
    },
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
    list(input?: { cursor?: string; limit?: number }, orgId?: string): Promise<unknown> { return ipcRenderer.invoke('meetings:list', input, orgId); },
    get(id: string, orgId?: string): Promise<unknown> { return ipcRenderer.invoke('meetings:get', id, orgId); },
    overview(id: string, orgId?: string): Promise<unknown> { return ipcRenderer.invoke('meetings:overview', id, orgId); },
    transcript(id: string, input?: { cursor?: string; limit?: number }, orgId?: string): Promise<unknown> { return ipcRenderer.invoke('meetings:transcript', id, input, orgId); },
    create(input: { title: string; transcript: string; template?: string; scope?: string; teamId?: string; date?: string; attendees?: string[] }, orgId?: string): Promise<unknown> { return ipcRenderer.invoke('meetings:create', input, orgId); },
    updateSummary(id: string, summaryMarkdown: string, orgId?: string): Promise<unknown> { return ipcRenderer.invoke('meetings:updateSummary', id, summaryMarkdown, orgId); },
    transcribe(input: { bytes: Uint8Array; contentType?: string; language?: string }): Promise<unknown> { return ipcRenderer.invoke('meetings:transcribe', input); },
    regenerate(id: string, orgId?: string): Promise<unknown> { return ipcRenderer.invoke('meetings:regenerate', id, orgId); },
    remove(id: string, orgId?: string): Promise<unknown> { return ipcRenderer.invoke('meetings:delete', id, orgId); },
    setScope(id: string, scope: string, opts?: { teamId?: string }, orgId?: string): Promise<unknown> { return ipcRenderer.invoke('meetings:setScope', id, scope, opts, orgId); },
    actionToTrack(meetingId: string, actionId: string, orgId?: string): Promise<unknown> { return ipcRenderer.invoke('meetings:actionToTrack', meetingId, actionId, orgId); },
    actionUntrack(meetingId: string, actionId: string, orgId?: string): Promise<unknown> { return ipcRenderer.invoke('meetings:actionUntrack', meetingId, actionId, orgId); },
    toggleAction(meetingId: string, actionId: string, done: boolean, orgId?: string): Promise<unknown> { return ipcRenderer.invoke('meetings:toggleAction', meetingId, actionId, done, orgId); },
    // SERVER Track board (org-scoped /api/track), surfaced inside Meetings mode.
    serverTracks(orgId?: string): Promise<unknown> { return ipcRenderer.invoke('meetings:serverTracks', orgId); },
    serverTrackCreate(input: { title: string; description?: string; priority?: string; assignee?: string; statusCategory?: string }, orgId?: string): Promise<unknown> { return ipcRenderer.invoke('meetings:serverTrackCreate', input, orgId); },
    serverTrackTransition(id: string, statusCategory: string, orgId?: string): Promise<unknown> { return ipcRenderer.invoke('meetings:serverTrackTransition', id, statusCategory, orgId); },
    serverTrackSetDone(id: string, done: boolean, orgId?: string): Promise<unknown> { return ipcRenderer.invoke('meetings:serverTrackSetDone', id, done, orgId); },
    serverTrackRemove(id: string, orgId?: string): Promise<unknown> { return ipcRenderer.invoke('action:meetings:serverTrackRemove', id, orgId); },
  },
  // Team spaces — organization context + global personal teams. Proxied through
  // main so the renderer never receives the account bearer.
  teams: {
    contexts(): Promise<unknown> { return ipcRenderer.invoke('teams:contexts'); },
    list(orgId?: string): Promise<unknown> { return ipcRenderer.invoke('teams:list', orgId); },
    get(id: string, orgId?: string): Promise<unknown> { return ipcRenderer.invoke('teams:get', id, orgId); },
    create(name: string, kind: string, orgId?: string): Promise<unknown> { return ipcRenderer.invoke('teams:create', name, kind, orgId); },
    addMember(id: string, account: string, role: string, orgId?: string): Promise<unknown> { return ipcRenderer.invoke('teams:addMember', id, account, role, orgId); },
    removeMember(id: string, userId: string, orgId?: string): Promise<unknown> { return ipcRenderer.invoke('teams:removeMember', id, userId, orgId); },
    remove(id: string, orgId?: string): Promise<unknown> { return ipcRenderer.invoke('teams:remove', id, orgId); },
  },
  // K-desktop — cross-surface chat sync. OPT-IN: push mirrors the active chat
  // session's user/assistant turns up to the shared /api/chat/threads API so a
  // desktop conversation also shows on the dashboard + CLI. Local transcripts
  // are untouched; nothing runs on a normal turn, only on explicit user action.
  chatSync: {
    push(args: { workspaceRoot: string; sessionKey: string; title?: string }): Promise<{ threadId: string; messageCount: number; created: boolean; title: string }> {
      return ipcRenderer.invoke('chatSync:push', args);
    },
    list(): Promise<Array<Record<string, unknown>>> { return ipcRenderer.invoke('chatSync:list'); },
  },
});
