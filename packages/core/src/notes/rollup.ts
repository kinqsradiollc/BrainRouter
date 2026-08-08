/**
 * ADR-029 F2 — an aggregate across a relation, and what it says about the rows
 * it could not see.
 *
 * The arithmetic is the easy half. The half that decides whether this column is
 * honest is **A4, applied to a number**: a reference to something the viewer
 * cannot see renders as "an item you do not have access to" rather than as its
 * title or as nothing — and a rollup is exactly the place where "as nothing"
 * becomes tempting, because dropping a row from a `count` produces a number that
 * looks fine.
 *
 * > A permission-hidden row must not be silently omitted from a count somebody
 * > is reading as complete.
 *
 * So the decision, stated rather than implied:
 *
 *  - **An empty relation and a relation whose targets are hidden are different
 *    answers.** An empty relation counts `0`. A relation with three hidden
 *    targets counts `0 + 3 you cannot see` — not `0`, which would claim there is
 *    nothing there, and not `3`, which would confirm three things exist and let
 *    a person count what they were not shown by reading the number.
 *  - **Every aggregate except `count` is EMPTY over no rows.** A `sum` of
 *    nothing rendering as `0` is a total somebody will read as a total; `min` of
 *    nothing has no answer at all, and one rule for all of them is one fewer
 *    thing to be surprised by.
 *  - **The clause travels with the number, in the cell.** A notice at the top of
 *    the view is not where the person reading the number is looking.
 */
import {
  datePropertyMs, isEmptyPropertyValue,
  type NotePropertyValue, type NoteRollupAggregate, type NoteRollupSpec,
} from './properties.js';

/** One target of a relation, as far as the reader could get to it. */
export type RollupSample =
  /** Resolved and readable. The value may still be empty — that is not an error. */
  | { status: 'value'; value: NotePropertyValue }
  /** A4 — it is there and this viewer may not see it. */
  | { status: 'denied' }
  /**
   * Deleted, in another mode, or not a row of a database with that column.
   * One bucket because the person's next action is the same for all three:
   * open the link and look, rather than ask for access.
   */
  | { status: 'unreachable' };

export interface RollupOutcome {
  /** The aggregate. `null` when there is nothing to aggregate. */
  value: NotePropertyValue;
  /** The number plus whatever had to be said about what it does not include. */
  display: string;
  /** Targets whose value was read. */
  counted: number;
  denied: number;
  unreachable: number;
  /** Every target the relation named. */
  total: number;
  /** Set when the rollup itself could not be computed at all. */
  error?: string;
}

function numbersOf(samples: readonly RollupSample[]): number[] {
  const out: number[] = [];
  for (const sample of samples) {
    if (sample.status !== 'value') continue;
    if (typeof sample.value === 'number') out.push(sample.value);
  }
  return out;
}

function datesOf(samples: readonly RollupSample[]): Array<{ ms: number; raw: string }> {
  const out: Array<{ ms: number; raw: string }> = [];
  for (const sample of samples) {
    if (sample.status !== 'value' || typeof sample.value !== 'string') continue;
    const ms = datePropertyMs(sample.value);
    if (ms !== null) out.push({ ms, raw: sample.value });
  }
  return out;
}

function originalsOf(samples: readonly RollupSample[]): string[] {
  const out: string[] = [];
  for (const sample of samples) {
    if (sample.status !== 'value' || isEmptyPropertyValue(sample.value)) continue;
    if (Array.isArray(sample.value)) out.push(...sample.value.map((entry) => String(entry)));
    else out.push(String(sample.value));
  }
  return out;
}

/**
 * How a number reads when it does not cover everything.
 *
 * Two different clauses because the two situations lead somewhere different: a
 * hidden row is a permission somebody can ask for, and an unreachable one is a
 * link to follow. Collapsing them into "some rows were skipped" would leave the
 * reader with no idea which.
 */
export function rollupCoverageClause(outcome: {
  denied: number;
  unreachable: number;
}): string {
  return [deniedClause(outcome.denied), unreachableClause(outcome.unreachable)]
    .filter(Boolean)
    .join('; ');
}

function deniedClause(count: number): string {
  if (count <= 0) return '';
  return count === 1 ? '1 you cannot see' : `${count} you cannot see`;
}

function unreachableClause(count: number): string {
  if (count <= 0) return '';
  return count === 1 ? '1 could not be read here' : `${count} could not be read here`;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '';
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(12)));
}

/**
 * Aggregate the samples a relation produced.
 *
 * Total in the same sense the formula engine is: every aggregate over every
 * shape of input returns an outcome, and an input it cannot use contributes
 * nothing rather than making the whole cell an error. A `sum` over a column of
 * text is `empty` with the count of what it could not add, not `NaN`.
 */
export function aggregateRollup(
  spec: NoteRollupSpec,
  samples: readonly RollupSample[],
): RollupOutcome {
  const counted = samples.filter((sample) => sample.status === 'value').length;
  const denied = samples.filter((sample) => sample.status === 'denied').length;
  const unreachable = samples.filter((sample) => sample.status === 'unreachable').length;
  const base = { counted, denied, unreachable, total: samples.length };
  const clause = rollupCoverageClause(base);
  const withClause = (shown: string, joiner = ' — '): string => {
    if (!clause) return shown;
    return shown.length > 0 ? `${shown}${joiner}${clause}` : clause;
  };

  const aggregate: NoteRollupAggregate = spec.aggregate;

  if (aggregate === 'count') {
    // The one aggregate that answers over an empty relation, because "how many
    // are linked" has the answer zero.
    //
    // The HIDDEN count is joined with a `+` so `0 + 3 you cannot see` reads as
    // arithmetic somebody can finish — which is the honest shape, since the true
    // count is not knowable from here. An unreachable link is not arithmetic
    // waiting to happen, so it gets a dash: nothing this reader does will turn
    // a planner item into a row of this database.
    const hidden = deniedClause(denied);
    const unread = unreachableClause(unreachable);
    const shown = hidden ? `${counted} + ${hidden}` : String(counted);
    return { ...base, value: counted, display: unread ? `${shown} — ${unread}` : shown };
  }

  if (aggregate === 'show-original') {
    const originals = originalsOf(samples);
    return {
      ...base,
      value: originals.length > 0 ? originals : null,
      display: withClause(originals.join(', ')),
    };
  }

  if (aggregate === 'earliest' || aggregate === 'latest') {
    const dates = datesOf(samples);
    if (dates.length === 0) return { ...base, value: null, display: withClause('') };
    const chosen = dates.reduce((a, b) => (
      aggregate === 'earliest' ? (b.ms < a.ms ? b : a) : (b.ms > a.ms ? b : a)
    ));
    return { ...base, value: chosen.raw, display: withClause(chosen.raw) };
  }

  const numbers = numbersOf(samples);
  if (numbers.length === 0) {
    return { ...base, value: null, display: withClause('') };
  }
  const total = numbers.reduce((a, b) => a + b, 0);
  const value = aggregate === 'sum' ? total
    : aggregate === 'average' ? total / numbers.length
    : aggregate === 'min' ? Math.min(...numbers)
    : Math.max(...numbers);

  // The count of numbers is stated when it differs from the count of targets,
  // because a sum over four of nine linked rows is a different number from a sum
  // over nine and nothing else on screen says which one this is.
  const partial = numbers.length < counted
    ? `over ${numbers.length} of ${counted} linked rows`
    : '';
  const suffix = [partial, clause].filter(Boolean).join('; ');
  const shown = formatNumber(value);
  return { ...base, value, display: suffix ? `${shown} — ${suffix}` : shown };
}

/** A rollup whose configuration does not name a column, so it has nothing to do. */
export function rollupConfigError(spec: NoteRollupSpec | undefined): string | null {
  if (!spec) return 'This column is a rollup that has not been set up yet.';
  if (!spec.relation) return 'This rollup does not say which relation to follow.';
  if (spec.aggregate !== 'count' && !spec.target) {
    return 'This rollup does not say which property of the linked rows to summarise.';
  }
  return null;
}
