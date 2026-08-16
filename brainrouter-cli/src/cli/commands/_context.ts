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
import type { Agent } from '@kinqs/brainrouter-core/agent';
import type { McpClientPool as McpClientWrapper } from '@kinqs/brainrouter-core/mcp';
import type { Config } from '@kinqs/brainrouter-core/config';
import type { ExecutionIntentHandle } from '@kinqs/brainrouter-types/agent';
import type { FederationHandle } from '../../runtime/federation/federationRegistration.js';

/**
 * ADR-040 A40-2 — host-owned metadata for one agent turn. Execution intent is opaque
 * and never embedded in the model-visible prompt; only an explicit host action
 * supplies it, while ordinary and compatibility turns omit it.
 */
export interface RunAgentTurnOptions {
  agent?: Agent;
  ephemeral?: boolean;
  executionIntent?: ExecutionIntentHandle;
  /** ADR-040 A40-9 — explicit-strategy launch previewed and confirmed via `/runs start`. */
  explicitStrategyId?: string;
}

/**
 * Lifecycle / REPL-scoped state that command handlers can read or mutate.
 * Defined here (rather than inside the REPL closure) so commands stay in
 * separate files without crossing closure boundaries. The REPL constructs
 * one instance per session and threads it through every dispatch call.
 */
export interface ReplContext {
  /** One participant's unified local + remote session-messaging surface. */
  federation?: FederationHandle | null;
  /** Refresh the readline prompt (color reflects access mode + status segments). */
  refreshPromptForMode: () => void;
  /** Replace the startup banner in the active chat scrollback, if the UI supports it. */
  replaceBanner?: (text: string) => void;
  /** True while the REPL is mid-turn; loop ticks should defer when set. */
  isProcessing: () => boolean;
  /** Programmatically run an agent turn (used by /continue and friends). */
  runAgentTurn: (prompt: string, options?: RunAgentTurnOptions) => void;
  /**
   * Awaitable variant. `/side` and `/btw` supply an isolated Agent and mark the
   * turn ephemeral so the shared renderer can skip durable REPL side effects.
   */
  runAgentTurnAsync: (
    prompt: string,
    options?: RunAgentTurnOptions,
  ) => Promise<void>;
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
