/**
 * Shared MCP subsystem types.
 *
 * Extracted so the single-client wrapper, the pool, and the pure helper modules
 * can reference the same shapes without importing each other (avoids circular
 * imports between `client.ts` and `pool/*`).
 */

/** Who an MCP profile belongs to. `brainrouter` = the memory/brain plane. */
export type McpIdentity = 'brainrouter' | 'third-party' | 'unknown';

export type McpServerStatus = {
  serverId: string;
  identity: McpIdentity;
  /** 'connected' once the underlying wrapper reports isConnected. */
  status: 'connected' | 'connecting' | 'offline' | 'failed';
  /** Filled after the first successful listTools (used by /mcp list). */
  toolCount?: number;
  /** Per-server error message when status === 'failed'. */
  error?: string;
};

/** Result of a {@link probeBrainHealth} call. `ok` ⇒ the remote answered 2xx. */
export interface BrainHealth {
  ok: boolean;
  status?: number;
  error?: string;
}
