/**
 * PR-OBS-1 — deliver background extension results into the active CLI session.
 *
 * A running turn receives a real Steer through Agent's safe-boundary inbox. If
 * the session is idle, the extension result starts a normal follow-up turn so
 * CI/review feedback never waits for another user message.
 */
import {
  drainExternalSteering,
  pendingExternalSteeringCount,
  subscribeExternalSteering,
} from '@kinqs/brainrouter-core/session';
import type { RunChatContext } from './context.js';

export function installExternalSteering(ctx: RunChatContext): void {
  let delivering = false;

  const deliver = (sessionKey: string): void => {
    if (sessionKey !== ctx.agent.sessionKey || ctx.exited) return;
    if (ctx.isProcessing) {
      const events = drainExternalSteering(sessionKey);
      for (const event of events) {
        ctx.agent.requestSteer(event.text, { id: event.id, source: 'extension' });
        ctx.controller?.push.notice(
          `${event.label ?? 'Extension event'} · Steer pending`,
          'info',
        );
      }
      return;
    }
    if (delivering) return;
    delivering = true;
    void (async () => {
      try {
        while (!ctx.exited && !ctx.isProcessing) {
          const [event, ...rest] = drainExternalSteering(sessionKey);
          for (const pending of rest) {
            ctx.agent.requestSteer(pending.text, { id: pending.id, source: 'extension' });
          }
          if (!event) break;
          ctx.controller?.push.notice(event.label ?? 'Extension event', 'info');
          await ctx.runChatTurn(event.text);
        }
      } finally {
        delivering = false;
        if (pendingExternalSteeringCount(sessionKey) > 0) deliver(sessionKey);
      }
    })();
  };

  ctx.unsubscribeExternalSteering = subscribeExternalSteering(deliver);
}
