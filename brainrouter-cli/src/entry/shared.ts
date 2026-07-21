import { loadConfig, type LLMConfig } from '@kinqs/brainrouter-core/config';
import {
  McpClientPool,
  resolvePreferredBrainrouterServerId,
  selectMcpServerIds,
} from '@kinqs/brainrouter-core/mcp';
import type { ServerConfig } from '@kinqs/brainrouter-core/config';

export const DEFAULT_LLM: LLMConfig = { provider: 'openai', model: 'gpt-4o-mini', apiKey: '' };

// The CLI deliberately does NOT load any `.env` file. Source of truth for
// runtime config is `~/.config/brainrouter/config.json` (LLM creds, MCP
// server profiles, theme, etc.), set interactively via the wizard / `/login`
// / `/config`. The MCP server is a separate concern and loads its own
// `server.env` from its own working directory — that's the server's
// business, not the CLI's. Shell env (real `process.env`) still flows
// through normally for everything that reads it (e.g. `OPENAI_API_KEY`
// fallback inside `callOpenAI`).

// HONK-H3.3 — best-effort push of a fleet snapshot to the configured brain so the
// dashboard console can serve it. Never throws (fleet draining must not depend on
// the brain being reachable); returns a small status for the caller to log.
export async function pushFleetSnapshotToBrain(summary: unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    const { fleetSnapshotPushArgs } = await import('../runtime/fleet/fleetCommand.js');
    const config = loadConfig();
    if (!config.servers || Object.keys(config.servers).length === 0) return { ok: false, error: 'no MCP server configured' };
    const preferredBrainrouterServerId = resolvePreferredBrainrouterServerId(
      config.servers,
      config.activeBrainrouterServer,
      config.activeServer,
    );
    const targetIds = selectMcpServerIds(
      config.servers,
      preferredBrainrouterServerId,
      undefined,
    );
    const targetServers: Record<string, ServerConfig> = {};
    for (const id of targetIds) targetServers[id] = config.servers[id];
    const llm: LLMConfig = { ...(config.llm ?? DEFAULT_LLM) };
    const pool = new McpClientPool();
    try {
      await pool.connectAll(targetServers, llm, {
        timeoutMs: 5_000,
        preferredBrainrouterServerId,
      });
      await pool.callTool('fleet_snapshot_put', fleetSnapshotPushArgs(summary as never));
      return { ok: true };
    } finally {
      await pool.close();
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
