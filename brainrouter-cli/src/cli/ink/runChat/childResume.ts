import { listSessions } from '@kinqs/brainrouter-core/orchestration';
import { childrenSettled, buildChildResumePrompt, shouldResumeOnChildComplete } from '@kinqs/brainrouter-core/util';
import type { RunChatContext } from './context.js';

// C1 — auto-resume after a turn whose child drain TIMED OUT. Poll the timed-out
// children; once they all settle, fire a synthetic continue prompt (drain +
// synthesize) so the stranded result is delivered without a manual /continue. The
// user's next keystroke cancels it (handled in onSubmit). A goal continuation, if
// queued, takes precedence (it owns the next turn).
const CHILD_RESUME_POLL_MS = 2500;
const CHILD_RESUME_MAX_WAIT_MS = 10 * 60 * 1000;

/**
 * Background-child auto-resume — both the C1 timed-out-drain poll and the
 * MAR-2 event-driven delivery when a child completes while the REPL is idle.
 */
export function installChildResume(ctx: RunChatContext): void {
  const { agent } = ctx;

  // C1 — interval that polls timed-out children and auto-resumes once they settle.
  ctx.cancelChildResume = (): boolean => {
    if (!ctx.childResumeTimer) return false;
    clearInterval(ctx.childResumeTimer);
    ctx.childResumeTimer = null;
    return true;
  };

  ctx.scheduleChildResume = () => {
    const ids = [...agent.lastTurnPendingChildIds];
    if (ids.length === 0 || ctx.pendingContinuation) return;
    ctx.cancelChildResume();
    const startedAt = Date.now();
    ctx.controller?.push.notice(
      `(auto-resume armed — watching ${ids.length} background agent${ids.length === 1 ? '' : 's'}; type anything to cancel)`,
      'info',
    );
    ctx.childResumeTimer = setInterval(() => {
      if (ctx.exited) { ctx.cancelChildResume(); return; }
      if (ctx.isProcessing) return; // a turn is running — wait for it to settle
      const statusById = new Map(listSessions(agent.workspaceRoot).map((s) => [s.id, s.status]));
      if (!childrenSettled(ids, (id) => statusById.get(id))) {
        if (Date.now() - startedAt > CHILD_RESUME_MAX_WAIT_MS) {
          ctx.cancelChildResume();
          ctx.controller?.push.notice('(auto-resume gave up after 10m — type /continue when the agents finish)', 'warn');
        }
        return;
      }
      ctx.cancelChildResume();
      ctx.controller?.push.notice('(background agents finished — resuming)', 'info');
      void ctx.runChatTurn(buildChildResumePrompt(ids));
    }, CHILD_RESUME_POLL_MS);
  };

  // MAR-2 — event-driven delivery. When a background child COMPLETES while the REPL
  // is idle, deliver its result NOW (fire the same synthesize-continue the C1 poll
  // would) instead of waiting for the next poll tick — and crucially still deliver it
  // after the poll has given up. The poll stays as the fallback; the next keystroke
  // cancels both (handled in onSubmit).
  ctx.maybeResumeOnChildComplete = () => {
    const ids = [...agent.lastTurnPendingChildIds];
    const statusById = ids.length
      ? new Map(listSessions(agent.workspaceRoot).map((s) => [s.id, s.status]))
      : new Map<string, string>();
    const allSettled = childrenSettled(ids, (id) => statusById.get(id));
    if (!shouldResumeOnChildComplete({ exited: ctx.exited, isProcessing: ctx.isProcessing, pendingContinuation: ctx.pendingContinuation, pendingIds: ids, allSettled })) return;
    ctx.cancelChildResume();
    ctx.controller?.push.notice('(background agent finished — resuming)', 'info');
    void ctx.runChatTurn(buildChildResumePrompt(ids));
  };
}
