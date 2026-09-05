/**
 * ADR-046 D2 — the runtime-invariant TRIPWIRE channel.
 *
 * The A41-14 registry (`invariants.ts`) is pull-model: each area's companion is
 * a pure predicate the verify gate runs on demand. That cannot express a
 * "something was already repaired" signal — a hot path that had to fix state
 * which should never have needed fixing. This is that missing push channel.
 *
 * The tool-call pairing sanitizer is the first reporter: under ADR-046, every
 * repair it performs is a sign that "model-visible ⟺ recorded" was already
 * broken upstream, so it reports here instead of fixing silently. Reports are
 * counted per `${area}/${name}` id and NEVER throw — production keeps working;
 * the signal is advisory. `runtimeCompositionSnapshot()` surfaces the totals so
 * the glass box shows a tripwire that fired, and the target steady state is a
 * channel that stays empty.
 *
 * Kept SEPARATE from `verifyInvariants()` on purpose: a tripwire firing is a
 * historical fact about this process, not a current-state predicate, so folding
 * it into the verify gate's violation set would make that gate depend on which
 * broken-input tests ran before it. The glass box reports it; the gate does not.
 */

interface Tally { count: number; lastDetail: string }
const totals = new Map<string, Tally>();

/**
 * Report a runtime-invariant break from a hot path. Cheap and never throws.
 * Bumps the per-id total (keeping the most recent detail for the glass box).
 */
export function noteRuntimeInvariantBreak(
  area: string,
  name: string,
  detail: string,
  _data?: Record<string, unknown>,
): void {
  const id = `${area}/${name}`;
  const prev = totals.get(id);
  totals.set(id, { count: (prev?.count ?? 0) + 1, lastDetail: detail });
}

/** Per-id firing totals, e.g. `{ 'session/tool-call-pairing': 3 }`. Empty ⇒ quiet. */
export function runtimeInvariantReportTotals(): Record<string, number> {
  return Object.fromEntries([...totals].map(([id, t]) => [id, t.count]));
}

/** Test isolation: clear the totals. */
export function resetRuntimeInvariantReports(): void {
  totals.clear();
}

/* ---------------------------------------------- the tool-call pairing tripwire */

import type { PairingRepair, PairingRepairObserver } from '../agent/guards/toolCallRecovery.js';

function pairingDetail(repair: PairingRepair): string {
  switch (repair.kind) {
    case 'dropped-orphan-result':
      return `dropped an orphan tool result${repair.toolCallId ? ` (tool_call_id=${repair.toolCallId})` : ' (no tool_call_id)'}`;
    case 'stripped-idless-calls':
      return `stripped ${repair.count ?? 0} tool_call(s) with no usable id`;
    case 'synthesized-placeholder':
      return `synthesized a placeholder result for unanswered call ${repair.toolCallId} (${repair.toolName ?? 'unknown'})`;
    case 'dropped-duplicate-call':
      return `dropped a duplicate tool_call id ${repair.toolCallId}`;
  }
}

/**
 * A `PairingRepairObserver` that reports every repair to the tripwire channel
 * under the id `session/tool-call-pairing`. Pass as the second argument to
 * `deriveModelRequest` / `sanitizeToolCallPairing`.
 */
export const reportPairingRepair: PairingRepairObserver = (repair) => {
  noteRuntimeInvariantBreak('session', 'tool-call-pairing', pairingDetail(repair));
};
