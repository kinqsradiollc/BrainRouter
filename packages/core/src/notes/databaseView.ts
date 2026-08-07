/**
 * ADR-029 E3 — views, filters, sorts and grouping, as a stored projection.
 *
 * A view is not a copy of the rows. It is a description of how to look at them:
 * which properties are visible and in what order, which rows to keep, how to
 * order them, and what to group by. Everything it describes is recomputed from
 * the blocks every time, so a row edited on a phone is in the right column of
 * the board on the laptop without the view knowing anything happened.
 *
 * **The predicate model is typed, not a string.** No expression language, no
 * parser, no escaping rules — a rule names a property, an operator and a value.
 * The reason is E1's, applied to filtering: three clients (Q5) would each need
 * the same parser, and the first divergence between them shows up as the same
 * saved view hiding different rows on the desktop and the dashboard, which is
 * indistinguishable from data having gone missing.
 *
 * **A rule this build cannot evaluate does not hide rows.** An operator that
 * does not apply to a property's type, or a property whose type is one a newer
 * client wrote, is SKIPPED and reported. The alternative directions are both
 * silent lies: treating it as matching nothing empties a view someone relies on,
 * and treating it as matching everything claims a filter was applied when it was
 * not. Reporting it is the only option that lets a surface say what happened.
 *
 * **Rows with no value for the grouping property are never hidden.** They go in
 * an explicit bucket that is always produced and always labelled — see
 * `groupRows`. Silently dropping them is how someone loses a row and has no
 * question to ask about it.
 */
import {
  comparePropertyValues, datePropertyMs, isEmptyPropertyValue, normaliseDateValue,
  propertyGroupKeys, propertyGroupLabel, propertyValueCites, formatPropertyValue,
  type NotePropertyDef, type NotePropertyValue,
} from './properties.js';
import { parseWorkspaceRef, workspaceRefKey } from '../workspace/references/ref.js';

/** E4's views row. Board and calendar are the two that need a grouping property. */
export type NoteViewKind = 'table' | 'board' | 'list' | 'calendar' | 'gallery';

export const NOTE_VIEW_KINDS: readonly NoteViewKind[] = [
  'table', 'board', 'list', 'calendar', 'gallery',
];

export function isNoteViewKind(value: unknown): value is NoteViewKind {
  return typeof value === 'string' && (NOTE_VIEW_KINDS as readonly string[]).includes(value);
}

/** Views that cannot render without knowing what to group by. */
export const GROUPED_VIEW_KINDS: readonly NoteViewKind[] = ['board', 'calendar'];

export type NoteFilterOperator =
  | 'is'
  | 'is-not'
  | 'contains'
  | 'does-not-contain'
  | 'starts-with'
  | 'ends-with'
  | 'is-empty'
  | 'is-not-empty'
  | 'greater-than'
  | 'greater-or-equal'
  | 'less-than'
  | 'less-or-equal'
  | 'before'
  | 'after'
  | 'on-or-before'
  | 'on-or-after'
  | 'is-any-of'
  | 'is-none-of'
  | 'contains-all'
  /** E5 — a relation cell that cites a given workspace URI, fragment-insensitively. */
  | 'links-to';

/**
 * Which operators a property type offers.
 *
 * The map is the contract a picker renders from AND the check evaluation makes,
 * so a surface cannot offer a combination the evaluator will then skip.
 *
 * A `checkbox` gets only `is`, deliberately: it is never empty (an unset
 * checkbox is `false`), so offering `is-empty` would advertise a third state
 * nobody can enter.
 */
export const OPERATORS_FOR_TYPE: Record<string, readonly NoteFilterOperator[]> = {
  title: ['is', 'is-not', 'contains', 'does-not-contain', 'starts-with', 'ends-with', 'is-empty', 'is-not-empty'],
  text: ['is', 'is-not', 'contains', 'does-not-contain', 'starts-with', 'ends-with', 'is-empty', 'is-not-empty'],
  url: ['is', 'is-not', 'contains', 'does-not-contain', 'starts-with', 'ends-with', 'is-empty', 'is-not-empty', 'links-to'],
  number: ['is', 'is-not', 'greater-than', 'greater-or-equal', 'less-than', 'less-or-equal', 'is-empty', 'is-not-empty'],
  select: ['is', 'is-not', 'is-any-of', 'is-none-of', 'is-empty', 'is-not-empty'],
  'multi-select': ['contains', 'does-not-contain', 'contains-all', 'is-any-of', 'is-none-of', 'is-empty', 'is-not-empty'],
  date: ['is', 'is-not', 'before', 'after', 'on-or-before', 'on-or-after', 'is-empty', 'is-not-empty'],
  checkbox: ['is'],
  person: ['contains', 'does-not-contain', 'is-any-of', 'is-none-of', 'is-empty', 'is-not-empty'],
  relation: ['links-to', 'contains', 'does-not-contain', 'is-empty', 'is-not-empty'],
};

export function operatorsFor(def: NotePropertyDef): readonly NoteFilterOperator[] {
  return OPERATORS_FOR_TYPE[def.type] ?? [];
}

export interface NoteFilterRule {
  /** The property id this rule reads. */
  property: string;
  operator: NoteFilterOperator;
  /** Absent for `is-empty` / `is-not-empty`; a list for the `*-of` operators. */
  value?: NotePropertyValue;
}

export interface NoteFilterGroup {
  combinator: 'and' | 'or';
  rules: readonly (NoteFilterRule | NoteFilterGroup)[];
}

export function isFilterGroup(node: NoteFilterRule | NoteFilterGroup): node is NoteFilterGroup {
  return (node as NoteFilterGroup).combinator !== undefined;
}

export interface NoteSortRule {
  property: string;
  direction: 'asc' | 'desc';
}

export interface NoteDatabaseView {
  id: string;
  name: string;
  kind: NoteViewKind;
  /**
   * The visible property ids, IN ORDER. Order is the projection — a stored
   * position on each def would have to be renumbered on every reorder, which is
   * one write per column under a per-block outbox.
   */
  visible: readonly string[];
  filter?: NoteFilterGroup;
  sort?: readonly NoteSortRule[];
  /** Required by board and calendar; optional elsewhere. */
  groupBy?: string;
}

/** A view someone can still read, and a bound on what one push can carry. */
export const MAX_DATABASE_VIEWS = 24;
export const MAX_FILTER_RULES = 64;

/** Why a rule was not applied. Reported, never silently resolved either way. */
export interface SkippedRule {
  kind: 'filter' | 'sort' | 'group';
  property: string;
  reason: 'unknown_property' | 'unsupported_type' | 'unsupported_operator';
  detail: string;
}

/* ----------------------------------------------------------------- filters */

type RuleOutcome = { evaluated: true; matched: boolean } | { evaluated: false; skipped: SkippedRule };

function listOf(value: NotePropertyValue): string[] {
  if (Array.isArray(value)) return value.map((entry) => String(entry));
  if (value === null || value === undefined) return [];
  return [String(value)];
}

function textOf(def: NotePropertyDef, value: NotePropertyValue): string {
  return formatPropertyValue(def, value).toLowerCase();
}

function compareNumbers(cell: NotePropertyValue, target: NotePropertyValue): number | null {
  const a = typeof cell === 'number' ? cell : Number.NaN;
  const b = typeof target === 'number' ? target : Number(String(target ?? '').trim());
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return a === b ? 0 : a < b ? -1 : 1;
}

function compareDates(cell: NotePropertyValue, target: NotePropertyValue): number | null {
  const a = datePropertyMs(cell);
  const b = datePropertyMs(normaliseDateValue(target));
  if (a === null || b === null) return null;
  return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * Evaluate one rule against one cell.
 *
 * Empty is checked FIRST and only for the two operators that ask about it. An
 * empty cell fails every other comparison rather than being coerced — a blank
 * status matching `is-not "Done"` reads as true to a naive implementation, and
 * the person filtering for "everything that is not done" would get rows nobody
 * has triaged mixed in with rows someone actively marked.
 */
export function evaluateFilterRule(
  def: NotePropertyDef | undefined,
  value: NotePropertyValue,
  rule: NoteFilterRule,
): RuleOutcome {
  if (!def) {
    return {
      evaluated: false,
      skipped: {
        kind: 'filter', property: rule.property, reason: 'unknown_property',
        detail: `There is no property "${rule.property}" in this database, so its filter was not applied.`,
      },
    };
  }
  const allowed = operatorsFor(def);
  if (allowed.length === 0) {
    return {
      evaluated: false,
      skipped: {
        kind: 'filter', property: def.id, reason: 'unsupported_type',
        detail: `"${def.name}" is a ${def.type} property, which this version cannot filter on.`,
      },
    };
  }
  if (!allowed.includes(rule.operator)) {
    return {
      evaluated: false,
      skipped: {
        kind: 'filter', property: def.id, reason: 'unsupported_operator',
        detail: `"${rule.operator}" does not apply to a ${def.type} property, so it was not applied.`,
      },
    };
  }

  const empty = isEmptyPropertyValue(value);
  if (rule.operator === 'is-empty') return { evaluated: true, matched: empty };
  if (rule.operator === 'is-not-empty') return { evaluated: true, matched: !empty };

  const matched = matchRule(def, value, rule, empty);
  return { evaluated: true, matched };
}

function matchRule(
  def: NotePropertyDef,
  value: NotePropertyValue,
  rule: NoteFilterRule,
  empty: boolean,
): boolean {
  const target = rule.value ?? null;

  if (rule.operator === 'links-to') {
    const parsed = parseWorkspaceRef(typeof target === 'string' ? target : '');
    return parsed.ok && propertyValueCites(value, workspaceRefKey(parsed.ref));
  }

  if (def.type === 'checkbox') {
    return (value === true) === (target === true);
  }

  if (def.type === 'number') {
    const order = compareNumbers(value, target);
    if (order === null) return false;
    switch (rule.operator) {
      case 'is': return order === 0;
      case 'is-not': return order !== 0;
      case 'greater-than': return order > 0;
      case 'greater-or-equal': return order >= 0;
      case 'less-than': return order < 0;
      case 'less-or-equal': return order <= 0;
      default: return false;
    }
  }

  if (def.type === 'date') {
    const order = compareDates(value, target);
    if (order === null) return false;
    switch (rule.operator) {
      case 'is': return order === 0;
      case 'is-not': return order !== 0;
      case 'before': return order < 0;
      case 'after': return order > 0;
      case 'on-or-before': return order <= 0;
      case 'on-or-after': return order >= 0;
      default: return false;
    }
  }

  // A multi-value cell is compared as a SET, so `contains` asks about membership
  // rather than about a substring of the joined labels — otherwise a tag called
  // "ops" would match a row tagged only "devops".
  if (def.type === 'multi-select' || def.type === 'person' || def.type === 'relation') {
    const cells = listOf(value);
    const targets = listOf(target);
    switch (rule.operator) {
      case 'contains': return targets.length > 0 && targets.some((t) => cells.includes(t));
      case 'does-not-contain': return targets.length === 0 || !targets.some((t) => cells.includes(t));
      case 'contains-all': return targets.length > 0 && targets.every((t) => cells.includes(t));
      case 'is-any-of': return targets.some((t) => cells.includes(t));
      case 'is-none-of': return !targets.some((t) => cells.includes(t));
      default: return false;
    }
  }

  if (def.type === 'select') {
    const cell = empty ? null : String(value);
    const targets = listOf(target);
    switch (rule.operator) {
      case 'is': return cell !== null && targets.includes(cell);
      case 'is-not': return cell === null ? false : !targets.includes(cell);
      case 'is-any-of': return cell !== null && targets.includes(cell);
      case 'is-none-of': return cell === null ? false : !targets.includes(cell);
      default: return false;
    }
  }

  // Text-shaped: title, text, url, and any type whose operators were allowed
  // above without a branch here.
  if (empty) return false;
  const haystack = textOf(def, value);
  const needle = String(target ?? '').toLowerCase();
  switch (rule.operator) {
    case 'is': return haystack === needle;
    case 'is-not': return haystack !== needle;
    case 'contains': return needle.length > 0 && haystack.includes(needle);
    case 'does-not-contain': return needle.length === 0 || !haystack.includes(needle);
    case 'starts-with': return needle.length > 0 && haystack.startsWith(needle);
    case 'ends-with': return needle.length > 0 && haystack.endsWith(needle);
    default: return false;
  }
}

export interface FilterOutcome {
  matched: boolean;
  skipped: SkippedRule[];
}

/**
 * Evaluate a filter tree against one row's cells.
 *
 * A group whose every rule was skipped MATCHES, for both combinators. That is
 * the direction the header commits to: a filter nobody could evaluate must not
 * remove rows from someone's view, because a row that vanished is a question
 * with no answer while a reported filter is a sentence a surface can show.
 */
export function evaluateFilter(
  filter: NoteFilterGroup | undefined,
  defs: ReadonlyMap<string, NotePropertyDef>,
  cell: (propertyId: string) => NotePropertyValue,
): FilterOutcome {
  const skipped: SkippedRule[] = [];
  if (!filter) return { matched: true, skipped };

  const walk = (group: NoteFilterGroup, depth: number): boolean => {
    // A tree deep enough to matter is a corrupted or hostile view, not a filter
    // someone built. Bounded rather than recursed into a stack overflow.
    if (depth > 8 || group.rules.length === 0) return true;

    const outcomes: boolean[] = [];
    for (const node of group.rules.slice(0, MAX_FILTER_RULES)) {
      if (isFilterGroup(node)) {
        outcomes.push(walk(node, depth + 1));
        continue;
      }
      const outcome = evaluateFilterRule(defs.get(node.property), cell(node.property), node);
      if (!outcome.evaluated) {
        skipped.push(outcome.skipped);
        continue;
      }
      outcomes.push(outcome.matched);
    }
    if (outcomes.length === 0) return true;
    return group.combinator === 'or' ? outcomes.some(Boolean) : outcomes.every(Boolean);
  };

  return { matched: walk(filter, 0), skipped };
}

/* -------------------------------------------------------------------- sort */

export interface SortOutcome<T> {
  rows: T[];
  skipped: SkippedRule[];
}

/**
 * Order rows by a view's sort rules.
 *
 * **An empty cell sorts LAST in both directions.** Not "smallest", because
 * reversing the direction would then sweep every blank row to the top, where
 * they push the rows that actually have values off the screen — and the person
 * who reversed a sort to see the biggest number first gets a screen of blanks
 * instead.
 *
 * The final tie-break is the caller's fallback (rank, then id), so the order is
 * TOTAL: two devices holding the same rows render them in the same sequence,
 * which is the same property `compareRank` exists to give siblings.
 */
export function sortRows<T>(
  rows: readonly T[],
  sort: readonly NoteSortRule[] | undefined,
  defs: ReadonlyMap<string, NotePropertyDef>,
  cell: (row: T, propertyId: string) => NotePropertyValue,
  fallback: (a: T, b: T) => number,
): SortOutcome<T> {
  const skipped: SkippedRule[] = [];
  const active: Array<{ def: NotePropertyDef; direction: 'asc' | 'desc' }> = [];

  for (const rule of sort ?? []) {
    const def = defs.get(rule.property);
    if (!def) {
      skipped.push({
        kind: 'sort', property: rule.property, reason: 'unknown_property',
        detail: `There is no property "${rule.property}" in this database, so its sort was not applied.`,
      });
      continue;
    }
    // Probed with two empty values rather than by consulting a second list of
    // sortable types: one source of truth for "can this be ordered", and it is
    // the function that does the ordering.
    if (comparePropertyValues(def, null, null) === null) {
      skipped.push({
        kind: 'sort', property: def.id, reason: 'unsupported_type',
        detail: `"${def.name}" is a ${def.type} property, which this version cannot sort by.`,
      });
      continue;
    }
    active.push({ def, direction: rule.direction });
  }

  const ordered = [...rows].sort((a, b) => {
    for (const { def, direction } of active) {
      const left = cell(a, def.id);
      const right = cell(b, def.id);
      const leftEmpty = isEmptyPropertyValue(left);
      const rightEmpty = isEmptyPropertyValue(right);
      if (leftEmpty !== rightEmpty) return leftEmpty ? 1 : -1;
      if (leftEmpty) continue;
      const order = comparePropertyValues(def, left, right) ?? 0;
      if (order !== 0) return direction === 'desc' ? -order : order;
    }
    return fallback(a, b);
  });

  return { rows: ordered, skipped };
}

/* ----------------------------------------------------------------- groups */

export interface RowGroup<T> {
  /** The stored value that defines the group, or `null` for the no-value bucket. */
  key: string | null;
  label: string;
  /** True for the no-value bucket. Always produced; never hidden. */
  empty: boolean;
  rows: T[];
}

/**
 * Bucket rows by a property.
 *
 * **The no-value bucket always exists** — with a count of zero when nothing is
 * in it — because a bucket that appears only when it is non-empty is a bucket
 * people forget can exist, and the row that lands in it is the row nobody looks
 * for. E3's whole argument is that a row is a page and cannot go missing; a view
 * that drops it is the same loss with better manners.
 *
 * Groups come back in the schema's option order where there is one, then by key,
 * with the no-value bucket LAST — so a board reads as the person arranged their
 * options and the un-triaged column does not sit in front of the work.
 *
 * A value that names an option the schema no longer lists gets its own group
 * labelled with the raw value. Folding it into the no-value bucket would claim
 * the row has no value when it has one this build cannot name, and dropping it
 * would hide the row.
 */
export function groupRows<T>(
  rows: readonly T[],
  def: NotePropertyDef,
  cell: (row: T) => NotePropertyValue,
): RowGroup<T>[] {
  const buckets = new Map<string, RowGroup<T>>();
  const none: RowGroup<T> = { key: null, label: propertyGroupLabel(def, null), empty: true, rows: [] };

  // Seeded from the schema so an empty column still appears — a board where a
  // status vanishes because nothing is in it is a board you cannot drag onto.
  for (const option of def.options ?? []) {
    buckets.set(option.id, { key: option.id, label: option.label, empty: false, rows: [] });
  }
  if (def.type === 'checkbox') {
    for (const key of ['true', 'false']) {
      buckets.set(key, { key, label: propertyGroupLabel(def, key), empty: false, rows: [] });
    }
  }

  for (const row of rows) {
    const keys = propertyGroupKeys(def, cell(row));
    if (keys.length === 0) {
      none.rows.push(row);
      continue;
    }
    for (const key of keys) {
      const bucket = buckets.get(key)
        ?? { key, label: propertyGroupLabel(def, key), empty: false, rows: [] as T[] };
      bucket.rows.push(row);
      buckets.set(key, bucket);
    }
  }

  const optionOrder = new Map((def.options ?? []).map((option, index) => [option.id, index] as const));
  const ordered = [...buckets.values()].sort((a, b) => {
    const x = optionOrder.get(a.key ?? '') ?? Number.MAX_SAFE_INTEGER;
    const y = optionOrder.get(b.key ?? '') ?? Number.MAX_SAFE_INTEGER;
    if (x !== y) return x < y ? -1 : 1;
    return (a.key ?? '').localeCompare(b.key ?? '');
  });

  return [...ordered, none];
}
