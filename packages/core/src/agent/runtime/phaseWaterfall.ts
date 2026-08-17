// ADR-041 D4b.2 — the hot-path phase waterfall + the logged invariant.
//
// D4b.1 landed the phase-hook mechanism (register/select) and the serial,
// advisory `turn-end` firing. This module adds the OTHER half the ADR calls for:
// the *waterfall* interception on the hot path (`provider-call`, tool
// `pre-execute`). Unlike the `turn-end` broadcast, these handlers form an ordered
// chain and each receives a `next()` continuation. Per ADR §D4:
//
//   "A handler may pass through, rewrite the payload before delegating, or refuse
//    to call next() and thereby reject the step / call outright."
//
// This is what separates "an extension can watch the loop" from "an extension can
// *be part of* the loop." The wrapped operation runs only if every handler
// delegates; the first handler that returns without calling next() rejects it.
//
// The module is pure — it imports only the phase-hook types and knows nothing of
// the model call or the tool runtime, so the semantics are provable in isolation
// before they are wired onto the agent's most critical path.

import type { PhaseHookContext, PhaseHookHandler } from '../../extension/registry.js';

export interface PhaseWaterfallContribution {
  handler: PhaseHookHandler;
  /** The registering extension id — reported as `refusedBy` when it rejects. */
  from: string;
}

export interface WaterfallOutcome<R> {
  /** True iff the wrapped operation actually ran (no handler refused). */
  ran: boolean;
  /** The operation's result — present iff `ran`. */
  result?: R;
  /** The `from` of the handler that refused (returned without calling next), if any. */
  refusedBy?: string;
}

/**
 * Run `handlers` as an ordered waterfall around `operation`. Each handler's
 * `before(ctx, next)` wraps the continuation (onion order: the first handler is
 * outermost). Calling `next()` delegates inward — to the next handler and, at the
 * centre, to `operation`. Returning without calling `next()` refuses: the
 * operation does not run and `ran` is false.
 *
 * A handler that throws propagates — the hot-path phases (`provider-call`, tool
 * `pre-execute`) are NOT advisory, unlike `turn-end`. Calling `next()` more than
 * once is a programming error and throws.
 */
export async function runPhaseWaterfall<R>(
  handlers: readonly PhaseWaterfallContribution[],
  ctx: PhaseHookContext,
  operation: () => Promise<R>,
): Promise<WaterfallOutcome<R>> {
  let ran = false;
  let result: R | undefined;
  let refusedBy: string | undefined;

  // Innermost link: the operation itself. Reached only when every handler delegates.
  let chain: () => Promise<void> = async () => {
    ran = true;
    result = await operation();
  };

  for (let i = handlers.length - 1; i >= 0; i -= 1) {
    const { handler, from } = handlers[i];
    const downstream = chain;
    chain = async () => {
      if (!handler.before) {
        await downstream();
        return;
      }
      let delegated = false;
      const next = async (): Promise<void> => {
        if (delegated) {
          throw new Error('ADR-041 D4b — a phase hook called next() more than once.');
        }
        delegated = true;
        await downstream();
      };
      await handler.before(ctx, next);
      // Returned without delegating ⇒ this handler refuses the operation. Record the
      // deepest handler that was reached and refused (the one that stopped the chain).
      if (!delegated && !ran && refusedBy === undefined) {
        refusedBy = from;
      }
    };
  }

  await chain();
  return { ran, result, ...(refusedBy !== undefined ? { refusedBy } : {}) };
}
