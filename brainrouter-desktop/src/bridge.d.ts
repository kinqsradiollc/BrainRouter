import type { AgentCommand, AgentEventMessage } from '@kinqs/brainrouter-agent-protocol';

declare global {
  interface Window {
    /** The preload bridge — the renderer's only capability surface. */
    brainrouter: {
      send(command: AgentCommand): void;
      onEvent(listener: (msg: AgentEventMessage) => void): () => void;
      addWorkspace(): Promise<{ opened: boolean; workspaceRoot?: string }>;
      workspaceRecents(): Promise<{ current: string | null; recents: string[] }>;
      openWorkspace(workspaceRoot: string): Promise<{ opened: boolean }>;
    };
  }
}
export {};
