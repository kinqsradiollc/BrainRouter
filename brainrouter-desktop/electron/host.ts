/**
 * DESK-1 — the agent host process (Electron utilityProcess).
 *
 * THE SETTINGS-REUSE CONTRACT LIVES HERE: this bootstrap deep-imports the
 * unchanged brainrouter-cli runtime and boots it exactly like `brainrouter
 * chat` does — `loadConfig()` reads the SAME `~/.config/brainrouter/
 * config.json` (profiles, cli.* knobs, permissions, hooks), the MCP pool
 * connects the SAME server profiles, and all workspace state
 * (.brainrouter/cli/ sessions, workers, plans, goals) is shared with the CLI.
 * Sign in once, configure once — both heads see it.
 */
import { createHostCore } from './hostCore.js';
// Deep imports into the CLI's built runtime (no "exports" field = allowed).
// Extracting a proper @kinqs/brainrouter-agent package is tracked for 0.4.16.
import { Agent } from '@kinqs/brainrouter-cli/dist/agent/agent.js';
import { loadConfig } from '@kinqs/brainrouter-cli/dist/config/config.js';
import { McpClientPool } from '@kinqs/brainrouter-cli/dist/runtime/mcpPool.js';
import { listTranscripts, loadTranscript } from '@kinqs/brainrouter-cli/dist/state/sessionStore.js';
import { buildRecap } from '@kinqs/brainrouter-cli/dist/state/sessionRecap.js';
import { collectRunningTasks } from '@kinqs/brainrouter-cli/dist/runtime/backgroundTasks.js';

interface ParentPortLike {
  on(event: 'message', listener: (e: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

async function main(): Promise<void> {
  const workspaceRoot = process.env.BRAINROUTER_DESKTOP_WORKSPACE || process.cwd();
  // utilityProcess gives us process.parentPort; plain `node host.js` (dev
  // smoke) falls back to a console sink so the bootstrap is runnable solo.
  const port = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
  const send = port
    ? (msg: unknown) => port.postMessage(msg)
    : (msg: unknown) => console.log(JSON.stringify(msg));

  // Identical boot recipe to `brainrouter chat` (index.ts): config → llm →
  // pool.connectAll(profiles) → Agent. Offline MCP does not block (same
  // semantics as the CLI's non-strict mode).
  const config = loadConfig();
  const llm = config.llm || { provider: 'openai', model: 'gpt-4o-mini', apiKey: '' };
  const mcpClient = new McpClientPool();
  try {
    await mcpClient.connectAll(config.servers ?? {}, llm, { timeoutMs: 5_000 });
  } catch { /* offline-mode: local tools only, same as the CLI */ }

  const agent = new Agent(mcpClient, llm, {
    workspaceRoot,
    launchCwd: workspaceRoot,
  });

  const core = createHostCore({
    agent,
    send: send as never,
    queries: {
      // Read-only surfaces — same pure modules the TUI commands use.
      'list-sessions': () => listTranscripts(workspaceRoot).slice(0, 50),
      'recap': (args) => {
        const key = typeof args.sessionKey === 'string' ? args.sessionKey : agent.sessionKey;
        return buildRecap({ entries: loadTranscript(workspaceRoot, key), sessionKey: key });
      },
      'fleet': () => collectRunningTasks(workspaceRoot),
      'session-info': () => ({ sessionKey: agent.sessionKey, model: llm.model, workspaceRoot }),
    },
    onShutdown: () => { void mcpClient.close?.(); process.exit(0); },
  });

  if (port) port.on('message', (e) => { void core.handle(e.data); });
}

main().catch((err) => {
  console.error('[brainrouter-desktop host] fatal:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
