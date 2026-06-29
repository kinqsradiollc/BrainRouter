import type { AgentCommand, AgentEventMessage } from '@kinqs/brainrouter-agent-protocol';

declare global {
  interface Window {
    /** The preload bridge — the renderer's only capability surface. */
    brainrouter: {
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
      /** T1 — cross-workspace dashboard: running tasks + last review gate per recent root. */
      globalDashboard?(): Promise<{ workspaces: Array<{ workspaceRoot: string; tasks: Array<Record<string, unknown>>; reviewGate: { status: string; blocked: boolean; reason: string } | null }> }>;
      getZoomFactor?(): number;
      setZoomFactor?(factor: number): void;
    };
  }
}
export {};
