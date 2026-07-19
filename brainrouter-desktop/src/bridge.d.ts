import type { AgentCommand, AgentEventMessage } from '@kinqs/brainrouter-agent-protocol';
import type {
  BrowserCommand,
  BrowserCommandResult,
  BrowserEvent,
  BrowserState,
  BrowserSurface,
} from '../electron/browser/protocol.js';

declare global {
  interface Window {
    /** The preload bridge — the renderer's only capability surface. */
    brainrouter: {
      /** Credential-free local identity available before the utility host boots. */
      getBootstrapState?(): {
        accountStatus: {
          signedIn: boolean;
          account: { url: string; userId: string; displayName: string; email: string } | null;
        };
      } | null;
      send(command: AgentCommand): void;
      onEvent(listener: (msg: AgentEventMessage) => void): () => void;
      /** Project order/membership updates from main. May be absent on older preloads. */
      onRecentsChanged?(listener: (data: { recents: string[]; reason: string; workspaceRoot: string }) => void): () => void;
      /** Folder picker ONLY — returns the picked path; the renderer runs the
       * trust gate and then calls openWorkspace (DESK-5d). */
      addWorkspace(): Promise<{ opened: boolean; workspaceRoot?: string }>;
      workspaceRecents(): Promise<{ current: string | null; recents: string[] }>;
      workspaceSessions?(root: string, limit?: number): Promise<{ rows: Array<Record<string, unknown>>; truncated?: boolean; error?: string }>;
      /** Swaps the agent host to this workspace INSIDE the current window.
       *  `needsTrust` is returned when main refused an untrusted workspace. */
      openWorkspace(workspaceRoot: string): Promise<{ opened: boolean; needsTrust?: boolean }>;
      /** Open a workspace in a SEPARATE window (git worktrees) — never swaps the
       *  current window's active workspace / projects / chat. */
      openWorkspaceWindow(workspaceRoot: string): Promise<{ opened: boolean; needsTrust?: boolean }>;
      /** T1 — workspace trust, backed by the shared CLI store (not localStorage). */
      isWorkspaceTrusted(workspaceRoot: string): Promise<{ trusted: boolean }>;
      trustWorkspace(workspaceRoot: string): Promise<{ trusted: boolean }>;
      untrustWorkspace(workspaceRoot: string): Promise<{ trusted: boolean }>;
      trustedWorkspaces(): Promise<{ trusted: string[] }>;
      /** Wave 1/4 — report real activity main can't see (commit/push/create-pr). */
      markActivity?(workspaceRoot: string, reason: string): Promise<{ ok: boolean }>;
      /** Explicit user drag/drop ordering for projects. */
      reorderWorkspace?(dragged: string, target: string): Promise<{ recents: string[] }>;
      /** GitHub OAuth device flow brokered by Electron main. Tokens never reach the renderer. */
      ghOauth?(payload: { op: 'start' | 'poll' | 'cancel' | 'disconnect' | 'status'; connectorId: string; clientId?: string }): Promise<Record<string, unknown>>;
      /** T1 — cross-workspace dashboard: running tasks + last review gate per recent root. */
      globalDashboard?(): Promise<{ workspaces: Array<{ workspaceRoot: string; tasks: Array<Record<string, unknown>>; reviewGate: { status: string; blocked: boolean; reason: string } | null }> }>;
      getZoomFactor?(): number;
      setZoomFactor?(factor: number): void;
      /** Main-owned first-class browser. Remote pages never receive this bridge. */
      browser?: {
        getState(): Promise<BrowserState>;
        command<T = unknown>(command: BrowserCommand): Promise<BrowserCommandResult<T>>;
        setSurface(surface: BrowserSurface, openGeneration?: number): void;
        onEvent(listener: (event: BrowserEvent) => void): () => void;
        /** Main asks the shell to expose the Browser panel before an agent action. */
        onOpenRequest?(listener: (request: { reason: 'agent'; command: string; generation: number }) => void): () => void;
      };
      computerUse?: {
        checkPermissions(): Promise<unknown>;
        openAccessibilitySettings(): Promise<unknown>;
        openScreenRecordingSettings(): Promise<unknown>;
        setMode(args: { enabled?: boolean; mode?: string }): Promise<unknown>;
      };
      /** Account-backed Meetings and its org-scoped server Track board. */
      meetings?: {
        list(input?: { cursor?: string; limit?: number }, orgId?: string): Promise<unknown>;
        get(id: string, orgId?: string): Promise<unknown>;
        overview(id: string, orgId?: string): Promise<unknown>;
        transcript(id: string, input?: { cursor?: string; limit?: number }, orgId?: string): Promise<unknown>;
        create(input: { title: string; transcript: string; template?: string; scope?: string; teamId?: string; date?: string; attendees?: string[] }, orgId?: string): Promise<unknown>;
        updateSummary(id: string, summaryMarkdown: string, orgId?: string): Promise<unknown>;
        transcribe(input: { bytes: Uint8Array; contentType?: string; language?: string }): Promise<unknown>;
        regenerate(id: string, orgId?: string): Promise<unknown>;
        remove(id: string, orgId?: string): Promise<unknown>;
        setScope(id: string, scope: string, opts?: { teamId?: string }, orgId?: string): Promise<unknown>;
        actionToTrack(meetingId: string, actionId: string, orgId?: string): Promise<unknown>;
        actionUntrack(meetingId: string, actionId: string, orgId?: string): Promise<unknown>;
        toggleAction(meetingId: string, actionId: string, done: boolean, orgId?: string): Promise<unknown>;
        serverTracks(orgId?: string): Promise<unknown>;
        serverTrackCreate(input: { title: string; description?: string; priority?: string; assignee?: string; statusCategory?: string }, orgId?: string): Promise<unknown>;
        serverTrackTransition(id: string, statusCategory: string, orgId?: string): Promise<unknown>;
        serverTrackSetDone(id: string, done: boolean, orgId?: string): Promise<unknown>;
        serverTrackRemove(id: string, orgId?: string): Promise<unknown>;
      };
      /** Organization team spaces plus cross-organization personal teams. */
      teams?: {
        contexts(): Promise<unknown>;
        list(orgId?: string): Promise<unknown>;
        get(id: string, orgId?: string): Promise<unknown>;
        create(name: string, kind: string, orgId?: string): Promise<unknown>;
        addMember(id: string, account: string, role: string, orgId?: string): Promise<unknown>;
        removeMember(id: string, userId: string, orgId?: string): Promise<unknown>;
        remove(id: string, orgId?: string): Promise<unknown>;
      };
      /** K-desktop — opt-in cross-surface chat sync. Pushes the active desktop
       *  session's user/assistant turns up to /api/chat/threads (never touches
       *  the local transcript). Absent on older preloads. */
      chatSync?: {
        push(args: { workspaceRoot: string; sessionKey: string; title?: string }): Promise<{ threadId: string; messageCount: number; created: boolean; title: string }>;
        list(): Promise<Array<Record<string, unknown>>>;
      };
    };
  }
}
export {};
