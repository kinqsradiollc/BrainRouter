/**
 * ADR-029 E3 — a database is a VIEW over pages, and this is the projection.
 *
 * > **A database row IS a page.** Not a record that links to one — the same
 * > block, with properties.
 *
 * That decision is what keeps this from becoming a second store, and the way to
 * check whether it was actually implemented is to look for what is NOT here:
 * there is no row id (a row's id is its block id), no row write path
 * (`databaseOps.ts` composes `noteStore`'s mutations), and no row merge rule
 * (`mergeNoteBlock` merges a row exactly as it merges a paragraph). Everything
 * Parts A–D decided — sync, merge, references, permissions, trash — applies to
 * rows because a row is a block.
 *
 * The database itself is a block too, of kind `database`, whose children are its
 * rows. Its SCHEMA and its VIEWS are two separately stamped fields on that
 * block: separate rather than one, because adding a property and renaming a view
 * are different edits and a single field would make one silently discard the
 * other.
 *
 * **Reading is defensive, and that is a requirement rather than caution.** A
 * notes file written before this layer has no `schema` and no `views` at all,
 * and a file written by a NEWER client can have property types this build has
 * never heard of. Both must read. `readDatabase` fills in what is missing and
 * keeps what it does not understand, marking it unsupported — which is the same
 * mechanism §3's excluded formulas and rollups arrive through, so a formula
 * column from a future build shows as a column this version cannot compute
 * rather than as an approximation of one.
 */
import { isLiveBlock, noteBlockUri, pageTitleOrDefault, type NoteBlock } from './block.js';
import {
  coercePropertyValue, isNotePropertyType, MAX_DATABASE_PROPERTIES,
  MAX_PROPERTY_TEXT, MAX_PROPERTY_VALUES, formatPropertyValue,
  type NotePropertyDef, type NotePropertyValue,
} from './properties.js';
import {
  evaluateFilter, groupRows, isNoteViewKind, sortRows, GROUPED_VIEW_KINDS,
  MAX_DATABASE_VIEWS, operatorsFor,
  type NoteDatabaseView, type NoteViewKind, type RowGroup, type SkippedRule,
} from './databaseView.js';
import { compareRank } from './rank.js';

/** The block kind a database is. */
export const DATABASE_BLOCK_KIND = 'database';

/**
 * The title column every database has.
 *
 * `title` reads and writes the row page's own `text`, so this def describes a
 * field that already exists rather than adding one — see `properties.ts` for
 * why a title stored in `props` would be E2's mistake in miniature.
 */
export const TITLE_PROPERTY_ID = 'title';

export function defaultTitleProperty(): NotePropertyDef {
  return { id: TITLE_PROPERTY_ID, name: 'Name', type: 'title' };
}

export const DEFAULT_VIEW_ID = 'table';

export function defaultDatabaseSchema(): NotePropertyDef[] {
  return [defaultTitleProperty()];
}

export function defaultDatabaseViews(schema: readonly NotePropertyDef[]): NoteDatabaseView[] {
  return [{
    id: DEFAULT_VIEW_ID,
    name: 'Table',
    kind: 'table',
    visible: schema.map((def) => def.id),
  }];
}

export function isDatabaseBlock(block: NoteBlock): boolean {
  return block.kind.value === DATABASE_BLOCK_KIND;
}

/* --------------------------------------------------------------- reading */

export interface NoteDatabase {
  block: NoteBlock;
  title: string;
  schema: NotePropertyDef[];
  views: NoteDatabaseView[];
  /** Ids of properties whose type this build cannot evaluate. Kept, never dropped. */
  unsupported: string[];
}

function readOption(raw: unknown): { id: string; label: string; tone?: string } | null {
  const value = raw as { id?: unknown; label?: unknown; tone?: unknown } | null;
  if (!value || typeof value !== 'object') return null;
  const id = typeof value.id === 'string' ? value.id : null;
  if (!id) return null;
  return {
    id,
    label: typeof value.label === 'string' && value.label.length > 0 ? value.label : id,
    ...(typeof value.tone === 'string' ? { tone: value.tone } : {}),
  };
}

/**
 * One stored property def, repaired into something renderable.
 *
 * A def with no id is dropped — there is nothing to key its values by, so it
 * describes a column that can never hold anything. Everything else is kept,
 * including a type this build does not know.
 */
function readPropertyDef(raw: unknown): NotePropertyDef | null {
  const value = raw as Partial<NotePropertyDef> | null;
  if (!value || typeof value !== 'object') return null;
  if (typeof value.id !== 'string' || value.id.length === 0) return null;
  const type = typeof value.type === 'string' && value.type.length > 0 ? value.type : 'text';
  const options = Array.isArray(value.options)
    ? value.options.map(readOption).filter((option): option is NonNullable<typeof option> => !!option)
    : undefined;
  return {
    id: value.id,
    name: typeof value.name === 'string' && value.name.length > 0 ? value.name : value.id,
    type,
    ...(options && options.length > 0 ? { options } : {}),
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
  };
}

function readView(raw: unknown, schema: readonly NotePropertyDef[]): NoteDatabaseView | null {
  const value = raw as Partial<NoteDatabaseView> | null;
  if (!value || typeof value !== 'object') return null;
  if (typeof value.id !== 'string' || value.id.length === 0) return null;

  const known = new Set(schema.map((def) => def.id));
  // A view listing a property that has since been removed would render a column
  // header with no cells under it. Filtered here rather than at render, so every
  // surface shows the same columns.
  const visible = Array.isArray(value.visible)
    ? value.visible.filter((id): id is string => typeof id === 'string' && known.has(id))
    : [];

  const kind: NoteViewKind = isNoteViewKind(value.kind) ? value.kind : 'table';
  return {
    id: value.id,
    name: typeof value.name === 'string' && value.name.length > 0 ? value.name : value.id,
    kind,
    visible: visible.length > 0 ? visible : schema.map((def) => def.id),
    ...(value.filter && typeof value.filter === 'object' ? { filter: value.filter } : {}),
    ...(Array.isArray(value.sort) ? { sort: value.sort } : {}),
    ...(typeof value.groupBy === 'string' && known.has(value.groupBy) ? { groupBy: value.groupBy } : {}),
  };
}

/**
 * The database a block describes, filled in from whatever it actually stored.
 *
 * Never throws, and never returns an unusable shape: a block with no schema gets
 * the default one, a schema with no title column gets a title column, and a
 * database with no views gets a table view. A file written before this layer
 * therefore reads as an empty database rather than as a crash on open — which is
 * the property `readPlanner` established for a stored file missing whole
 * sections, applied one level down.
 */
export function readDatabase(block: NoteBlock): NoteDatabase {
  const storedSchema = Array.isArray(block.schema?.value) ? block.schema.value : [];
  const seen = new Set<string>();
  const schema: NotePropertyDef[] = [];
  for (const raw of storedSchema) {
    const def = readPropertyDef(raw);
    if (!def || seen.has(def.id)) continue;
    seen.add(def.id);
    schema.push(def);
    if (schema.length >= MAX_DATABASE_PROPERTIES) break;
  }
  if (!schema.some((def) => def.type === 'title')) schema.unshift(defaultTitleProperty());

  const storedViews = Array.isArray(block.views?.value) ? block.views.value : [];
  const views: NoteDatabaseView[] = [];
  const viewIds = new Set<string>();
  for (const raw of storedViews) {
    const view = readView(raw, schema);
    if (!view || viewIds.has(view.id)) continue;
    viewIds.add(view.id);
    views.push(view);
    if (views.length >= MAX_DATABASE_VIEWS) break;
  }
  if (views.length === 0) views.push(...defaultDatabaseViews(schema));

  return {
    block,
    title: pageTitleOrDefault(block),
    schema,
    views,
    unsupported: schema
      .filter((def) => !isNotePropertyType(def.type) || operatorsFor(def).length === 0)
      .map((def) => def.id),
  };
}

/** Property defs by id — what every evaluator needs and nothing else builds. */
export function schemaIndex(schema: readonly NotePropertyDef[]): Map<string, NotePropertyDef> {
  return new Map(schema.map((def) => [def.id, def] as const));
}

/* ------------------------------------------------------------------- rows */

/**
 * A row's value for one property.
 *
 * `title` reads the page block's own `text`, which is the whole of E4's "title
 * as its own field": the row's name in the table and the heading on its page are
 * one string, so they cannot disagree.
 */
export function rowPropertyValue(block: NoteBlock, def: NotePropertyDef): NotePropertyValue {
  if (def.type === 'title') return block.text.value;
  const stored = block.props?.[def.id];
  return stored ? stored.value : null;
}

/**
 * The rows of a database, in sibling order.
 *
 * EVERY live child counts, not only the ones of kind `page`. A child of another
 * kind is a row someone made by dragging a paragraph in, or by a sync arriving
 * mid-edit, and showing it as a row with its text for a title is recoverable
 * while hiding it is the loss this whole file is organised against.
 */
export function databaseRowBlocks(blocks: Iterable<NoteBlock>, databaseId: string): NoteBlock[] {
  return [...blocks]
    .filter((block) => isLiveBlock(block) && block.parentId.value === databaseId)
    .sort((a, b) => compareRank({ rank: a.rank.value, id: a.id }, { rank: b.rank.value, id: b.id }));
}

/**
 * Every workspace reference a block's property values hold, as scannable text.
 *
 * A2 says the reference lives in the referring content and backlinks are
 * derived. A relation cell IS referring content, so it has to reach the same
 * extractor the prose does — otherwise "what links here" would answer correctly
 * for a link typed in a paragraph and silently miss the same link stored in a
 * relation column, which is the split A2 exists to prevent.
 *
 * Returned as text rather than as refs so it can be concatenated with the
 * block's prose and handed to the ONE extractor, instead of growing a second
 * path that decides for itself what counts as a reference.
 */
export function blockPropertyText(block: NoteBlock): string {
  const props = block.props;
  if (!props) return '';
  const parts: string[] = [];
  for (const stamped of Object.values(props)) {
    const value = stamped?.value;
    if (typeof value === 'string') parts.push(value);
    else if (Array.isArray(value)) for (const entry of value) if (typeof entry === 'string') parts.push(entry);
  }
  return parts.join('\n');
}

/* ------------------------------------------------------------- projection */

export interface DatabaseCell {
  property: NotePropertyDef;
  value: NotePropertyValue;
  /** One line of text for the cell, so every surface shows the same string. */
  display: string;
  /** True when this build cannot evaluate the property's type (§3, or a newer client). */
  unsupported: boolean;
}

export interface DatabaseRowView {
  id: string;
  block: NoteBlock;
  title: string;
  icon: string | null;
  cover: string | null;
  /** In the view's visible order. */
  cells: DatabaseCell[];
}

export interface DatabaseProjection {
  database: NoteBlock;
  title: string;
  view: NoteDatabaseView;
  kind: NoteViewKind;
  /** Visible property defs, in the view's order. */
  columns: NotePropertyDef[];
  /** Filtered and sorted. Every row the view shows. */
  rows: DatabaseRowView[];
  /**
   * Buckets, for a grouped view. Always includes the no-value bucket — see
   * `groupRows` for why it exists even when it is empty.
   */
  groups: RowGroup<DatabaseRowView>[];
  /** Rows in the database before the filter ran. */
  total: number;
  /** How many the filter removed. Reported, so "where did my row go" has an answer. */
  filteredOut: number;
  /** Filter and sort rules this build could not apply. Never silently resolved. */
  skipped: SkippedRule[];
  /** Sentences a surface shows above the view. Empty is the normal case. */
  notices: string[];
}

function cellsFor(block: NoteBlock, columns: readonly NotePropertyDef[], unsupported: ReadonlySet<string>): DatabaseCell[] {
  return columns.map((property) => {
    const value = rowPropertyValue(block, property);
    return {
      property,
      value,
      display: formatPropertyValue(property, value),
      unsupported: unsupported.has(property.id),
    };
  });
}

/**
 * Project a database through one of its views.
 *
 * The order is filter, then sort, then group — and grouping last is what makes
 * the group counts describe the rows the person can actually see. Grouping first
 * would produce columns whose headers count rows the filter then removed.
 */
export function projectDatabase(
  blocks: Iterable<NoteBlock>,
  databaseId: string,
  viewId?: string,
): DatabaseProjection | null {
  const all = [...blocks];
  const block = all.find((candidate) => candidate.id === databaseId && isLiveBlock(candidate));
  // Refused rather than repaired. Projecting a paragraph would list its children
  // as rows and give it a title column, which renders as a database somebody
  // apparently made by accident — and the caller would have no way to tell that
  // from a real one that had lost its schema.
  if (!block || !isDatabaseBlock(block)) return null;

  const database = readDatabase(block);
  const view = database.views.find((candidate) => candidate.id === viewId) ?? database.views[0]!;
  const defs = schemaIndex(database.schema);
  const unsupported = new Set(database.unsupported);

  const columns = view.visible
    .map((id) => defs.get(id))
    .filter((def): def is NotePropertyDef => !!def);

  const rowBlocks = databaseRowBlocks(all, databaseId);
  const skipped: SkippedRule[] = [];
  const notices: string[] = [];

  const kept: NoteBlock[] = [];
  for (const row of rowBlocks) {
    const outcome = evaluateFilter(view.filter, defs, (propertyId) => {
      const def = defs.get(propertyId);
      return def ? rowPropertyValue(row, def) : null;
    });
    // The skipped rules are the same for every row, so only the first pass's are
    // kept — repeating them once per row would bury the sentence in a hundred
    // copies of itself.
    if (kept.length === 0 && skipped.length === 0) skipped.push(...outcome.skipped);
    if (outcome.matched) kept.push(row);
  }
  if (rowBlocks.length === 0 && view.filter) {
    const probe = evaluateFilter(view.filter, defs, () => null);
    skipped.push(...probe.skipped);
  }

  const sorted = sortRows(
    kept,
    view.sort,
    defs,
    (row, propertyId) => {
      const def = defs.get(propertyId);
      return def ? rowPropertyValue(row, def) : null;
    },
    (a, b) => compareRank({ rank: a.rank.value, id: a.id }, { rank: b.rank.value, id: b.id }),
  );
  skipped.push(...sorted.skipped);

  const rows: DatabaseRowView[] = sorted.rows.map((row) => ({
    id: row.id,
    block: row,
    title: pageTitleOrDefault(row),
    icon: row.icon?.value ?? null,
    cover: row.cover?.value ?? null,
    cells: cellsFor(row, columns, unsupported),
  }));

  const groups = groupProjection(view, defs, rows, skipped, notices);

  if (database.unsupported.length > 0) {
    const names = database.unsupported
      .map((id) => defs.get(id)?.name ?? id)
      .join(', ');
    notices.push(
      `This version cannot read ${names}. The values are kept and shown as they are stored, ` +
      'but they cannot be filtered, sorted or grouped here.',
    );
  }

  return {
    database: block,
    title: database.title,
    view,
    kind: view.kind,
    columns,
    rows,
    groups,
    total: rowBlocks.length,
    filteredOut: rowBlocks.length - kept.length,
    skipped,
    notices,
  };
}

/**
 * The buckets a view renders, and what happens when it cannot have any.
 *
 * A board or a calendar with no grouping property still shows every row — in one
 * bucket, with a notice saying what is missing. The alternative, rendering
 * nothing until someone picks a property, hides the rows behind a configuration
 * step and looks exactly like an empty database.
 */
function groupProjection(
  view: NoteDatabaseView,
  defs: ReadonlyMap<string, NotePropertyDef>,
  rows: DatabaseRowView[],
  skipped: SkippedRule[],
  notices: string[],
): RowGroup<DatabaseRowView>[] {
  const needsGroup = GROUPED_VIEW_KINDS.includes(view.kind);
  const def = view.groupBy ? defs.get(view.groupBy) : undefined;

  if (view.groupBy && !def) {
    skipped.push({
      kind: 'group',
      property: view.groupBy,
      reason: 'unknown_property',
      detail: `This view groups by "${view.groupBy}", which is not a property of this database.`,
    });
  }

  if (!def) {
    if (!needsGroup) return [];
    notices.push(
      `A ${view.kind} needs a property to group by. Every row is in one group until one is chosen.`,
    );
    return [{ key: null, label: 'All rows', empty: false, rows }];
  }

  return groupRows(rows, def, (row) => rowPropertyValue(row.block, def));
}

/**
 * Bound the database fields of a pushed operation, or say what is wrong.
 *
 * The SERVER calls this, and it lives here so there is one rule rather than two.
 * These fields reach a shared surface: a schema is the header row every viewer
 * of a shared database sees, and property values reach search, backlinks and an
 * agent's context. A limit enforced only on the client is a limit, and a client
 * is not where a bound on what other people receive belongs.
 *
 * Shape is checked rather than trusted, but a value that is merely UNKNOWN is
 * accepted: `readDatabase` repairs what it can read and keeps what it cannot, so
 * rejecting a newer client's shape here would refuse the writes this build is
 * specifically designed to survive.
 */
export function validateDatabaseFields(patch: Record<string, unknown>): string | null {
  if (patch.props !== undefined) {
    if (typeof patch.props !== 'object' || patch.props === null || Array.isArray(patch.props)) {
      return 'Property values must arrive as an object keyed by property id.';
    }
    const entries = Object.entries(patch.props as Record<string, unknown>);
    if (entries.length > MAX_DATABASE_PROPERTIES) {
      return `A row carries at most ${MAX_DATABASE_PROPERTIES} property values.`;
    }
    for (const [key, value] of entries) {
      if (key.length > 128) return `"${key.slice(0, 32)}…" is not a property id.`;
      if (typeof value === 'string' && value.length > MAX_PROPERTY_TEXT) {
        return `A property value holds at most ${MAX_PROPERTY_TEXT} characters.`;
      }
      if (Array.isArray(value)) {
        if (value.length > MAX_PROPERTY_VALUES) {
          return `A property holds at most ${MAX_PROPERTY_VALUES} values.`;
        }
        for (const entry of value) {
          if (typeof entry === 'string' && entry.length > MAX_PROPERTY_TEXT) {
            return `A property value holds at most ${MAX_PROPERTY_TEXT} characters.`;
          }
        }
      }
    }
  }
  if (patch.schema !== undefined) {
    if (!Array.isArray(patch.schema)) return 'A schema is a list of property definitions.';
    if (patch.schema.length > MAX_DATABASE_PROPERTIES) {
      return `A database holds at most ${MAX_DATABASE_PROPERTIES} properties.`;
    }
  }
  if (patch.views !== undefined) {
    if (!Array.isArray(patch.views)) return 'Views are a list.';
    if (patch.views.length > MAX_DATABASE_VIEWS) {
      return `A database holds at most ${MAX_DATABASE_VIEWS} views.`;
    }
  }
  return null;
}

/** Coerce a written value against the database's schema. Used by every write path. */
export function coerceRowValue(
  database: NoteDatabase,
  propertyId: string,
  raw: unknown,
): { ok: true; def: NotePropertyDef; value: NotePropertyValue } | { ok: false; detail: string } {
  const def = schemaIndex(database.schema).get(propertyId);
  if (!def) {
    return { ok: false, detail: `There is no property "${propertyId}" in this database.` };
  }
  return { ok: true, def, value: coercePropertyValue(def, raw) };
}

/* ------------------------------------------------ the bounded read (Q3/E3) */

/**
 * Q3's bound, applied to a database instead of a page.
 *
 * A database is unbounded in exactly the way a page is — someone's reading list
 * runs to four hundred rows — so a reader that cannot afford the whole thing gets
 * its SHAPE and a sample. That is not a smaller projection: the columns are what
 * a caller needs in order to WRITE a cell, because a cell is addressed by
 * property id and a summary listing only the human-facing names would leave the
 * id to be guessed.
 *
 * `omittedLabel` follows `NoteBlockContext`'s: what was left out is stated, not
 * implied. A reader handed ten rows out of four hundred with nothing to say so
 * answers a question about the database from a sample and presents it as the
 * whole.
 */
export interface NoteDatabaseSummary {
  databaseId: string;
  title: string;
  view: { id: string; name: string; kind: NoteViewKind };
  views: Array<{ id: string; name: string; kind: NoteViewKind }>;
  columns: Array<{ id: string; name: string; type: string }>;
  rows: Array<{ uri: string; title: string; cells: Record<string, string> }>;
  totalRows: number;
  omittedLabel?: string;
}

/** How many rows are worth the tokens. The rest is a count, per Q3. */
export const DATABASE_SUMMARY_ROWS = 10;

export function summariseDatabase(
  blocks: Iterable<NoteBlock>,
  databaseId: string,
  sample = DATABASE_SUMMARY_ROWS,
): NoteDatabaseSummary | null {
  const projection = projectDatabase(blocks, databaseId);
  if (!projection) return null;
  const shown = projection.rows.slice(0, Math.max(0, sample));
  return {
    databaseId,
    title: projection.title,
    view: { id: projection.view.id, name: projection.view.name, kind: projection.kind },
    views: (projection.database.views?.value ?? []).map((v) => ({ id: v.id, name: v.name, kind: v.kind })),
    columns: projection.columns.map((c) => ({ id: c.id, name: c.name, type: c.type })),
    rows: shown.map((row) => ({
      uri: noteBlockUri(row.id),
      title: row.title,
      cells: Object.fromEntries(row.cells.map((cell) => [cell.property.id, cell.display])),
    })),
    totalRows: projection.total,
    ...(projection.total > shown.length
      ? { omittedLabel: `+${projection.total - shown.length} more rows in this database` }
      : {}),
  };
}
