import { getCliKnobs } from '@kinqs/brainrouter-core/config';
import { readPreferences } from '@kinqs/brainrouter-core/session';
import type { RunChatContext } from './context.js';

/**
 * `isQuiet` resolution + the idle help hint. The idle hint is a port of the
 * readline REPL's 30s discoverability nudge: single-fire per session, cancelled
 * by any user input.
 */
export function installIdleHint(ctx: RunChatContext): void {
  const { agent } = ctx;

  ctx.isQuiet = (): boolean => {
    if (getCliKnobs().quiet) return true;
    try { return readPreferences(agent.workspaceRoot).quiet === true; } catch { return false; }
  };

  // Idle help hint — port of the readline REPL's 30s discoverability nudge.
  // Single-fire per session; user input cancels.
  ctx.armIdleHint = () => {
    if (ctx.idleHintFired || !process.stdout.isTTY) return;
    if (ctx.idleHintTimer) clearTimeout(ctx.idleHintTimer);
    ctx.idleHintTimer = setTimeout(() => {
      if (ctx.idleHintFired || ctx.isProcessing || ctx.pendingContinuation || ctx.exited) return;
      ctx.idleHintFired = true;
      ctx.controller?.push.notice(
        `Tip: press ? or /help for commands, /where for current state.`,
      );
    }, 30_000);
    if (typeof (ctx.idleHintTimer as any).unref === 'function') {
      (ctx.idleHintTimer as any).unref();
    }
  };
  ctx.clearIdleHint = () => {
    if (ctx.idleHintTimer) { clearTimeout(ctx.idleHintTimer); ctx.idleHintTimer = undefined; }
  };
}
