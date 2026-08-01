/**
 * ADR-027 D1 (P9-3) — comprehension measures, and teaching-mode candidates.
 *
 * D1: "We measure whether the human can still explain their system — e.g.
 * proportion of merged change the human has actually read, recency of last
 * human-authored change in a subsystem, and answer-without-lookup checks — and
 * we report these as a *balance*, never as a nag."
 *
 * This is the most speculative mechanism in the ADR and §5 leaves open whether
 * it is worth the surveillance risk. So the design is deliberately narrow:
 *
 *   - It measures SUBSYSTEMS, not people. "auth/ has drifted" is a fact about a
 *     codebase. "You have not read 60% of your merges" is a fact about a person,
 *     and the moment a tool says that it has become something you manage rather
 *     than something you use.
 *   - Everything is derived from events the system already records — merges,
 *     authorship, reviews. Nothing new is watched. A comprehension metric that
 *     required new observation would be the surveillance §5 worries about.
 *   - It produces CANDIDATES for teaching mode, never assignments. D1's teaching
 *     mode is an explicit mode the human enters, not a state a tool puts them in.
 *
 * The failure mode being designed against: a dashboard that quantifies how much
 * someone has stopped understanding gets read once, resented, and turned off —
 * and then measures nothing, which is worse than never having measured.
 */

export interface SubsystemActivity {
  /** Path prefix identifying the subsystem, e.g. `packages/core/src/auth/`. */
  path: string;
  /** Lines of change merged into this subsystem in the window. */
  changedLines: number;
  /** Of those, lines in changes a human actually reviewed. */
  reviewedLines: number;
  /** ISO timestamp of the last change a HUMAN authored here. Null if never. */
  lastHumanAuthoredAt: string | null;
}

export interface SubsystemComprehension {
  path: string;
  /** 0–1. Proportion of merged change a human read. */
  reviewedFraction: number;
  /** Days since a human last wrote code here. Null when never, or unknown. */
  daysSinceHumanAuthored: number | null;
  /**
   * True when the subsystem has drifted far enough to be worth offering
   * teaching mode. A SUGGESTION, never an assignment.
   */
  teachingCandidate: boolean;
}

export interface ComprehensionOptions {
  /** Point to measure from. Required — this module never invents a clock. */
  now: string;
  /** Below this reviewed fraction a subsystem may be a teaching candidate. */
  reviewedFloor?: number;
  /** Days of no human authorship before a subsystem may be a candidate. */
  staleDays?: number;
  /**
   * Subsystems smaller than this are ignored entirely. Without it, a
   * three-line config change looks like total drift, and the measure fills with
   * noise that trains people to dismiss it.
   */
  minChangedLines?: number;
}

/**
 * Assess each subsystem.
 *
 * A subsystem is a teaching candidate only when BOTH signals agree: the human
 * has stopped reading changes AND stopped writing code there. Either alone is
 * ordinary — plenty of well-understood code is stable, and plenty of reviewed
 * code is written by someone else. It is the conjunction that means "you own
 * this and have lost touch with it", which is precisely what D1's teaching mode
 * is for.
 */
export function assessComprehension(
  subsystems: readonly SubsystemActivity[],
  options: ComprehensionOptions,
): readonly SubsystemComprehension[] {
  const floor = options.reviewedFloor ?? 0.5;
  const staleDays = options.staleDays ?? 90;
  const minLines = options.minChangedLines ?? 50;
  const nowMs = Date.parse(options.now);

  return subsystems.map((subsystem) => {
    const reviewedFraction = subsystem.changedLines === 0
      ? 1
      : Math.min(1, subsystem.reviewedLines / subsystem.changedLines);

    const daysSinceHumanAuthored = subsystem.lastHumanAuthoredAt
      ? Math.max(0, Math.floor((nowMs - Date.parse(subsystem.lastHumanAuthoredAt)) / 86_400_000))
      : null;

    const significant = subsystem.changedLines >= minLines;
    const unread = reviewedFraction < floor;
    const stale = daysSinceHumanAuthored === null || daysSinceHumanAuthored >= staleDays;

    return {
      path: subsystem.path,
      reviewedFraction,
      daysSinceHumanAuthored,
      teachingCandidate: significant && unread && stale,
    };
  });
}

/**
 * Render the balance.
 *
 * Subsystem-first phrasing throughout, and no second person. "auth/ has drifted"
 * is a fact about a codebase; "you have not read your merges" is a fact about a
 * person, and a tool that says the latter becomes something to be managed rather
 * than used.
 *
 * Returns null when nothing has drifted — silence is the correct output for a
 * healthy codebase, and a measure that always says something trains people to
 * stop reading it.
 */
export function describeComprehension(
  assessments: readonly SubsystemComprehension[],
): string | null {
  const drifted = assessments.filter((a) => a.teachingCandidate);
  if (drifted.length === 0) return null;

  const named = drifted
    .slice(0, 3)
    .map((a) => `${a.path} (${Math.round(a.reviewedFraction * 100)}% of recent change reviewed)`)
    .join(', ');
  const more = drifted.length > 3 ? ` and ${drifted.length - 3} more` : '';

  return `${drifted.length} subsystem(s) have drifted from direct human authorship: ${named}${more}. `
    + 'Teaching mode is available for any of these.';
}

/**
 * Overall balance across the codebase, for a single at-a-glance figure.
 *
 * Weighted by changed lines rather than averaged per subsystem: a thoroughly
 * reviewed one-line fix should not offset an unreviewed thousand-line rewrite,
 * which is what an unweighted mean would do.
 */
export function overallReviewedFraction(subsystems: readonly SubsystemActivity[]): number {
  const total = subsystems.reduce((sum, s) => sum + s.changedLines, 0);
  if (total === 0) return 1;
  const reviewed = subsystems.reduce((sum, s) => sum + Math.min(s.reviewedLines, s.changedLines), 0);
  return reviewed / total;
}
