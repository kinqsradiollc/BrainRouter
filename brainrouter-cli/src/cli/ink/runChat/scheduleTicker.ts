import { startScheduleTicker } from '../../../runtime/background/scheduleTicker.js';
import type { RunChatContext } from './context.js';

/**
 * Background `/schedule` ticker. Single in-process timer; fires due
 * cron/one-shot jobs by re-injecting their slash command through the same
 * dispatcher the user uses. Filtered by sessionKey so a tick only fires jobs
 * owned by THIS REPL — schedules registered in a different session sit idle
 * until that session is open. Stopped in the `waitUntilExit` handlers so
 * /exit and ^C clean up.
 */
export function installScheduleTicker(ctx: RunChatContext): void {
  const { agent, shim } = ctx;

  ctx.startTicker = () => {
    if (ctx.scheduleTicker) return;
    ctx.scheduleTicker = startScheduleTicker({
      workspaceRoot: agent.workspaceRoot,
      sessionKey: agent.sessionKey,
      fire: (command, sched) => {
        if (!ctx.controller) return;
        if (ctx.isProcessing) {
          // Catch-up rule: only fire ONCE per missed window. The ticker
          // has already advanced nextRun past `now`, so silently
          // dropping a busy-session fire is correct — it won't refire
          // for the same minute.
          ctx.controller.push.notice(`(schedule ${sched.id} fired while a turn was in flight — skipped)`, 'warn');
          return;
        }
        const parts = command.trim().split(/\s+/);
        const cmd = parts[0].toLowerCase();
        const args = parts.slice(1);
        ctx.controller.push.notice(`⏰ Schedule ${sched.id} → ${command}`, 'info');
        void ctx.dispatchSlash(cmd, args, shim);
      },
      onError: (msg) => ctx.controller?.push.notice(`[schedule] ${msg}`, 'warn'),
    });
  };
}
