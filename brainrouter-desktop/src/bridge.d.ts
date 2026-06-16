import type { AgentCommand, AgentEventMessage } from '@kinqs/brainrouter-agent-protocol';

declare global {
  interface Window {
    /** The preload bridge — the renderer's only capability surface. */
    brainrouter: {
      send(command: AgentCommand): void;
      onEvent(listener: (msg: AgentEventMessage) => void): () => void;
      /** Folder picker ONLY — returns the picked path; the renderer runs the
       * trust gate and then calls openWorkspace (DESK-5d). */
      addWorkspace(): Promise<{ opened: boolean; workspaceRoot?: string }>;
      workspaceRecents(): Promise<{ current: string | null; recents: string[] }>;
      /** Swaps the agent host to this workspace INSIDE the current window.
       *  `needsTrust` is returned when main refused an untrusted workspace. */
      openWorkspace(workspaceRoot: string): Promise<{ opened: boolean; needsTrust?: boolean }>;
      /** T1 — workspace trust, backed by the shared CLI store (not localStorage). */
      isWorkspaceTrusted(workspaceRoot: string): Promise<{ trusted: boolean }>;
      trustWorkspace(workspaceRoot: string): Promise<{ trusted: boolean }>;
      untrustWorkspace(workspaceRoot: string): Promise<{ trusted: boolean }>;
      trustedWorkspaces(): Promise<{ trusted: string[] }>;
    };
  }
}
export {};
