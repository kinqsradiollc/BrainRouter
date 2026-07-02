/**
 * AUTO-EXTRACTED from cli/repl.ts as part of the slash-command split.
 * Hand-tune imports if the compiler complains.
 *
 * God-file breakdown: the per-command handler bodies now live in cohesive
 * sibling modules under ./orchestration/*. This file stays a thin dispatch
 * barrel that reproduces the original public surface
 * (`tryHandleOrchestrationCommand`) — it walks the domain handlers in order
 * and returns the first that claims the command, exactly like the original
 * single `switch (command)` did (an unmatched command, or a matched command
 * that fell through a `break`, yields `false`).
 */

import type { CommandContext } from './_context.js';
import { handleWorkersCommand } from './orchestration/workers.js';
import { handleFederationCommand } from './orchestration/federation.js';
import { handleAgentsCommand } from './orchestration/agents.js';
import { handleSpawnCommand } from './orchestration/spawn.js';
import { handlePolicyCommand } from './orchestration/policy.js';
import { handleBackgroundCommand } from './orchestration/background.js';

export async function tryHandleOrchestrationCommand(ctx: CommandContext): Promise<boolean> {
  if (await handleWorkersCommand(ctx)) return true;
  if (await handleFederationCommand(ctx)) return true;
  if (await handleAgentsCommand(ctx)) return true;
  if (await handleSpawnCommand(ctx)) return true;
  if (await handlePolicyCommand(ctx)) return true;
  if (await handleBackgroundCommand(ctx)) return true;
  return false;
}
