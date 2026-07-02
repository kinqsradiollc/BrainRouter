import type { RunChatContext } from './context.js';

/**
 * C2 — the `/queue` view + management of messages typed while a turn is
 * running, plus the post-turn drain. Handled inline (like `?` and `!`) so it
 * works mid-turn without going through the turn dispatcher.
 */
export function installInputQueueHandlers(ctx: RunChatContext): void {
  const { inputQueue } = ctx;

  const queuePreview = (t: string) => { const s = t.replace(/\s+/g, ' ').trim(); return s.length > 80 ? `${s.slice(0, 80)}…` : s; };
  ctx.handleQueueCommand = (args: string[]) => {
    const sub = (args[0] ?? '').toLowerCase();
    if (sub === 'clear') {
      const n = inputQueue.clear();
      ctx.controller?.push.notice(n ? `Cleared ${n} queued message${n === 1 ? '' : 's'}.` : 'Queue already empty.', 'info');
      return;
    }
    if (sub === 'remove' || sub === 'rm') {
      const pos = Number.parseInt(args[1] ?? '', 10);
      const removed = Number.isInteger(pos) ? inputQueue.removeAt(pos) : undefined;
      ctx.controller?.push.notice(
        removed ? `Removed queued message ${pos}: "${queuePreview(removed.text)}"` : `No queued message at position "${args[1] ?? ''}". Use /queue to list.`,
        removed ? 'info' : 'warn',
      );
      return;
    }
    const items = inputQueue.list();
    if (items.length === 0) { ctx.controller?.push.notice('Input queue is empty.', 'info'); return; }
    ctx.controller?.push.notice(`Queued (${items.length}) — drained after the current turn · /queue remove <n> · /queue clear:`, 'info');
    items.forEach((it, i) => ctx.controller?.push.notice(`  ${i + 1}. ${queuePreview(it.text)}`, 'info'));
  };

  // C2 — after a turn settles, run the next queued message iff nothing else owns the
  // next turn (a goal continuation or a child auto-resume takes precedence).
  ctx.drainInputQueue = () => {
    setImmediate(() => {
      if (ctx.isProcessing || ctx.pendingContinuation || ctx.childResumeTimer || ctx.exited) return;
      const next = inputQueue.dequeue();
      if (!next) return;
      const remaining = inputQueue.size;
      ctx.controller?.push.notice(`(running queued message${remaining ? ` — ${remaining} more queued` : ''})`, 'info');
      void ctx.runChatTurn(next.text);
    });
  };
}
