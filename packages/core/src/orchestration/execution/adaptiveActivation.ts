/**
 * ADR-040 A40-8 — bounded activation for adaptive profile selection.
 *
 * A40-8 has four parts and only three of them are buildable today. This module
 * is those three: decide whether a turn is ELIGIBLE for adaptive selection,
 * keep `direct` as the safe baseline, and expose diagnostics for what happened.
 *
 * The fourth part — "pass fresh/elliptical/contextless conversation corpora
 * before changing any profile's default" — is a gate on CHANGING DEFAULTS, not
 * on wiring. So the wiring lands and every profile default stays exactly where
 * it is. `DEFAULTS_ARE_CORPUS_GATED` below is not decoration: it is the switch
 * that would have to be flipped deliberately, by someone who has the corpus
 * results in front of them, and the test suite asserts it is still off.
 *
 * Writing a synthetic corpus to turn it on would defeat the only thing the gate
 * exists for. A corpus is collected, not authored by the system it judges.
 */

/**
 * Whether adaptive selection is permitted to change a profile's DEFAULT.
 * Stays false until the corpora in A40-8 exist and pass. Flipping it is a
 * decision with evidence behind it, not a code tidy-up.
 */
export const DEFAULTS_ARE_CORPUS_GATED = true;

export type AdaptiveIneligibilityReason =
  | 'explicit-strategy'
  | 'not-adaptive-mode'
  | 'not-top-level'
  | 'no-workspace-definition';

export interface AdaptiveEligibilityInput {
  /** True for a top-level user-authored turn; false for a child/stage turn. */
  topLevel: boolean;
  /** The user named a strategy, so nothing may override them. */
  explicitStrategyId?: string | null;
  /** Workspace orchestration mode. Only `adaptive` opts in. */
  mode?: string | null;
  hasDefinition: boolean;
  /**
   * Present or absent, a goal changes NOTHING here. ADR-040 §0: goal presence
   * alone must not enable routing or create a different selection path. It is
   * accepted as input purely so that this stays testable as a non-factor.
   */
  goalActive?: boolean;
}

export interface AdaptiveEligibility {
  eligible: boolean;
  reason?: AdaptiveIneligibilityReason;
}

/**
 * Is this turn eligible for adaptive selection?
 *
 * Order matters: an explicit user choice is checked FIRST, so that a user who
 * named a strategy is never told they were ineligible for some other reason.
 * The most specific true answer is the useful one.
 */
export function adaptiveEligibility(input: AdaptiveEligibilityInput): AdaptiveEligibility {
  if (input.explicitStrategyId) return { eligible: false, reason: 'explicit-strategy' };
  if (!input.topLevel) return { eligible: false, reason: 'not-top-level' };
  if (!input.hasDefinition) return { eligible: false, reason: 'no-workspace-definition' };
  if (input.mode !== 'adaptive') return { eligible: false, reason: 'not-adaptive-mode' };
  return { eligible: true };
}

export interface AdaptiveDiagnostics {
  /** What the turn resolved to. `direct` when anything went wrong. */
  strategyId: string;
  /** How that was arrived at, for the execution map's `selectionSource`. */
  source: 'explicit-user' | 'adaptive' | 'workspace-default' | 'fallback-direct';
  eligible: boolean;
  ineligibilityReason?: AdaptiveIneligibilityReason;
  /** Present only when the managed selector ran and fell back. */
  fallbackReason?: string;
  /** True while defaults remain corpus-gated. Surfaced, never inferred. */
  defaultsGated: boolean;
}

/** The safe baseline. When anything is uncertain, this is the answer. */
export const SAFE_BASELINE_STRATEGY = 'direct';

/**
 * A40-8 live gate invariant. The corpus gate bars the SYSTEM from moving a
 * default without evidence — so while it is shut, a model-influenced selection
 * (`adaptive-model`) is legitimate only when it narrowed to a workspace-defined,
 * signal-matched strategy. A `adaptive-model` selection with no signal behind it
 * would be a default moving on its own, which is exactly what the gate forbids.
 * The resolver already guarantees this; calling it per turn makes the gate a
 * runtime invariant instead of a constant a later change could outgrow.
 */
export function assertCorpusGateHonored(selection: {
  selectionSource: string;
  matchedSignalCount: number;
}): void {
  if (
    DEFAULTS_ARE_CORPUS_GATED
    && selection.selectionSource === 'adaptive-model'
    && selection.matchedSignalCount === 0
  ) {
    throw new Error(
      'ADR-040 A40-8: corpus-gated defaults — an adaptive selection must narrow to a '
      + 'workspace-defined, signal-matched strategy, never a system default.',
    );
  }
}

/**
 * Build the diagnostics for one turn.
 *
 * `direct` is the baseline for a reason that is easy to lose: every other
 * strategy does MORE — more turns, more tools, more spend — so an uncertain
 * selection that guesses upward costs the person something, while one that
 * guesses downward costs them only a less clever plan.
 */
export function adaptiveDiagnostics(input: {
  eligibility: AdaptiveEligibility;
  explicitStrategyId?: string | null;
  selectedStrategyId?: string | null;
  fallbackReason?: string;
}): AdaptiveDiagnostics {
  if (input.explicitStrategyId) {
    return {
      strategyId: input.explicitStrategyId,
      source: 'explicit-user',
      eligible: false,
      ineligibilityReason: 'explicit-strategy',
      defaultsGated: DEFAULTS_ARE_CORPUS_GATED,
    };
  }
  if (!input.eligibility.eligible) {
    return {
      strategyId: input.selectedStrategyId ?? SAFE_BASELINE_STRATEGY,
      source: 'workspace-default',
      eligible: false,
      ineligibilityReason: input.eligibility.reason,
      defaultsGated: DEFAULTS_ARE_CORPUS_GATED,
    };
  }
  if (input.fallbackReason || !input.selectedStrategyId) {
    return {
      strategyId: SAFE_BASELINE_STRATEGY,
      source: 'fallback-direct',
      eligible: true,
      fallbackReason: input.fallbackReason ?? 'no-eligible-strategy',
      defaultsGated: DEFAULTS_ARE_CORPUS_GATED,
    };
  }
  return {
    strategyId: input.selectedStrategyId,
    source: 'adaptive',
    eligible: true,
    defaultsGated: DEFAULTS_ARE_CORPUS_GATED,
  };
}
