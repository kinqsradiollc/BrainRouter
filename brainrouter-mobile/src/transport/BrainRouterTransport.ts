/**
 * BrainRouterTransport — the single seam the whole app talks to (technical-doc
 * §6). It mirrors the desktop preload bridge (`window.brainrouter`): the
 * bidirectional AgentCommand/AgentEvent stream (`send`/`onEvent`), the
 * `query`/`query-result` request/response sub-protocol, and the Layer-1
 * promise methods. Screens depend ONLY on this interface; `RemoteTransport`
 * (WebSocket) and `MockTransport` are interchangeable implementations.
 */
import type { AgentCommand, AgentEventMessage } from './protocol';

/** Live connection state surfaced to the UI (Offline marks data stale). */
export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'offline';

/** Cross-workspace dashboard (mirrors the desktop `globalDashboard` shape). */
export interface GlobalDashboard {
  workspaces: Array<{
    workspaceRoot: string;
    tasks: Array<Record<string, unknown>>;
    reviewGate: { status: string; blocked: boolean; reason: string } | null;
  }>;
}

export interface WorkspaceRecents {
  current: string | null;
  recents: string[];
}

export interface WorkspaceSessionsResult {
  rows: Array<Record<string, unknown>>;
  truncated?: boolean;
  error?: string;
}

export interface BrainRouterTransport {
  // ── Agent channel (bidirectional stream) ──
  /** start-turn, interrupt, interaction-response, set-model, query, … */
  send(cmd: AgentCommand): void;
  /** Subscribe to the inbound event stream; returns an unsubscribe fn. */
  onEvent(fn: (msg: AgentEventMessage) => void): () => void;

  // ── query / query-result sub-protocol ──
  /** Correlated request/response read; resolves the matching query-result. */
  query<T = unknown>(name: string, args?: unknown): Promise<T>;

  // ── Layer-1 promise methods (mirror the preload bridge) ──
  workspaceRecents(): Promise<WorkspaceRecents>;
  workspaceSessions(root: string, limit?: number): Promise<WorkspaceSessionsResult>;
  openWorkspace(root: string): Promise<{ opened: boolean; needsTrust?: boolean }>;
  isWorkspaceTrusted(root: string): Promise<{ trusted: boolean }>;
  trustWorkspace(root: string): Promise<{ trusted: boolean }>;
  untrustWorkspace(root: string): Promise<{ trusted: boolean }>;
  trustedWorkspaces(): Promise<{ trusted: string[] }>;
  markActivity(root: string, reason: string): Promise<{ ok: boolean }>;
  reorderWorkspace(dragged: string, target: string): Promise<{ recents: string[] }>;
  globalDashboard(): Promise<GlobalDashboard>;

  // ── Connection lifecycle ──
  status(): ConnectionStatus;
  onStatus(fn: (s: ConnectionStatus) => void): () => void;
  /** Tear down the connection / listeners. */
  dispose(): void;
}
