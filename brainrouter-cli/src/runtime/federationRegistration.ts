/**
 * Federation Stage 2 (0.4.0) — CLI side of the active-session registry.
 *
 * Calls `session_register` once at REPL startup to claim a row in the
 * brain's `active_sessions` table, then heartbeats every 30s to keep
 * it fresh. The brain's stale-session sweeper drops rows after 5
 * minutes of no heartbeat (FED-S2-T5), so a hard-killed CLI cleans
 * itself up automatically — no graceful-shutdown hook required.
 *
 * Re-registers transparently when the brain returns `updated: false`
 * (the registry row was already swept). That keeps the federation view
 * resilient across `npm run dev` restarts of the brain.
 */

import { randomUUID } from 'node:crypto';
import type { McpClientPool } from './mcpPool.js';
import { callMcpTool, hasMcpTool } from './mcpUtils.js';

const HEARTBEAT_INTERVAL_MS = 30 * 1000;

/**
 * Mint a federation sessionKey for *this CLI process*.
 *
 * Intentionally per-process, not per-workspace: two terminals open in
 * the same directory must show as two distinct rows in
 * `/agents --remote`. We deliberately do NOT persist this anywhere on
 * disk — file-based persistence collapsed concurrent terminals into
 * one row, which is the opposite of what federation should surface.
 *
 * Restart hygiene comes from the other end of the lifecycle:
 *   - `FederationHandle.stop()` calls `session_unregister` best-effort
 *     on clean exit, so a graceful `/exit` removes the row immediately
 *     and `/agents --remote` doesn't show a 2-min ghost.
 *   - The brain's stale-session sweeper (5 min) is the safety net for
 *     hard kills, OOMs, and lost-network scenarios where unregister
 *     never lands.
 *
 * The agent's *chat* sessionKey is a separate concept (also per-launch).
 * This is purely the federation identity.
 */
export function resolveFederationSessionKey(_workspaceRoot: string): string {
  return randomUUID();
}

export interface FederationHandle {
  sessionKey: string;
  clientKind: string;
  /**
   * Best-effort graceful shutdown: stops the heartbeat timer AND fires
   * a one-shot `session_unregister` so the brain drops the row
   * immediately. Awaits the unregister with a short timeout so a slow
   * brain can't hang `/exit`. Errors are swallowed — the brain's 5-min
   * sweeper handles whatever this misses.
   */
  stop(): Promise<void>;
}

export interface FederationOptions {
  mcpClient: McpClientPool;
  sessionKey: string;
  workspaceRoot: string;
  /** Default `brainrouter-cli`. */
  clientKind?: string;
  /** Optional usage snapshot provider — called on every heartbeat. */
  getUsage?: () => UsageSnapshot | undefined;
  /** Override the 30s heartbeat cadence (mostly for tests). */
  intervalMs?: number;
}

export interface UsageSnapshot {
  promptTokens?: number;
  completionTokens?: number;
  cachedPromptTokens?: number;
  totalUsd?: number;
  cacheSavingsUsd?: number;
}

export async function attachFederation(options: FederationOptions): Promise<FederationHandle | null> {
  const tools = await safeListTools(options.mcpClient);
  const toolNames = new Set(tools.map((t) => t.name));
  if (!hasMcpTool(toolNames, 'session_register') || !hasMcpTool(toolNames, 'session_heartbeat')) {
    // Brain doesn't expose the registry yet (pre-0.4.0 brain).
    return null;
  }

  const clientKind = options.clientKind ?? 'brainrouter-cli';
  const intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;

  await registerOnce(options, clientKind);

  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    void heartbeatOnce(options, clientKind);
  }, intervalMs);
  // Deliberately NOT calling `timer.unref()`. The Ink REPL's stdin
  // handler keeps the event loop alive while a user is typing, but
  // when the user leaves the terminal idle Ink's internal state can
  // drop to a point where the heartbeat is the only thing left. With
  // `unref()`, Node would consider the loop idle, drain, and stop
  // firing the timer — sessions die after ~5 min even though the
  // process is still attached and rendering. The REPL's `finally`
  // block calls `handle.stop()` on exit, which clears the interval
  // explicitly, so we don't need `unref()` to allow shutdown.
  return {
    sessionKey: options.sessionKey,
    clientKind,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await unregisterOnce(options);
    },
  };
}

async function unregisterOnce(options: FederationOptions): Promise<void> {
  // Hard timeout: a slow or dead brain must not block `/exit`. 1.5 s
  // is generous for a local HTTP MCP and tight enough that a network
  // partition won't make the user wait visibly.
  const UNREGISTER_TIMEOUT_MS = 1_500;
  await Promise.race([
    callMcpTool(options.mcpClient, 'session_unregister', { sessionKey: options.sessionKey })
      .catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, UNREGISTER_TIMEOUT_MS)),
  ]);
}

async function safeListTools(mcp: McpClientPool): Promise<Array<{ name: string }>> {
  try {
    const res = await mcp.listTools();
    const tools = (res as { tools?: Array<{ name: string }> }).tools ?? [];
    return tools.map((t) => ({ name: t.name }));
  } catch {
    return [];
  }
}

async function registerOnce(options: FederationOptions, clientKind: string): Promise<void> {
  try {
    await callMcpTool(options.mcpClient, 'session_register', {
      sessionKey: options.sessionKey,
      clientKind,
      workspaceRoot: options.workspaceRoot,
      metadata: { pid: process.pid },
      usage: options.getUsage?.(),
    });
  } catch {
    // Brain unreachable / transient — heartbeat loop will re-attempt
    // via re-register-on-falsy-update.
  }
}

async function heartbeatOnce(options: FederationOptions, clientKind: string): Promise<void> {
  try {
    const res = await callMcpTool<{ updated: boolean }>(options.mcpClient, 'session_heartbeat', {
      sessionKey: options.sessionKey,
      usage: options.getUsage?.(),
    });
    if (res.isError) return;
    if (res.parsed?.updated === false) {
      // Row was swept (or never existed). Re-register so the next tick
      // hits a live row again.
      await registerOnce(options, clientKind);
    }
  } catch {
    // Swallow network blips — the next tick gets another chance.
  }
}
