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

import type { McpClientPool } from './mcpPool.js';
import { callMcpTool, hasMcpTool } from './mcpUtils.js';

const HEARTBEAT_INTERVAL_MS = 30 * 1000;

export interface FederationHandle {
  sessionKey: string;
  clientKind: string;
  stop(): void;
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
  // Don't keep the process alive just for heartbeats — the REPL owns
  // the lifetime.
  timer.unref?.();

  return {
    sessionKey: options.sessionKey,
    clientKind,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
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
