/**
 * ADR-040 A40-11 — optimization as a governed subgraph, not one self-scoring loop.
 *
 * D6's point: a loop that measures its own success and decides when to stop is
 * the shape that produces confident nonsense. It optimises the number it can
 * see, and the things it cannot see pay for it. So the decisions are separated
 * and each is a first-class record in the execution map:
 *
 *   measurement    — what moved
 *   counter-metric — what must NOT move while it moves
 *   verifier       — an independent check that the improvement is real
 *   arbitration    — who wins when measurement and verifier disagree
 *   rollback       — undo, when the answer is no
 *   drift/audit    — the metric itself going bad over time
 *
 * Domain-neutral on purpose. Engineering's build loop is one instance, not the
 * definition, and its compatibility path is retained below rather than migrated
 * out from under it.
 */
import { boundReasonCodes, type DecisionKind } from '@kinqs/brainrouter-agent-protocol';

export type OptimizationDecisionKind =
  | 'measurement'
  | 'counter-metric'
  | 'verifier'
  | 'arbitration'
  | 'rollback'
  | 'drift-audit';

/** How an optimization decision maps onto the shared execution-map vocabulary. */
export function executionDecisionKindFor(kind: OptimizationDecisionKind): DecisionKind {
  switch (kind) {
    case 'rollback': return 'rollback';
    case 'verifier': return 'guard';
    case 'arbitration': return 'selection';
    case 'drift-audit': return 'degradation';
    default: return 'guard';
  }
}

export interface MetricReading {
  metricId: string;
  /** Higher is better unless `lowerIsBetter`. Stated, never guessed. */
  value: number;
  lowerIsBetter?: boolean;
}

export interface OptimizationRound {
  baseline: readonly MetricReading[];
  candidate: readonly MetricReading[];
  /** Metrics that must not regress, whatever the target metric does. */
  counterMetricIds: readonly string[];
  /** The metric being optimised. */
  targetMetricId: string;
  /** Independent verdict, when a verifier ran. Absent = it did not run. */
  verifierPassed?: boolean;
}

export interface OptimizationVerdict {
  accept: boolean;
  kind: OptimizationDecisionKind;
  reasonCodes: readonly string[];
}

function improved(before: MetricReading | undefined, after: MetricReading | undefined): boolean {
  if (!before || !after) return false;
  return after.lowerIsBetter ? after.value < before.value : after.value > before.value;
}

function regressed(before: MetricReading | undefined, after: MetricReading | undefined): boolean {
  if (!before || !after) return false;
  return after.lowerIsBetter ? after.value > before.value : after.value < before.value;
}

function byId(readings: readonly MetricReading[]): Map<string, MetricReading> {
  return new Map(readings.map((r) => [r.metricId, r]));
}

/**
 * Judge one optimization round.
 *
 * Order is the design. A counter-metric regression rejects BEFORE the target
 * improvement is even considered, because the whole failure mode is a loop that
 * trades away something it was not watching for a number it was. And a verifier
 * that ran and failed beats a measurement that says yes — the measurement is
 * what the loop optimises, so it is the least trustworthy witness to its own
 * success.
 */
export function judgeOptimizationRound(round: OptimizationRound): OptimizationVerdict {
  const before = byId(round.baseline);
  const after = byId(round.candidate);

  for (const counterId of round.counterMetricIds) {
    if (regressed(before.get(counterId), after.get(counterId))) {
      return {
        accept: false,
        kind: 'counter-metric',
        reasonCodes: boundReasonCodes(['counter_metric_regressed', counterId]),
      };
    }
  }

  if (round.verifierPassed === false) {
    return {
      accept: false,
      kind: 'verifier',
      reasonCodes: boundReasonCodes(['verifier_rejected']),
    };
  }

  const targetImproved = improved(before.get(round.targetMetricId), after.get(round.targetMetricId));

  if (!targetImproved) {
    return {
      accept: false,
      kind: 'measurement',
      reasonCodes: boundReasonCodes(['no_improvement', round.targetMetricId]),
    };
  }

  // Improvement claimed and nothing contradicts it — but an unrun verifier is
  // recorded, not assumed to have passed. "Nobody checked" is not "it is fine".
  return {
    accept: true,
    kind: round.verifierPassed === true ? 'verifier' : 'measurement',
    reasonCodes: boundReasonCodes(
      round.verifierPassed === true
        ? ['improved', 'verified']
        : ['improved', 'unverified'],
    ),
  };
}

/**
 * Arbitrate when measurement and verifier disagree.
 *
 * The verifier wins. It is the only party with no stake in the number, and a
 * tie broken toward the optimiser is not a tie broken at all.
 */
export function arbitrate(measurementSaysYes: boolean, verifierSaysYes: boolean): OptimizationVerdict {
  if (measurementSaysYes === verifierSaysYes) {
    return {
      accept: measurementSaysYes,
      kind: 'arbitration',
      reasonCodes: boundReasonCodes(['agreed']),
    };
  }
  return {
    accept: verifierSaysYes,
    kind: 'arbitration',
    reasonCodes: boundReasonCodes(['disagreed', 'verifier_wins']),
  };
}

/**
 * Has the metric itself gone bad? A metric that stops moving while the work
 * keeps changing has stopped measuring anything, and a loop steering by it is
 * steering by a constant.
 */
export function detectMetricDrift(history: readonly number[], minDistinct = 2): OptimizationVerdict {
  const distinct = new Set(history).size;
  if (history.length >= 4 && distinct < minDistinct) {
    return {
      accept: false,
      kind: 'drift-audit',
      reasonCodes: boundReasonCodes(['metric_not_discriminating']),
    };
  }
  return { accept: true, kind: 'drift-audit', reasonCodes: boundReasonCodes(['metric_live']) };
}

/**
 * The Engineering build loop's compatibility path, retained during migration.
 * It is ONE instance of the general shape — pass rate up, nothing else down —
 * and is expressed in the general terms rather than kept as a special case.
 */
export function engineeringBuildLoopRound(input: {
  passRateBefore: number;
  passRateAfter: number;
  lintErrorsBefore: number;
  lintErrorsAfter: number;
  verifierPassed?: boolean;
}): OptimizationVerdict {
  return judgeOptimizationRound({
    targetMetricId: 'pass_rate',
    counterMetricIds: ['lint_errors'],
    baseline: [
      { metricId: 'pass_rate', value: input.passRateBefore },
      { metricId: 'lint_errors', value: input.lintErrorsBefore, lowerIsBetter: true },
    ],
    candidate: [
      { metricId: 'pass_rate', value: input.passRateAfter },
      { metricId: 'lint_errors', value: input.lintErrorsAfter, lowerIsBetter: true },
    ],
    verifierPassed: input.verifierPassed,
  });
}
