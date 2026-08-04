/**
 * ADR-028 D5 — the timetable is honest about estimates.
 *
 * Planned time against ACTUAL time, because the gap is the useful information.
 * A planner that only records what you intended is a record of your optimism.
 *
 * Three decisions shape this, and all three are about not making the surface
 * punitive — a planner people abandon teaches nothing:
 *
 *  - **Blocks may be unscheduled.** A today list is a legitimate plan. Forcing
 *    everything onto a clock is how planners get abandoned by exactly the
 *    people who need them.
 *  - **Carry-over is normal.** It is recorded, not scolded. Most carry-over is
 *    an estimate being wrong, which is information; some of it is a task nobody
 *    knows how to start, which is more useful information still.
 *  - **Drift is a ratio, not a scoreboard.** "Tasks here take 1.8× their
 *    estimate" teaches you to estimate. A red overdue count is ADR-027 §1's
 *    notification failure wearing a planner costume.
 */

export interface TimeBlock {
  id: string;
  itemId: string;
  /** Absent for an unscheduled block — a today-list entry. */
  scheduledFor?: string;
  estimateMinutes: number;
  actualMinutes?: number;
  /** How many days this has been carried forward. */
  carriedOver: number;
  completedAt?: string;
}

export interface DriftSummary {
  /** Blocks with both an estimate and an actual. */
  sampleSize: number;
  /** actual ÷ estimated, across the sample. Null below the minimum sample. */
  ratio: number | null;
  /** Words for the ratio, or null when there is not enough to say anything. */
  description: string | null;
}

/**
 * Below this, a ratio is noise dressed as insight.
 *
 * Telling someone they run at 2.4× off three blocks invites them to plan around
 * a number that will move next week.
 */
export const MIN_DRIFT_SAMPLE = 5;

export function summarizeDrift(blocks: readonly TimeBlock[]): DriftSummary {
  const measured = blocks.filter(
    (b) => typeof b.actualMinutes === 'number' && b.estimateMinutes > 0,
  );
  if (measured.length < MIN_DRIFT_SAMPLE) {
    return { sampleSize: measured.length, ratio: null, description: null };
  }
  const estimated = measured.reduce((sum, b) => sum + b.estimateMinutes, 0);
  const actual = measured.reduce((sum, b) => sum + (b.actualMinutes ?? 0), 0);
  const ratio = actual / estimated;
  return { sampleSize: measured.length, ratio, description: describeDrift(ratio) };
}

/**
 * Say what the ratio means, without praise or blame.
 *
 * Both directions are stated the same way. Congratulating someone for finishing
 * early makes the overrun case feel like a failure by contrast, and then the
 * number stops being something people want to look at.
 */
export function describeDrift(ratio: number): string {
  if (ratio >= 1.15) {
    return `Work here takes about ${ratio.toFixed(1)}× its estimate. Estimates that account for that will hold better.`;
  }
  if (ratio <= 0.85) {
    return `Work here finishes in about ${ratio.toFixed(1)}× its estimate — there is more room in the day than the plan shows.`;
  }
  return 'Estimates here are holding up.';
}

/**
 * Carry unfinished blocks forward.
 *
 * Recorded, not scolded: the count goes up and nothing is marked overdue,
 * missed, or failed. An item carried repeatedly is a signal to raise later, not
 * a badge to attach now.
 */
export function carryOver(blocks: readonly TimeBlock[], toDate: string): TimeBlock[] {
  return blocks.map((b) =>
    b.completedAt
      ? b
      : { ...b, carriedOver: b.carriedOver + 1, ...(b.scheduledFor ? { scheduledFor: toDate } : {}) },
  );
}

/** Carried more than twice — usually something nobody knows how to start. */
export const CARRY_OVER_ATTENTION = 3;

export function needsAttention(blocks: readonly TimeBlock[]): TimeBlock[] {
  return blocks.filter((b) => !b.completedAt && b.carriedOver >= CARRY_OVER_ATTENTION);
}

/**
 * How a repeatedly-carried item is raised.
 *
 * As a question about the task, not a comment about the person. "This has moved
 * four times" invites a defence; "is this waiting on something" invites the
 * actual answer, which is usually that it is blocked or too vague to start.
 */
export function describeCarryOver(block: TimeBlock): string {
  return (
    `This has moved forward ${block.carriedOver} times. Is it waiting on something, or does it need ` +
    'to be broken into a smaller first step?'
  );
}

/** Scheduled blocks for a day, in clock order, unscheduled last. */
export function dayView(
  blocks: readonly TimeBlock[],
  date: string,
): { scheduled: TimeBlock[]; unscheduled: TimeBlock[] } {
  const forDay = blocks.filter((b) => !b.scheduledFor || b.scheduledFor.startsWith(date));
  return {
    scheduled: forDay
      .filter((b) => b.scheduledFor)
      .sort((a, b) => a.scheduledFor!.localeCompare(b.scheduledFor!)),
    unscheduled: forDay.filter((b) => !b.scheduledFor),
  };
}

/**
 * Total committed minutes for a day, against the hours actually available.
 *
 * Stated as a fact, not a warning. Someone who has committed eleven hours knows
 * they are over; what they need is the number, so they can decide what moves.
 */
export function commitmentFor(
  blocks: readonly TimeBlock[],
  availableMinutes: number,
): { committedMinutes: number; overBy: number; note: string | null } {
  const committed = blocks
    .filter((b) => !b.completedAt)
    .reduce((sum, b) => sum + b.estimateMinutes, 0);
  const overBy = Math.max(0, committed - availableMinutes);
  return {
    committedMinutes: committed,
    overBy,
    note: overBy > 0
      ? `${Math.round(committed / 60)}h planned against ${Math.round(availableMinutes / 60)}h available.`
      : null,
  };
}
