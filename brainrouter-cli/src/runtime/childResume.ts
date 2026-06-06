/**
 * C1 (0.4.12) — auto-resume the parent loop when a spawned child outruns the
 * drain timeout.
 *
 * Before C1, a turn that spawned children which didn't finish within
 * `cli.childDrainTimeoutMs` ended by telling the user to type `/continue`. The
 * children keep running detached, but the parent loop stops — the result is
 * stranded until the user manually continues.
 *
 * C1 closes that gap: the REPL records the timed-out child ids and POLLS their
 * status; once they all settle it auto-fires a synthetic continue prompt that tells
 * the model to drain them (`wait_agents`, which now returns immediately) and
 * synthesize. This module is the PURE core — the poll decision + the prompt — so the
 * runChat watcher stays a thin, cancellable timer around it.
 */

/** The child session statuses still considered "in flight". */
const IN_FLIGHT = new Set(['running', 'pending', 'queued']);

/** Of `ids`, the ones still in flight (status running/pending), given a status
 *  lookup (a `null/undefined` status means the session vanished → treat as settled,
 *  so a pruned/gone child never blocks the resume forever). Pure. */
export function unsettledChildIds(ids: string[], statusOf: (id: string) => string | undefined | null): string[] {
  return ids.filter((id) => {
    const s = statusOf(id);
    return typeof s === 'string' && IN_FLIGHT.has(s);
  });
}

/** True once none of `ids` are in flight. Empty `ids` is vacuously settled. Pure. */
export function childrenSettled(ids: string[], statusOf: (id: string) => string | undefined | null): boolean {
  return unsettledChildIds(ids, statusOf).length === 0;
}

/**
 * The synthetic prompt fired to auto-resume the turn once the children settled. It
 * tells the model the background agents finished and to drain + synthesize — the
 * automated equivalent of the user typing `/continue`. Pure.
 */
export function buildChildResumePrompt(ids: string[]): string {
  const list = ids.join(', ');
  const idsJson = JSON.stringify(ids);
  return [
    `The background agent(s) you spawned earlier have now finished: ${list}.`,
    `Call \`wait_agents\` with ids ${idsJson} to read their results (they return immediately now), then synthesize their output and deliver the answer the user was waiting for. Do not spawn new agents.`,
  ].join('\n');
}

/**
 * MAR-2 (0.4.13) — should a child-completion EVENT fire the auto-resume immediately?
 * True only when the REPL is idle (no turn running, not exiting, no goal continuation
 * pending), some children are armed for resume, and they have ALL settled. This is the
 * event-driven fast path; the C1 poll remains the fallback (e.g. for a child that
 * vanishes without emitting a completion event). Pure.
 */
export function shouldResumeOnChildComplete(args: {
  exited: boolean;
  isProcessing: boolean;
  pendingContinuation: boolean;
  pendingIds: string[];
  allSettled: boolean;
}): boolean {
  return (
    !args.exited &&
    !args.isProcessing &&
    !args.pendingContinuation &&
    args.pendingIds.length > 0 &&
    args.allSettled
  );
}
