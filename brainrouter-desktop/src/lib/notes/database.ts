/**
 * ADR-029 E3 — the database views, as layout over a projection core computed.
 *
 * **Nothing here filters, sorts or groups.** `notes-database-read` answers with
 * the rows a view shows, the buckets they fall in, the rules core could not
 * apply and the sentences for them — so this file arranges what came back and
 * decides the things a projection cannot know: which editor a cell of a given
 * type gets, which month a calendar is looking at, whether a card can be dragged
 * between two columns, and what one click on a column header does to a sort.
 *
 * That split is E1's parity argument applied to databases. A second filter in
 * the renderer would hide different rows here than the dashboard hides for the
 * same saved view, and a person cannot tell that apart from their data having
 * gone missing.
 *
 * **Days are UTC, deliberately.** `normaliseDateValue` keeps a date-only value
 * as the day it is rather than converting it to an instant, because converting
 * would have to pick a timezone and two people in different zones would then see
 * one due date fall on different days. The calendar grid is built the same way,
 * or the same row would land in a different cell from the bucket core put it in.
 *
 * Pure, and takes no workspace root: notes are user-scoped (D1).
 */
import { datePropertyDay, NOTE_VIEW_KINDS } from '@kinqs/brainrouter-core/notes/editing';
import type {
  NoteFilterGroup, NoteFilterOperator, NoteFilterRule, NotePropertyValue,
  NoteSelectOption, NoteSortRule, NoteViewKind, SkippedRule,
} from '@kinqs/brainrouter-core/notes/editing';

export type { NoteFilterGroup, NoteFilterOperator, NoteFilterRule, NotePropertyValue, NoteSelectOption, NoteSortRule, NoteViewKind, SkippedRule };

/* ------------------------------------------------------------ the wire shape */

/**
 * One column, as the host serves it.
 *
 * `operators` and `unsupported` come from CORE rather than from a list here, so
 * a picker can never offer a combination the evaluator would then report as
 * skipped — which is the shape of bug where a filter appears to be applied and
 * silently is not.
 */
export interface DatabasePropertyDto {
  id: string;
  name: string;
  type: string;
  options?: readonly NoteSelectOption[];
  description?: string;
  /** §3's formulas, and any type a newer client wrote. Kept, never evaluated. */
  unsupported: boolean;
  operators: readonly NoteFilterOperator[];
}

export interface DatabaseCellDto {
  property: string;
  value: NotePropertyValue;
  /** Core's one-line rendering, so every surface shows the same string. */
  display: string;
  unsupported: boolean;
}

export interface DatabaseRowDto {
  id: string;
  title: string;
  icon: string | null;
  cover: string | null;
  cells: DatabaseCellDto[];
}

/** A bucket. `key === null` is the no-value bucket, which core always produces. */
export interface DatabaseGroupDto {
  key: string | null;
  label: string;
  empty: boolean;
  rowIds: string[];
}

export interface DatabaseViewDto {
  id: string;
  name: string;
  kind: NoteViewKind;
  visible: readonly string[];
  filter?: NoteFilterGroup;
  sort?: readonly NoteSortRule[];
  groupBy?: string;
}

export interface DatabaseReadDto {
  found: boolean;
  id: string;
  title: string;
  views: Array<{ id: string; name: string; kind: NoteViewKind }>;
  view: DatabaseViewDto;
  kind: NoteViewKind;
  properties: DatabasePropertyDto[];
  /** Visible property ids, in the view's order. */
  columns: string[];
  rows: DatabaseRowDto[];
  groups: DatabaseGroupDto[];
  total: number;
  filteredOut: number;
  skipped: SkippedRule[];
  notices: string[];
}

/** What `notes-property-catalog` answers — the types a picker may offer. */
export interface PropertyCatalogDto {
  types: Array<{ type: string; operators: readonly NoteFilterOperator[] }>;
  viewKinds: readonly NoteViewKind[];
}

/* ---------------------------------------------------------------- the views */

/** The five views E4 names, labelled. The LIST is core's, so it cannot drift. */
export const VIEW_KINDS: readonly NoteViewKind[] = NOTE_VIEW_KINDS;

export function viewKindLabel(kind: NoteViewKind): string {
  switch (kind) {
    case 'table': return 'Table';
    case 'board': return 'Board';
    case 'list': return 'List';
    case 'calendar': return 'Calendar';
    case 'gallery': return 'Gallery';
  }
}

/**
 * What a view needs before it can say anything, in one sentence.
 *
 * Shown beside the kind in the "add a view" menu rather than discovered after
 * making one: a board with nothing to group by is legal (core puts every row in
 * one bucket and says so) but it is not what the person pressing "Board" meant.
 */
export function viewKindHint(kind: NoteViewKind): string {
  switch (kind) {
    case 'table': return 'Every property as a column.';
    case 'board': return 'Columns from a select or a checkbox.';
    case 'list': return 'One line per row.';
    case 'calendar': return 'Rows placed by a date property.';
    case 'gallery': return 'Cards, with the cover image.';
  }
}

export function propertyTypeLabel(type: string): string {
  switch (type) {
    case 'title': return 'Title';
    case 'text': return 'Text';
    case 'number': return 'Number';
    case 'select': return 'Select';
    case 'multi-select': return 'Multi-select';
    case 'date': return 'Date';
    case 'checkbox': return 'Checkbox';
    case 'url': return 'URL';
    case 'person': return 'Person';
    case 'relation': return 'Relation';
    // A type a newer client wrote. Named as it was stored rather than as
    // "unknown", because the person who made it on another device knows the
    // word and would not recognise ours.
    default: return type;
  }
}

/* ----------------------------------------------------------------- the cells */

/**
 * Which editor a cell gets.
 *
 * `none` is a READ-ONLY cell, not a missing one: a property this build cannot
 * evaluate still shows core's `display` string, because §3's argument about
 * formulas is that a column this version cannot compute must appear as exactly
 * that rather than as an approximation — and an editable field over a value we
 * do not understand would let a person overwrite it with something we do.
 */
export type CellEditor =
  | 'title' | 'text' | 'number' | 'url' | 'checkbox' | 'date'
  | 'select' | 'multi-select' | 'person' | 'relation' | 'none';

export function cellEditorFor(property: DatabasePropertyDto): CellEditor {
  if (property.unsupported) return 'none';
  switch (property.type) {
    case 'title': return 'title';
    case 'text': return 'text';
    case 'number': return 'number';
    case 'url': return 'url';
    case 'checkbox': return 'checkbox';
    case 'date': return 'date';
    case 'select': return 'select';
    case 'multi-select': return 'multi-select';
    case 'person': return 'person';
    case 'relation': return 'relation';
    default: return 'none';
  }
}

/** A cell's value as a list, for the editors that hold several. */
export function valueList(value: NotePropertyValue): string[] {
  if (Array.isArray(value)) return value.map((entry) => String(entry));
  if (value === null || value === undefined || value === '') return [];
  return [String(value)];
}

/**
 * One entry added or taken out of a multi-value cell.
 *
 * The ORDER of the survivors is preserved: a tag list that reshuffled every time
 * one was removed would read as the app rewriting a field nobody touched.
 */
export function toggleMultiValue(value: NotePropertyValue, entry: string): string[] {
  const current = valueList(value);
  return current.includes(entry) ? current.filter((item) => item !== entry) : [...current, entry];
}

/**
 * A stable id for a new select option.
 *
 * The id is seeded from the label ONCE and then never changes, which is what
 * makes renaming an option safe: every row stores the id, so a rename is a
 * schema edit that leaves the values alone. Deriving the id from the label at
 * read time would orphan every value the moment someone fixed a typo.
 *
 * Core has no option-id scheme to reuse — options are opaque strings to it, and
 * `propertyIdFor` names COLUMNS — so this is the desktop's, kept legible so the
 * stored file reads as what the person typed.
 */
export function selectOptionId(label: string, taken: ReadonlySet<string>): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'option';
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/* ---------------------------------------------------------------- the rows */

export function rowsById(dto: DatabaseReadDto): Map<string, DatabaseRowDto> {
  return new Map(dto.rows.map((row) => [row.id, row] as const));
}

export function propertiesById(dto: DatabaseReadDto): Map<string, DatabasePropertyDto> {
  return new Map(dto.properties.map((property) => [property.id, property] as const));
}

/** The columns a view shows, resolved and in the view's order. */
export function visibleProperties(dto: DatabaseReadDto): DatabasePropertyDto[] {
  const byId = propertiesById(dto);
  return dto.columns
    .map((id) => byId.get(id))
    .filter((property): property is DatabasePropertyDto => !!property);
}

export function titleProperty(dto: DatabaseReadDto): DatabasePropertyDto | null {
  return dto.properties.find((property) => property.type === 'title') ?? null;
}

/**
 * The buckets a board renders, with their rows resolved.
 *
 * Every group core sent is kept, INCLUDING the empty ones and the no-value
 * bucket. Core seeds a column per schema option on purpose — a board where a
 * status disappears because nothing is in it is a board you cannot drag onto —
 * and dropping the `null` bucket here would hide the untriaged rows that E3
 * says cannot go missing.
 */
export interface BoardColumn {
  key: string | null;
  label: string;
  /** True for the no-value bucket. It is a column, not an absence. */
  noValue: boolean;
  rows: DatabaseRowDto[];
}

export function boardColumns(dto: DatabaseReadDto): BoardColumn[] {
  const byId = rowsById(dto);
  return dto.groups.map((group) => ({
    key: group.key,
    label: group.label,
    noValue: group.key === null,
    rows: group.rowIds
      .map((id) => byId.get(id))
      .filter((row): row is DatabaseRowDto => !!row),
  }));
}

/**
 * Can a card be dragged from one column to another?
 *
 * Only where the drop can write the WHOLE value without losing anything. A
 * multi-select card sits in every column its tags name (core's
 * `propertyGroupKeys` puts it there deliberately), so dropping it on one column
 * would have to replace the list and would silently delete the other tags. A
 * date is not draggable for the same reason in reverse: a calendar cell is a
 * day, and a drop would discard the time the person stored.
 */
export function canDragBetweenGroups(property: DatabasePropertyDto | null | undefined): boolean {
  if (!property || property.unsupported) return false;
  return property.type === 'select' || property.type === 'checkbox';
}

/** What a drop on this column writes. `null` clears the cell. */
export function groupDropValue(property: DatabasePropertyDto, key: string | null): NotePropertyValue {
  if (property.type === 'checkbox') return key === 'true';
  return key;
}

/* ------------------------------------------------------------- the calendar */

export interface CalendarDay {
  /** `YYYY-MM-DD`, the key core's date grouping produces. */
  key: string;
  day: number;
  inMonth: boolean;
  rows: DatabaseRowDto[];
}

export interface CalendarModel {
  /** The month being shown, as its first day. */
  anchor: string;
  label: string;
  weeks: CalendarDay[][];
  /** The no-value bucket — E3 says a row cannot go missing, so it is shown. */
  unscheduled: DatabaseRowDto[];
  unscheduledLabel: string;
  /** Rows whose day falls outside the month on screen. Counted, never dropped. */
  offMonth: number;
  /**
   * Buckets whose key is not a day at all — a calendar grouped by something
   * other than a date. Listed rather than discarded, because core allowed the
   * view and the rows are real.
   */
  unplaced: Array<{ label: string; rows: DatabaseRowDto[] }>;
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` for a UTC day offset from the first of a month. */
function utcDayKey(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
}

export function monthLabel(anchor: string): string {
  const [year, month] = anchor.split('-').map((part) => Number(part));
  const date = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, 1));
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** The month a day falls in, as the anchor a calendar is opened at. */
export function monthAnchorOf(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

export function shiftMonth(anchor: string, delta: number): string {
  const year = Number(anchor.slice(0, 4));
  const month = Number(anchor.slice(5, 7)) - 1;
  const moved = new Date(Date.UTC(year, month + delta, 1));
  return moved.toISOString().slice(0, 10);
}

/** Today, in the same UTC day space core stores dates in. */
export function todayKey(nowMs: number = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * The month a calendar opens at when nobody has chosen one.
 *
 * The month of the EARLIEST scheduled row rather than today, because a database
 * of dates in the past would otherwise open on an empty grid and read as a view
 * that lost its rows. Today when there is nothing to place.
 */
export function defaultCalendarAnchor(dto: DatabaseReadDto, nowMs: number = Date.now()): string {
  const days = dto.groups
    .map((group) => group.key)
    .filter((key): key is string => typeof key === 'string' && DAY_KEY.test(key))
    .sort();
  return monthAnchorOf(days[0] ?? todayKey(nowMs));
}

/**
 * Six weeks of days for a month, Monday first.
 *
 * Always six rows, so the grid does not change height as the month changes — a
 * calendar that reflowed between five and six rows would move everything under
 * it every time someone stepped a month. Shared with the date picker, because a
 * picker whose weeks started on a different day from the calendar it writes into
 * is two answers to what a week is on one screen.
 */
export function monthGrid(anchor: string): CalendarDay[][] {
  const year = Number(anchor.slice(0, 4));
  const month = Number(anchor.slice(5, 7)) - 1;
  const first = new Date(Date.UTC(year, month, 1));
  // getUTCDay() is 0 for Sunday, which would start the week on Sunday and split
  // the weekend across two rows.
  const lead = (first.getUTCDay() + 6) % 7;

  const weeks: CalendarDay[][] = [];
  for (let week = 0; week < 6; week += 1) {
    const days: CalendarDay[] = [];
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const date = new Date(Date.UTC(year, month, week * 7 + weekday - lead + 1));
      days.push({
        key: date.toISOString().slice(0, 10),
        day: date.getUTCDate(),
        inMonth: date.getUTCFullYear() === first.getUTCFullYear() && date.getUTCMonth() === first.getUTCMonth(),
        rows: [],
      });
    }
    weeks.push(days);
  }
  return weeks;
}

/** The days of the week, in the order `monthGrid` lays them out. */
export const WEEKDAY_LABELS: readonly string[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** The month grid with its rows placed, and everything that did not fit in it. */
export function calendarModel(dto: DatabaseReadDto, anchor: string): CalendarModel {
  const byId = rowsById(dto);
  const resolve = (group: DatabaseGroupDto): DatabaseRowDto[] => group.rowIds
    .map((id) => byId.get(id))
    .filter((row): row is DatabaseRowDto => !!row);

  const byDay = new Map<string, DatabaseRowDto[]>();
  let unscheduled: DatabaseRowDto[] = [];
  let unscheduledLabel = 'No date';
  const unplaced: Array<{ label: string; rows: DatabaseRowDto[] }> = [];

  for (const group of dto.groups) {
    if (group.key === null) {
      unscheduled = resolve(group);
      unscheduledLabel = group.label;
      continue;
    }
    if (DAY_KEY.test(group.key)) {
      byDay.set(group.key, resolve(group));
      continue;
    }
    unplaced.push({ label: group.label, rows: resolve(group) });
  }

  const weeks = monthGrid(anchor).map((week) => week.map((day) => ({
    ...day, rows: byDay.get(day.key) ?? [],
  })));

  const shown = new Set(weeks.flat().filter((day) => day.inMonth).map((day) => day.key));
  let offMonth = 0;
  for (const [key, rows] of byDay) if (!shown.has(key)) offMonth += rows.length;

  return {
    anchor: utcDayKey(Number(anchor.slice(0, 4)), Number(anchor.slice(5, 7)) - 1, 1),
    label: monthLabel(anchor),
    weeks,
    unscheduled,
    unscheduledLabel,
    offMonth,
    unplaced,
  };
}

/** The day a date cell falls on, through core's normalisation. */
export function cellDayKey(value: NotePropertyValue): string | null {
  return datePropertyDay(value);
}

/* --------------------------------------------------------------- the notices */

/**
 * Every sentence shown above a view, in the order they matter.
 *
 * Core's notices first (a board with nothing to group by, a column this version
 * cannot read), then the rules it refused to apply, then the count. The count is
 * last because it is the only one that is normal — a filter that removed rows is
 * information, and burying the two that mean something under it would train
 * people to stop reading the strip.
 */
export function viewNotices(dto: DatabaseReadDto): string[] {
  const lines = [...dto.notices, ...dto.skipped.map((rule) => rule.detail)];
  if (dto.filteredOut > 0) {
    lines.push(dto.filteredOut === 1
      ? `1 row is hidden by this view’s filter. ${dto.total} in the database.`
      : `${dto.filteredOut} rows are hidden by this view’s filter. ${dto.total} in the database.`);
  }
  return lines;
}

/** What an empty view says, which is not the same sentence as an empty database. */
export function emptyViewLine(dto: DatabaseReadDto): string {
  if (dto.total === 0) return 'No rows yet. Every row you add is a page you can open and write in.';
  return 'Every row is hidden by this view’s filter.';
}

export function rowCountLine(dto: DatabaseReadDto): string {
  return dto.rows.length === 1 ? '1 row' : `${dto.rows.length} rows`;
}

/* ------------------------------------------------------------------- sorting */

/**
 * What one click on a column header does.
 *
 * Ascending, then descending, then off — and "off" restores the document order
 * the rows were created in, which is the state people expect a third click to
 * reach. A two-state toggle leaves no gesture that removes a sort, so the person
 * who sorted a column once can never get back to the order they built.
 */
export function nextSortDirection(current: 'asc' | 'desc' | null): 'asc' | 'desc' | null {
  if (current === null) return 'asc';
  return current === 'asc' ? 'desc' : null;
}

export function sortDirectionFor(
  sort: readonly NoteSortRule[] | undefined,
  propertyId: string,
): 'asc' | 'desc' | null {
  return sort?.find((rule) => rule.property === propertyId)?.direction ?? null;
}

/**
 * A header click applied to the view's sort rules.
 *
 * The clicked column becomes the ONLY rule. Multi-column sorting is built in the
 * sort menu, where the order of the rules is visible — a click that silently
 * appended a third tie-break would produce an order nobody could explain from
 * what is on screen.
 */
export function toggleHeaderSort(
  sort: readonly NoteSortRule[] | undefined,
  propertyId: string,
): NoteSortRule[] {
  const next = nextSortDirection(sortDirectionFor(sort, propertyId));
  return next === null ? [] : [{ property: propertyId, direction: next }];
}

/* ------------------------------------------------------------------ filters */

/**
 * A view's filter as one flat list of conditions.
 *
 * Core's model nests, and this editor does not: nesting needs a tree UI that
 * earns its complexity only in the rare view, and the common one is "these
 * conditions, all of them". The nested groups are COUNTED and carried through
 * `writeFilter` untouched rather than being dropped — an editor that silently
 * flattened someone's saved view would change which rows it shows the next time
 * they opened it.
 */
export interface FlatFilter {
  combinator: 'and' | 'or';
  rules: NoteFilterRule[];
  /** Nested groups kept as they are because this editor cannot show them. */
  nested: NoteFilterGroup[];
}

export function flatFilter(filter: NoteFilterGroup | undefined): FlatFilter {
  if (!filter) return { combinator: 'and', rules: [], nested: [] };
  const rules: NoteFilterRule[] = [];
  const nested: NoteFilterGroup[] = [];
  for (const node of filter.rules) {
    if ((node as NoteFilterGroup).combinator !== undefined) nested.push(node as NoteFilterGroup);
    else rules.push(node as NoteFilterRule);
  }
  return { combinator: filter.combinator === 'or' ? 'or' : 'and', rules, nested };
}

/**
 * The flat editor written back, or `undefined` when nothing is left.
 *
 * `undefined` rather than an empty group, because core treats a group with no
 * rules as matching everything — the same outcome, but a stored empty filter
 * would leave the view's chip saying "1 filter" over a filter that does nothing.
 */
export function writeFilter(flat: FlatFilter): NoteFilterGroup | undefined {
  const rules = [...flat.rules, ...flat.nested];
  if (rules.length === 0) return undefined;
  return { combinator: flat.combinator, rules };
}

export function nestedFilterNote(flat: FlatFilter): string | null {
  if (flat.nested.length === 0) return null;
  return flat.nested.length === 1
    ? 'One grouped condition was made elsewhere. It still applies and is kept as it is.'
    : `${flat.nested.length} grouped conditions were made elsewhere. They still apply and are kept as they are.`;
}

export function operatorLabel(operator: NoteFilterOperator): string {
  switch (operator) {
    case 'is': return 'is';
    case 'is-not': return 'is not';
    case 'contains': return 'contains';
    case 'does-not-contain': return 'does not contain';
    case 'starts-with': return 'starts with';
    case 'ends-with': return 'ends with';
    case 'is-empty': return 'is empty';
    case 'is-not-empty': return 'is not empty';
    case 'greater-than': return 'is greater than';
    case 'greater-or-equal': return 'is at least';
    case 'less-than': return 'is less than';
    case 'less-or-equal': return 'is at most';
    case 'before': return 'is before';
    case 'after': return 'is after';
    case 'on-or-before': return 'is on or before';
    case 'on-or-after': return 'is on or after';
    case 'is-any-of': return 'is any of';
    case 'is-none-of': return 'is none of';
    case 'contains-all': return 'contains all of';
    case 'links-to': return 'links to';
    default: return operator;
  }
}

/**
 * Which editor a rule's VALUE gets, given the operator.
 *
 * Not the same answer as the cell's: `is-any-of` on a select takes a list where
 * the cell takes one option, and `contains` on a multi-select asks about ONE
 * member because core compares the cell as a set. Deriving this from the type
 * alone would offer a single-value field for a rule the evaluator reads as a
 * list, and the filter would match nothing for a reason nobody could see.
 */
export function filterValueEditor(
  property: DatabasePropertyDto,
  operator: NoteFilterOperator,
): CellEditor {
  if (operator === 'is-empty' || operator === 'is-not-empty') return 'none';
  if (operator === 'links-to') return 'relation';
  if (operator === 'is-any-of' || operator === 'is-none-of' || operator === 'contains-all') {
    return property.type === 'select' || property.type === 'multi-select' ? 'multi-select' : 'person';
  }
  if (property.type === 'multi-select') return 'select';
  if (property.type === 'person' || property.type === 'relation') return 'text';
  const editor = cellEditorFor(property);
  return editor === 'title' ? 'text' : editor;
}

/**
 * A new rule for this property, with an operator core will actually evaluate.
 *
 * The first operator core offers for the type, never a hardcoded `is`: a
 * multi-select has no `is`, and a rule created with one would be reported as
 * skipped the moment it was saved.
 */
export function newFilterRule(property: DatabasePropertyDto): NoteFilterRule | null {
  const operator = property.operators[0];
  if (!operator) return null;
  const rule: NoteFilterRule = { property: property.id, operator };
  if (operator === 'is-empty' || operator === 'is-not-empty') return rule;
  return { ...rule, value: property.type === 'checkbox' ? true : null };
}

/**
 * Is this rule finished enough to save?
 *
 * A half-built condition must not reach the stored view. Core evaluates `status
 * is <nothing>` as matching nothing — correctly, since an empty cell must not
 * satisfy a comparison — so saving a rule the moment its property was picked
 * empties the view before the person has said what they are filtering FOR, and
 * the honest notice underneath ("every row is hidden by this view's filter")
 * describes a filter they did not finish making.
 *
 * So the editor holds it as a draft until this returns true. `is-empty` and
 * `is-not-empty` are complete on their own; a checkbox is complete at `false`,
 * because false is a value there and not an absence.
 */
export function isCompleteFilterRule(rule: NoteFilterRule): boolean {
  if (rule.operator === 'is-empty' || rule.operator === 'is-not-empty') return true;
  const value = rule.value;
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** The chip over the toolbar: how many conditions are actually applied. */
export function filterSummary(dto: DatabaseReadDto): string {
  const flat = flatFilter(dto.view.filter);
  const count = flat.rules.length + flat.nested.length;
  if (count === 0) return 'Filter';
  return count === 1 ? '1 filter' : `${count} filters`;
}

export function sortSummary(dto: DatabaseReadDto): string {
  const count = dto.view.sort?.length ?? 0;
  if (count === 0) return 'Sort';
  return count === 1 ? '1 sort' : `${count} sorts`;
}

export function groupSummary(dto: DatabaseReadDto): string {
  if (!dto.view.groupBy) return 'Group';
  const property = propertiesById(dto).get(dto.view.groupBy);
  return `Group: ${property?.name ?? dto.view.groupBy}`;
}

/**
 * Which properties can be grouped by.
 *
 * A property core cannot evaluate is excluded, because grouping by it would be
 * reported as skipped and the board would render one column called "All rows"
 * with no explanation the person could act on.
 */
export function groupableProperties(dto: DatabaseReadDto): DatabasePropertyDto[] {
  return dto.properties.filter((property) => !property.unsupported && property.type !== 'title');
}
