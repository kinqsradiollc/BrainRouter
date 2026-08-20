/**
 * ADR-041 D13 (A41-14, W2) — the built-in invariant companions.
 *
 * Each workspace area that guarantees a runtime invariant registers a companion
 * here (or from its own module). This file is the baseline set imported for its
 * side effect by `compositionSnapshot.ts` — the real consumer that surfaces the
 * companions in `dump-composition` and runs the verify gate. New areas add a
 * companion (with real checks, or an `emptyReason` when nothing is runtime-
 * checkable) so coverage stays exhaustive.
 */

import { registerInvariantCompanion } from './invariants.js';
import { checkLocalToolExecutorInvariants } from '../tool/registry/executors.js';

let registered = false;

/**
 * Register the built-in companions exactly once (idempotent — safe to import from
 * more than one consumer). Registration is a pure structural act; the checks run
 * only when {@link verifyInvariants} is called.
 */
export function registerBuiltinInvariantCompanions(): void {
  if (registered) return;
  registered = true;

  // The tool registry: every direct executor's declared tier / action-kind /
  // parallel-safety must match its registry entry — the drift the tool pipeline's
  // policy gate assumes away. Previously only an assert() at boot; now a first-class
  // invariant the verify gate reports on.
  registerInvariantCompanion({
    area: 'tool-registry',
    invariants: [
      {
        name: 'executor-matches-registry-entry',
        check: () => {
          const drift = checkLocalToolExecutorInvariants();
          return drift.length ? drift.join('; ') : null;
        },
      },
    ],
  });

  // Extension event domains carry the D4 "model-visible ⟺ logged" invariant: a
  // phase hook that injects model-visible context appends a transcript entry, it
  // never mutates an in-flight message array. That is a property of a control-flow
  // path, not of any inspectable runtime value, so it is enforced by its unit test
  // rather than a pure predicate — recorded here as an explicit empty companion so
  // the area is covered, not silently absent.
  registerInvariantCompanion({
    area: 'extension-events',
    invariants: [],
    emptyReason:
      'The "model-visible ⟺ logged" invariant (ADR-041 D4) is a control-flow property, ' +
      'not an inspectable runtime value; it is enforced by the phase-hook unit tests.',
  });
}
