/**
 * ADR-029 E3 — property types, and the values a row carries.
 *
 * **A database row IS a page.** So a property VALUE is a field on the page block
 * and nothing else: no row table, no row id, no row sync path. Everything Part
 * A–D decided about a block — HLC stamps (D3), the per-block outbox (D2),
 * field-level merge (D4), the lease (B2), tombstones and trash (C5) — applies to
 * a row because a row is a block, not because anything here re-implements it.
 *
 * **Values live under `props`, keyed by property id, each one separately
 * stamped.** That is D4's per-field rule taken one level down: two devices
 * editing two different properties of one row are not in conflict, which is the
 * same sentence B1 makes about two paragraphs of one page. A single
 * `Stamped<Record<…>>` for the whole row would have made every cell edit a
 * whole-record write, so setting a status on a phone would silently discard a
 * due date typed on a laptop a second earlier.
 *
 * **A concurrent edit to ONE property is last-writer-wins, with no conflict
 * marker** — see `mergeProps` in `blockMerge.ts` for the rule and the two
 * reasons. It is the treatment `level`, `icon` and `checked` already get, and
 * the reasons are that the merge can only see one block (never the database, so
 * never the property's type), and that a cell is not a paragraph: prose belongs
 * in the row's page body, where `mergeText` does keep both versions.
 *
 * **`title` is not stored here.** A row's title IS the page block's `text`
 * (`pageTitle`), so a `title` property reads and writes that field. Storing it
 * in `props` would be E2's mistake in miniature: two fields that must agree,
 * merging independently, and the first concurrent edit leaves the row's name in
 * the table and the heading on its page as different sentences.
 *
 * **What is deliberately NOT here: formulas and rollups.** §3 rules them out
 * because they need an expression language and a dependency graph, and half of
 * one produces a column that is wrong rather than absent. A def whose type this
 * build does not know is kept and reported UNSUPPORTED rather than guessed at —
 * which is the same mechanism, so a newer client's formula column shows as a
 * column this build cannot compute instead of as an approximation.
 */
import {
  formatWorkspaceRef, parseWorkspaceRef, workspaceRefKey, type WorkspaceRef,
} from '../workspace/references/ref.js';

/** E4's property row, as the types this build knows how to evaluate. */
export type NotePropertyType =
  | 'title'
  | 'text'
  | 'number'
  | 'select'
  | 'multi-select'
  | 'date'
  | 'checkbox'
  | 'url'
  | 'person'
  /** Holds Part A workspace references — E5: a row can cite a pull request. */
  | 'relation';

export const NOTE_PROPERTY_TYPES: readonly NotePropertyType[] = [
  'title', 'text', 'number', 'select', 'multi-select',
  'date', 'checkbox', 'url', 'person', 'relation',
];

export function isNotePropertyType(value: unknown): value is NotePropertyType {
  return typeof value === 'string' && (NOTE_PROPERTY_TYPES as readonly string[]).includes(value);
}

/** A choice in a `select` or `multi-select`. The id is stored; the label is shown. */
export interface NoteSelectOption {
  id: string;
  label: string;
  /** A palette name, not a colour value — surfaces own their palettes. */
  tone?: string;
}

export interface NotePropertyDef {
  id: string;
  name: string;
  /**
   * A `NotePropertyType`, or a type a newer client wrote.
   *
   * Typed as a string for the reason `ref.ts` gives about `mode`: the desktop,
   * the dashboard and the CLI ship on their own schedules, and a build that
   * predates a property type will meet it in synced content. A closed union
   * would make that def *malformed*, which is a lie about a well-formed column —
   * so it stays in the schema and every evaluator reports it unsupported.
   */
  type: string;
  /** For `select` and `multi-select`. Order is the person's, and sorting uses it. */
  options?: readonly NoteSelectOption[];
  /** The line under the name in a property editor. */
  description?: string;
}

/**
 * What a cell holds.
 *
 * One flat union rather than a per-type shape, because this value is merged by a
 * function that has only the block — see the header. `null` means empty, and it
 * is a stored value rather than an absent key so that clearing a cell is an
 * event with a stamp: a deleted key would leave a peer's older "set" arriving
 * later with nothing to lose against, and the value would come back.
 */
export type NotePropertyValue = string | number | boolean | readonly string[] | null;

/** A cell is not a paragraph. Prose goes in the row's page body, where D4 keeps both versions. */
export const MAX_PROPERTY_TEXT = 2000;
/** Tags, people, relations. High enough for real use, low enough to bound a sync payload. */
export const MAX_PROPERTY_VALUES = 64;
/** A schema someone can still read. Past this a person wanted several databases. */
export const MAX_DATABASE_PROPERTIES = 64;

/* ------------------------------------------------------------------- dates */

/** `YYYY-MM-DD`, the one shape that is a day rather than an instant. */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A date value, normalised — and a day stays a DAY.
 *
 * Converting `2026-08-07` to an instant has to pick a timezone, and the only one
 * available is the device's. Two people in different zones would then see the
 * same due date fall on different days, and neither could tell why. So a
 * date-only value is stored as the day it is, and only a value that already
 * carried a time becomes an instant.
 */
export function normaliseDateValue(raw: unknown): string | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return new Date(raw).toISOString();
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (text.length === 0) return null;
  if (DAY.test(text)) return Number.isNaN(Date.parse(`${text}T00:00:00Z`)) ? null : text;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** The day a date value falls on, which is what a calendar groups by. */
export function datePropertyDay(value: NotePropertyValue): string | null {
  const normalised = typeof value === 'string' ? normaliseDateValue(value) : null;
  return normalised ? normalised.slice(0, 10) : null;
}

/** A date as milliseconds, for ordering. A day is compared at its UTC midnight. */
export function datePropertyMs(value: NotePropertyValue): number | null {
  const normalised = typeof value === 'string' ? normaliseDateValue(value) : null;
  if (!normalised) return null;
  const ms = Date.parse(DAY.test(normalised) ? `${normalised}T00:00:00Z` : normalised);
  return Number.isNaN(ms) ? null : ms;
}

/* -------------------------------------------------------------- coercion */

function boundedText(raw: unknown): string | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  if (typeof raw !== 'string') return null;
  const text = raw.slice(0, MAX_PROPERTY_TEXT);
  return text.length === 0 ? null : text;
}

function boundedList(raw: unknown, map: (entry: string) => string | null): readonly string[] | null {
  const input = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : null;
  if (!input) return null;
  const out: string[] = [];
  for (const entry of input) {
    if (typeof entry !== 'string') continue;
    const mapped = map(entry.slice(0, MAX_PROPERTY_TEXT));
    if (mapped === null || out.includes(mapped)) continue;
    out.push(mapped);
    if (out.length >= MAX_PROPERTY_VALUES) break;
  }
  return out.length === 0 ? null : out;
}

/**
 * A canonical relation entry, or nothing.
 *
 * Canonicalised through `formatWorkspaceRef` so the backlink index keys on one
 * spelling. A value that is not a well-formed reference is DROPPED rather than
 * stored raw: a half-URI in a relation cell becomes a backlink to a target that
 * does not exist, which A3 rules out as a phantom the reader cannot trace.
 */
function canonicalRef(entry: string): string | null {
  const parsed = parseWorkspaceRef(entry);
  return parsed.ok ? formatWorkspaceRef(parsed.ref) : null;
}

/**
 * The value a write actually stores, or `null` for empty.
 *
 * Coercion happens at the WRITE, once, so nothing downstream has to ask whether
 * a number arrived as a string. A value that cannot be coerced becomes empty
 * rather than being stored as typed — a cell holding `"abc"` under a number
 * column would sort, filter and total differently on every surface that guessed
 * at it differently.
 */
export function coercePropertyValue(def: NotePropertyDef, raw: unknown): NotePropertyValue {
  if (raw === null || raw === undefined) return null;
  switch (def.type) {
    case 'title':
    case 'text':
    case 'url':
      return boundedText(raw);
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      return Number.isFinite(n) ? n : null;
    }
    case 'checkbox':
      // An unset checkbox IS false; `null` would be a third state nobody can
      // enter and every surface would render differently.
      return raw === true || raw === 'true';
    case 'date':
      return normaliseDateValue(raw);
    case 'select':
      // One option id. Not validated against the schema here: this function has
      // the def, and a def whose options were edited on another device would
      // then silently empty a cell that names a choice the person can still see.
      return boundedText(raw);
    case 'multi-select':
    case 'person':
      return boundedList(raw, (entry) => (entry.trim().length === 0 ? null : entry.trim()));
    case 'relation':
      return boundedList(raw, canonicalRef);
    default:
      // An unknown type is kept verbatim if it is already storable, so a newer
      // client's column survives a round trip through this build rather than
      // being emptied by the older peer that could not read it.
      return typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean'
        ? raw
        : Array.isArray(raw) ? boundedList(raw, (entry) => entry) : null;
  }
}

export function isEmptyPropertyValue(value: NotePropertyValue): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  // A `false` checkbox is a value, not an absence — see `coercePropertyValue`.
  return false;
}

/* ------------------------------------------------------------- rendering */

function optionLabel(def: NotePropertyDef, id: string): string {
  return def.options?.find((option) => option.id === id)?.label ?? id;
}

/**
 * A cell as one line of text.
 *
 * A relation renders as its URI here rather than as the target's title, because
 * A3 says a reference is live: the label belongs to whoever resolves it at the
 * moment of rendering, and a title baked in at write time is the snapshot A3
 * refuses.
 */
export function formatPropertyValue(def: NotePropertyDef, value: NotePropertyValue): string {
  if (def.type === 'checkbox') return value === true ? 'Yes' : 'No';
  if (isEmptyPropertyValue(value)) return '';
  if (Array.isArray(value)) {
    return def.type === 'multi-select'
      ? value.map((entry) => optionLabel(def, entry)).join(', ')
      : value.join(', ');
  }
  if (def.type === 'select') return optionLabel(def, String(value));
  return String(value);
}

/**
 * Every workspace reference a cell holds — E5, made queryable.
 *
 * Not restricted to `relation`: a `url` or `text` cell someone pasted a
 * `brainrouter://` URI into is as real a reference as one inserted deliberately,
 * which is the same rule `blockReferences` already applies to a paragraph.
 */
export function propertyValueRefs(value: NotePropertyValue): WorkspaceRef[] {
  const entries = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const refs: WorkspaceRef[] = [];
  for (const entry of entries) {
    const parsed = parseWorkspaceRef(entry);
    if (parsed.ok) refs.push(parsed.ref);
  }
  return refs;
}

/** Does this cell cite that target? Fragment-insensitive, matching `workspaceRefKey`. */
export function propertyValueCites(value: NotePropertyValue, targetKey: string): boolean {
  return propertyValueRefs(value).some((ref) => workspaceRefKey(ref) === targetKey);
}

/* -------------------------------------------------------------- ordering */

/**
 * Order two cells of one property, or `null` when the type is one this build
 * cannot order.
 *
 * `null` rather than a fallback comparison, because a fallback would silently
 * order an unsupported column by its JSON spelling and look like it worked. The
 * caller reports the sort as skipped instead.
 *
 * A `select` orders by the position of its option in the schema, never
 * alphabetically: the options of a status column are ordered by the person who
 * made them, and "Done, In progress, To do" is the answer alphabetical sorting
 * gives to a question nobody asked.
 */
export function comparePropertyValues(
  def: NotePropertyDef,
  a: NotePropertyValue,
  b: NotePropertyValue,
): number | null {
  switch (def.type) {
    case 'title':
    case 'text':
    case 'url':
    case 'person':
    case 'relation':
    case 'multi-select':
      return formatPropertyValue(def, a).localeCompare(formatPropertyValue(def, b));
    case 'number': {
      const x = typeof a === 'number' ? a : Number.NaN;
      const y = typeof b === 'number' ? b : Number.NaN;
      if (Number.isNaN(x) && Number.isNaN(y)) return 0;
      if (Number.isNaN(x)) return 1;
      if (Number.isNaN(y)) return -1;
      return x === y ? 0 : x < y ? -1 : 1;
    }
    case 'checkbox': {
      const x = a === true ? 1 : 0;
      const y = b === true ? 1 : 0;
      return x - y;
    }
    case 'date': {
      const x = datePropertyMs(a);
      const y = datePropertyMs(b);
      if (x === null && y === null) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return x === y ? 0 : x < y ? -1 : 1;
    }
    case 'select': {
      const order = (value: NotePropertyValue): number => {
        const index = def.options?.findIndex((option) => option.id === String(value)) ?? -1;
        // An option the schema no longer lists sorts after the ones it does,
        // rather than at position -1 where it would jump to the front.
        return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
      };
      const x = order(a);
      const y = order(b);
      if (x !== y) return x < y ? -1 : 1;
      return formatPropertyValue(def, a).localeCompare(formatPropertyValue(def, b));
    }
    default:
      return null;
  }
}

/* -------------------------------------------------------------- grouping */

/**
 * The groups a row belongs to for this property. Empty means it has no value.
 *
 * A MULTI-VALUE property puts the row in every group its value names, and that
 * is deliberate. A board grouped by tags where a two-tag card appeared once —
 * under whichever tag sorted first — hides the card from the other column, and
 * the person looking at that column concludes the card is not tagged. The
 * consequence is that the group counts sum to more than the row count, which is
 * true and has to be labelled rather than hidden.
 */
export function propertyGroupKeys(def: NotePropertyDef, value: NotePropertyValue): string[] {
  if (def.type === 'checkbox') return [value === true ? 'true' : 'false'];
  if (isEmptyPropertyValue(value)) return [];
  if (def.type === 'date') {
    const day = datePropertyDay(value);
    return day ? [day] : [];
  }
  if (Array.isArray(value)) return [...value];
  return [String(value)];
}

/** What a group is called. `null` is the no-value bucket — never hidden. */
export function propertyGroupLabel(def: NotePropertyDef, key: string | null): string {
  if (key === null) return def.type === 'date' ? 'Unscheduled' : `No ${def.name}`;
  if (def.type === 'checkbox') return key === 'true' ? def.name : `Not ${def.name}`;
  if (def.type === 'select' || def.type === 'multi-select') return optionLabel(def, key);
  return key;
}
