/**
 * ADR-061 D7 — calibration is measured here, not claimed elsewhere.
 *
 * A stated probability is only worth acting on if it tracks what actually
 * happens. "0.9 risk" has to mean the thing was risky about nine times in ten,
 * or the number is decoration and the thresholds around it are arbitrary. No
 * vendor page and no model card can establish that for *this* workspace, with
 * *this* model, on *these* questions — only the record can.
 *
 * So the tier grades itself. Every decision is already written down with its
 * probability (D5); what this adds is the other half of the pair — what turned
 * out to be true — and two standard readings over the result:
 *
 *  - **ECE** (expected calibration error): bucket the decisions by stated
 *    probability, and in each bucket compare the average stated probability to
 *    the observed rate. The sample-weighted average gap is the error. A
 *    classifier that says 0.9 and is right 60% of the time scores badly here
 *    even though it is usually "right".
 *  - **Brier score**: the mean squared error of the probability itself. It
 *    catches what ECE alone can miss — a classifier that answers 0.5 to
 *    everything is perfectly calibrated and perfectly useless.
 *
 * The verdict is deliberately conservative in both directions. Below
 * {@link CALIBRATION_MIN_SAMPLES} labelled decisions there is no verdict at
 * all, because a handful of shell approvals is not evidence; and an
 * `uncalibrated` verdict demotes the provider to advisory rather than switching
 * it off, because its answers are still worth recording while the rules decide.
 *
 * Pure: arithmetic over recorded entries. No clock, no I/O.
 */

import type { DecisionEntry } from './recentDecisions.js';

/** Below this many labelled decisions, a verdict would be noise. */
export const CALIBRATION_MIN_SAMPLES = 30;

/** Above this average gap between stated probability and observed rate, advisory. */
export const CALIBRATION_MAX_ECE = 0.15;

/**
 * Above this Brier score, advisory even when ECE looks fine — the always-0.5
 * answer scores 0.25 here and would otherwise pass.
 */
export const CALIBRATION_MAX_BRIER = 0.22;

/** How many buckets the probability range is split into. */
export const CALIBRATION_BINS = 5;

export interface CalibrationSample {
  /** The probability the provider stated, in [0,1]. */
  probability: number;
  /** What turned out to be true. */
  correct: boolean;
}

export interface CalibrationBin {
  lower: number;
  upper: number;
  samples: number;
  /** What the provider said, on average, in this bucket. */
  stated: number;
  /** What actually happened, in this bucket. */
  observed: number;
}

export type CalibrationVerdict = 'calibrated' | 'uncalibrated' | 'insufficient';

export interface CalibrationAssessment {
  provider: string;
  /** Labelled decisions — the ones with both a probability and an outcome. */
  samples: number;
  /** Decisions recorded for this provider that nothing has labelled yet. */
  unlabelled: number;
  ece: number;
  brier: number;
  bins: CalibrationBin[];
  verdict: CalibrationVerdict;
  /** One sentence a person reads. */
  summary: string;
}

/**
 * The probability a decision actually asserted.
 *
 * For a `noul` it is the answer itself — the number IS the claim. For a
 * `choice` or a `score` the answer is a key, and the claim about it is the
 * stated confidence; without one there is nothing to calibrate.
 */
export function assertedProbability(entry: DecisionEntry): number | undefined {
  if (entry.kind === 'noul') return typeof entry.value === 'number' ? entry.value : undefined;
  return typeof entry.confidence === 'number' ? entry.confidence : undefined;
}

/**
 * Turn recorded decisions into gradeable pairs.
 *
 * `rules` answers are excluded on purpose: a rule is certain by construction
 * (confidence 1) and did not weigh anything, so scoring it would measure the
 * heuristic's luck and flatter whatever provider sits above it.
 */
export function samplesFromDecisions(
  entries: readonly DecisionEntry[],
  provider: string,
): { samples: CalibrationSample[]; unlabelled: number } {
  const samples: CalibrationSample[] = [];
  let unlabelled = 0;
  for (const entry of entries) {
    if (entry.provider !== provider || provider === 'rules') continue;
    const probability = assertedProbability(entry);
    if (probability === undefined || probability < 0 || probability > 1) continue;
    if (typeof entry.correct !== 'boolean') { unlabelled += 1; continue; }
    samples.push({ probability, correct: entry.correct });
  }
  return { samples, unlabelled };
}

export function assessCalibration(
  provider: string,
  samples: readonly CalibrationSample[],
  options: { unlabelled?: number; minSamples?: number } = {},
): CalibrationAssessment {
  const minSamples = Math.max(1, options.minSamples ?? CALIBRATION_MIN_SAMPLES);
  const unlabelled = Math.max(0, options.unlabelled ?? 0);
  const usable = samples.filter((s) => Number.isFinite(s.probability) && s.probability >= 0 && s.probability <= 1);
  const bins = buildBins(usable);

  if (usable.length < minSamples) {
    return {
      provider,
      samples: usable.length,
      unlabelled,
      ece: 0,
      brier: 0,
      bins,
      verdict: 'insufficient',
      summary:
        `${usable.length} of ${minSamples} decisions needed to judge ${provider}`
        + `${unlabelled > 0 ? `; ${unlabelled} more are recorded but nothing has said yet whether they were right` : ''}`,
    };
  }

  const ece = bins.reduce((sum, bin) => sum + (bin.samples / usable.length) * Math.abs(bin.stated - bin.observed), 0);
  const brier = usable.reduce((sum, s) => sum + (s.probability - (s.correct ? 1 : 0)) ** 2, 0) / usable.length;
  const calibrated = ece <= CALIBRATION_MAX_ECE && brier <= CALIBRATION_MAX_BRIER;
  return {
    provider,
    samples: usable.length,
    unlabelled,
    ece: round3(ece),
    brier: round3(brier),
    bins,
    verdict: calibrated ? 'calibrated' : 'uncalibrated',
    summary: calibrated
      ? `${provider} is calibrated over ${usable.length} decisions (ECE ${round3(ece)}, Brier ${round3(brier)})`
      : `${provider} is NOT calibrated over ${usable.length} decisions (ECE ${round3(ece)}, Brier ${round3(brier)}) — `
        + `${describeMiss(bins)}. Its answers are advisory: recorded and shown, with the rules deciding.`,
  };
}

function buildBins(samples: readonly CalibrationSample[]): CalibrationBin[] {
  const width = 1 / CALIBRATION_BINS;
  const bins: CalibrationBin[] = [];
  for (let i = 0; i < CALIBRATION_BINS; i += 1) {
    const lower = i * width;
    const upper = (i + 1) * width;
    // The top bin owns 1.0, so a certain answer is graded rather than dropped.
    const inBin = samples.filter((s) => (
      s.probability >= lower && (i === CALIBRATION_BINS - 1 ? s.probability <= upper : s.probability < upper)
    ));
    bins.push({
      lower: round3(lower),
      upper: round3(upper),
      samples: inBin.length,
      stated: inBin.length ? round3(inBin.reduce((n, s) => n + s.probability, 0) / inBin.length) : 0,
      observed: inBin.length ? round3(inBin.filter((s) => s.correct).length / inBin.length) : 0,
    });
  }
  return bins;
}

/** Name the worst bucket, so the summary says WHERE it is wrong, not just that it is. */
function describeMiss(bins: readonly CalibrationBin[]): string {
  const worst = bins
    .filter((bin) => bin.samples > 0)
    .sort((a, b) => Math.abs(b.stated - b.observed) - Math.abs(a.stated - a.observed))[0];
  if (!worst) return 'no bucket has enough decisions to say where';
  const direction = worst.stated > worst.observed ? 'overconfident' : 'underconfident';
  return `most ${direction} around ${worst.stated.toFixed(2)}, where it was right ${Math.round(worst.observed * 100)}% of ${worst.samples}`;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
