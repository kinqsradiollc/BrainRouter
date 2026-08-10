/**
 * DESK-3b — the renderer's ONLY capability surface. Agent protocol on one
 * channel; workspace management (main-process dialogs) on invoke channels.
 */
const { contextBridge, ipcRenderer, webFrame } = require('electron');
const { createIpcListenerHub } = require('./ipcListenerHub.cjs');

const agentEvents = createIpcListenerHub(ipcRenderer, 'agent-event');

// Credential-free, local-only identity captured before the utility host boots.
// sendSync is deliberate here: one small config read removes the signed-out
// first-frame flash and never waits on network or safeStorage.
let desktopBootstrapState: unknown = null;
try { desktopBootstrapState = ipcRenderer.sendSync('desktop-bootstrap-state'); } catch { /* older main process */ }

// D26-1 — cached synchronously so the renderer can resolve System appearance
// before React paints. Future OS changes arrive on the bounded event below.
let desktopAppearanceState: unknown = null;
try { desktopAppearanceState = ipcRenderer.sendSync('appearance:get-state'); } catch { /* older main process */ }

// ADR-035 D6 — this window's capture-writer identity, remembered from the only
// call that can create a claim (`captureBegin`), so THE PAGE can hand the
// recording back when it goes away.
//
// It is remembered here rather than asked of the renderer because this script is
// per-window and outlives every component in it, and because the event that
// matters is the page's own: `pagehide` fires on a reload, a navigation and a
// close, which is precisely the set of moments a window stops being able to
// record. Main is untouched by a renderer reload — that is why the previous
// answer (a heartbeat main kept sending on the page's behalf) claimed a
// recording for a page that no longer existed, and refused Transcribe, Create
// and Delete for ever over it. Main's own `destroyed`/`render-process-gone`
// hooks cover the case a page cannot report: its renderer died.
let meetingCaptureHolderId: string | null = null;
window.addEventListener('pagehide', () => {
  if (!meetingCaptureHolderId) return;
  void ipcRenderer.invoke('meetings:captureRelease', meetingCaptureHolderId).catch(() => undefined);
});

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
    return agentEvents.subscribe(listener);
  },
  // User-controlled project ordering: main pushes updated recents for activity
  // membership changes and explicit drag/drop reorders.
  onRecentsChanged(listener: (data: { recents: string[]; reason: string; workspaceRoot: string }) => void): () => void {
    const wrapped = (_e: unknown, data: { recents: string[]; reason: string; workspaceRoot: string }) => listener(data);
    ipcRenderer.on('recents-changed', wrapped);
    return () => ipcRenderer.removeListener('recents-changed', wrapped);
  },
  // Active account organization is global across every Desktop window and
  // pooled workspace host. Main broadcasts the validated selection so another
  // open window cannot keep rendering a stale org while its Agent has rebound.
  onActiveOrgChanged(listener: (data: { orgId: string }) => void): () => void {
    const wrapped = (_e: unknown, data: { orgId: string }) => listener(data);
    ipcRenderer.on('active-org-changed', wrapped);
    return () => ipcRenderer.removeListener('active-org-changed', wrapped);
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
    // ADR-035 D1/D2 — local capture. Audio never accumulates in the renderer:
    // each recorder chunk crosses here and is on disk before anything else
    // happens to it, and main owns the directory because it outlives a crash.
    // `holderId` is ADR-035 D6's window identity: one id per BrowserWindow, sent
    // with every call that takes or releases a recording, so the process that
    // holds every window can tell the one that is recording from a second one
    // looking at a stale offer.
    captureBegin(input: { title?: string; template?: string; language?: string; orgId?: string | null; workspaceId?: string | null; contentType?: string; holderId?: string }): Promise<unknown> {
      // Remembered for `pagehide` above — the claim this call creates is the one
      // the page has to hand back when it goes away.
      if (typeof input?.holderId === 'string' && input.holderId) meetingCaptureHolderId = input.holderId;
      return ipcRenderer.invoke('meetings:captureBegin', input);
    },
    captureAppend(id: string, bytes: Uint8Array, durationMs: number): Promise<unknown> { return ipcRenderer.invoke('meetings:captureAppend', id, bytes, durationMs); },
    captureStop(id: string): Promise<unknown> { return ipcRenderer.invoke('meetings:captureStop', id); },
    captureRead(id: string): Promise<unknown> { return ipcRenderer.invoke('meetings:captureRead', id); },
    captureFinalize(id: string, holderId?: string): Promise<unknown> { return ipcRenderer.invoke('meetings:captureFinalize', id, holderId); },
    captureDiscard(id: string, holderId?: string): Promise<unknown> { return ipcRenderer.invoke('meetings:captureDiscard', id, holderId); },
    captureResumable(scope?: { orgId?: string | null; workspaceId?: string | null }): Promise<unknown> { return ipcRenderer.invoke('meetings:captureResumable', scope); },
    captureWriting(scope?: { orgId?: string | null; workspaceId?: string | null }): Promise<unknown> { return ipcRenderer.invoke('meetings:captureWriting', scope); },
    // ADR-035 D6 — the set of live recordings changed somewhere in this process:
    // a Record, a Stop, a close, or a window that went away. No payload, because
    // the answer a surface needs is scoped to its own workspace and its own id —
    // it asks `captureWriting` again. This is what replaced waiting out a
    // staleness window: there is nothing to wait for, so the surface is told at
    // the instant its answer became wrong.
    onCaptureWriters(listener: () => void): () => void {
      const wrapped = () => listener();
      ipcRenderer.on('meetings:capture-writers', wrapped);
      return () => ipcRenderer.removeListener('meetings:capture-writers', wrapped);
    },
    // ADR-035 D3/D4/D5 — the transcription queue lives in main, so the renderer
    // asks it to start on a capture or to retry one segment, and is TOLD about
    // every persisted change. A window reload rejoins a drain that never stopped.
    captureAdopt(id: string, holderId?: string): Promise<unknown> { return ipcRenderer.invoke('meetings:captureAdopt', id, holderId); },
    captureRetrySegment(id: string, index: number): Promise<unknown> { return ipcRenderer.invoke('meetings:captureRetrySegment', id, index); },
    // ADR-035 D6 — the compose draft lives beside the audio, under the same
    // 0700 directory, instead of in `localStorage` where any page script could
    // read the meeting's own words back.
    draftRead(): Promise<unknown> { return ipcRenderer.invoke('meetings:draftRead'); },
    draftWrite(draft: { title?: string; transcript?: string; template?: string; language?: string }): Promise<unknown> { return ipcRenderer.invoke('meetings:draftWrite', draft); },
    draftClear(): Promise<unknown> { return ipcRenderer.invoke('meetings:draftClear'); },
    onCaptureProgress(listener: (progress: unknown) => void): () => void {
      const wrapped = (_e: unknown, progress: unknown) => listener(progress);
      ipcRenderer.on('meetings:capture-progress', wrapped);
      return () => ipcRenderer.removeListener('meetings:capture-progress', wrapped);
    },
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
