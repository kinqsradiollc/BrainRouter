/**
 * Shared types + helper context that every slash-command handler receives.
 *
 * Split out from repl.ts so individual command files can be small and
 * topical. Each category file (session/memory/workflow/orchestration/…)
 * exports a `tryHandle*(ctx)` function that returns true iff it matched
 * `ctx.command`. The dispatch table in repl.ts walks them in order until
 * one returns true; if none do, the user gets the "unknown command"
 * message.
 *
 * Adding a new command means: pick the right category file, add a
 * `case '/foo':` to its switch, done. No need to edit repl.ts at all.
 */

import type readline from 'node:readline';
import type { Agent } from '../../agent/agent.js';
import type { McpClientPool as McpClientWrapper } from '../../runtime/mcpPool.js';
import type { Config } from '../../config/config.js';

/**
 * Lifecycle / REPL-scoped state that command handlers can read or mutate.
 * Defined here (rather than inside the REPL closure) so commands stay in
 * separate files without crossing closure boundaries. The REPL constructs
 * one instance per session and threads it through every dispatch call.
 */
export interface ReplContext {
  /** Refresh the readline prompt (color reflects access mode + status segments). */
  refreshPromptForMode: () => void;
  /** True while the REPL is mid-turn; loop ticks should defer when set. */
  isProcessing: () => boolean;
  /** Programmatically run an agent turn (used by /continue and friends). */
  runAgentTurn: (prompt: string) => void;
  /**
   * Awaitable variant — same semantics but the caller can attach a .finally
   * to do post-turn cleanup. Used by /side and /btw to restore the parent
   * sessionKey after the side conversation finishes.
   */
  runAgentTurnAsync: (prompt: string) => Promise<void>;
}

/**
 * Everything a command handler needs. Constructed once per dispatch in
 * the REPL line handler and passed by reference into every category's
 * try-handler.
 */
export interface CommandContext {
  /** The raw slash command (e.g. `/spawn`), lowercased. */
  command: string;
  /** Arguments after the command, already split on whitespace. */
  args: string[];
  agent: Agent;
  mcpClient: McpClientWrapper;
  config: Config;
  rl: readline.Interface;
  repl: ReplContext;
}
