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
import { requiredCoreCapabilityCatalog } from '../extension/builtin/capabilities.js';
import { REQUIRED_CORE_TOOL_CATALOG } from '../extension/builtin/toolCatalog.js';

/**
 * ADR-046 D1/D3 — every required-core tool is activated by exactly one
 * capability, and capabilities name only real catalog tools. A drift either way
 * makes the built-in surface unactivatable; here it is a first-class runtime
 * invariant (also byte-gated by the capability-catalog drift test).
 */
function capabilityCoverageViolation(): string | null {
  const capabilities = requiredCoreCapabilityCatalog();
  const catalogNames = new Set(REQUIRED_CORE_TOOL_CATALOG.map((t) => t.name));
  const owners = new Map<string, string[]>();
  const problems: string[] = [];
  for (const [capability, tools] of Object.entries(capabilities)) {
    for (const tool of tools) {
      if (!catalogNames.has(tool)) problems.push(`capability "${capability}" names unknown tool "${tool}"`);
      owners.set(tool, [...(owners.get(tool) ?? []), capability]);
    }
  }
  for (const tool of catalogNames) {
    const list = owners.get(tool) ?? [];
    if (list.length !== 1) problems.push(`tool "${tool}" is activated by ${list.length} capabilities (expected 1)`);
  }
  return problems.length ? problems.join('; ') : null;
}

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

  // ADR-046 D1/D3 — the built-in tool/capability mapping is a runtime invariant.
  registerInvariantCompanion({
    area: 'tool-capabilities',
    invariants: [
      { name: 'every-tool-has-exactly-one-capability', check: capabilityCoverageViolation },
    ],
  });

  // ADR-046 D2 — the session history→model-request derivation ("model-visible ⟺
  // recorded"). Like extension-events, it is a control-flow property enforced by
  // the shared-derivation test (deriveModelRequest), not an inspectable value;
  // when the sanitizer must repair recorded state, the tool-call pairing TRIPWIRE
  // (runtime/invariantReports) records it and the composition snapshot surfaces
  // the count — a push channel, deliberately outside the pull-model verify gate.
  registerInvariantCompanion({
    area: 'session-history',
    invariants: [],
    emptyReason:
      'The "model-visible ⟺ recorded" invariant (ADR-046 D2) is enforced by the shared ' +
      'deriveModelRequest derivation (live and resume share one projection). Repairs to ' +
      'recorded state are reported through the tool-call pairing tripwire (runtime/' +
      'invariantReports), surfaced in the composition snapshot, not as a verify-gate violation.',
  });
}
