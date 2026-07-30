/**
 * AUTO-EXTRACTED from cli/repl.ts as part of the slash-command split.
 *
 * Thin dispatcher for the orchestration slash-command family. The command
 * bodies live in cohesive sibling modules (workers / agents / spawn /
 * federation / policy / background) + shared helpers in `_shared.ts`; this
 * file just routes `ctx.command` to the matching handler and preserves the
 * original return contract (a handled command returns the handler's boolean;
 * an unmatched command falls through to `return false`).
 */

import type { CommandContext } from '../_context.js';
import { handleWorkers, handlePack } from './workers.js';
import { handleRoles, handleAgents, handleAgent } from './agents.js';
import { handleInbox, handleHandoff, handleDm, handleBroadcast } from './federation.js';
import { handleBg, handleBuild, handleSpawn, handleWait, handleKill } from './spawn.js';
import { handleDelegationPolicy, handleAutoChain, handleAutoReview } from './policy.js';
import { handleFg, handlePs, handleStop } from './background.js';

export async function tryHandleOrchestrationCommand(ctx: CommandContext): Promise<boolean> {
  switch (ctx.command) {
    case '/workers': return handleWorkers(ctx);
    case '/pack': return handlePack(ctx);
    case '/roles': return handleRoles(ctx);
    case '/inbox': return handleInbox(ctx);
    case '/handoff': return handleHandoff(ctx);
    case '/dm': return handleDm(ctx);
    case '/broadcast': return handleBroadcast(ctx);
    case '/agents': return handleAgents(ctx);
    case '/agent': return handleAgent(ctx);
    case '/bg': return handleBg(ctx);
    case '/build': return handleBuild(ctx);
    case '/spawn': return handleSpawn(ctx);
    case '/wait': return handleWait(ctx);
    case '/delegation-policy': return handleDelegationPolicy(ctx);
    case '/auto-chain': return handleAutoChain(ctx);
    case '/auto-review': return handleAutoReview(ctx);
    case '/kill': return handleKill(ctx);
    case '/fg': return handleFg(ctx);
    case '/ps': return handlePs(ctx);
    case '/stop': return handleStop(ctx);
  }
  return false;
}
