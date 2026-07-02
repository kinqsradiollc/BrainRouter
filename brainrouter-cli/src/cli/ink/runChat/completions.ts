import { getCliKnobs } from '@kinqs/brainrouter-core/config';
import { listSessions } from '@kinqs/brainrouter-core/orchestration';
import { listWorkers } from '@kinqs/brainrouter-core/worker';
import { listRuns } from '@kinqs/brainrouter-core/workflow';
import { newlyTerminal, formatCompletionNotice, type CompletionItem } from '../../../runtime/completionNotices.js';
import type { RunChatContext } from './context.js';

/**
 * PARITY-W3 — idle background-completion notifications. Each tick we diff the
 * set of terminal background actors (child agents, workers, workflow runs)
 * against what we've already announced; anything new is surfaced as a
 * print-above-prompt notice when the composer is idle. The baseline of
 * already-terminal actors is seeded here so only completions that happen
 * AFTER this session opened are announced.
 */
export function installCompletions(ctx: RunChatContext): void {
  const { agent, notifiedCompletions } = ctx;

  ctx.collectTerminalCompletions = (): CompletionItem[] => {
    const items: CompletionItem[] = [];
    try {
      for (const s of listSessions(agent.workspaceRoot)) {
        if (s.status === 'completed' || s.status === 'failed') {
          const label = s.label ? `"${s.label}"` : s.id;
          items.push({ id: `agent:${s.id}`, label: `agent ${label} ${s.status}`, ok: s.status === 'completed' });
        }
      }
    } catch { /* ignore */ }
    try {
      for (const w of listWorkers(agent.workspaceRoot)) {
        if (w.status === 'completed' || w.status === 'failed') {
          items.push({ id: `wkr:${w.id}`, label: `worker ${w.id} (${w.role}) ${w.status}`, ok: w.status === 'completed' });
        }
      }
    } catch { /* ignore */ }
    try {
      for (const r of listRuns(agent.workspaceRoot)) {
        if (r.status === 'completed' || r.status === 'failed' || r.status === 'interrupted') {
          items.push({ id: `run:${r.slug}`, label: `workflow ${r.slug} ${r.status}`, ok: r.status === 'completed' });
        }
      }
    } catch { /* ignore */ }
    return items;
  };
  ctx.notifyIdleCompletions = (): void => {
    const fresh = newlyTerminal(notifiedCompletions, ctx.collectTerminalCompletions());
    for (const item of fresh) {
      // Only announce (and mark seen) when idle — a completion observed
      // mid-turn stays unseen so it surfaces once the user is back at the
      // prompt rather than scrolling past under the active turn.
      if (ctx.isProcessing || ctx.pendingContinuation || ctx.exited || !ctx.controller) continue;
      notifiedCompletions.add(item.id);
      ctx.controller.push.notice(formatCompletionNotice(item), item.ok ? 'info' : 'warn');
      try { if (getCliKnobs().notifyBell && process.stdout.isTTY) process.stdout.write(''); } catch { /* bell is best-effort */ }
    }
  };
  // Establish the baseline of already-terminal actors so only completions that
  // happen AFTER this session opened are announced.
  try { for (const item of ctx.collectTerminalCompletions()) notifiedCompletions.add(item.id); } catch { /* noop */ }
}
