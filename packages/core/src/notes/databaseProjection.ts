/**
 * ADR-029 E3 + F2 — projecting a database through a view, and the derived cells.
 *
 * This was the second half of `database.ts` and it is a separate module for a
 * reason with a number on it. `database.ts` is the MODEL — what a stored schema
 * means, what a cell holds, what a write may contain — and it is read by
 * everything: a sidebar counting columns, a validator on the server, a harness
 * building a fixture. The PROJECTION is the part that computes, and F2 gave it a
 * formula engine and a rollup: about twenty kilobytes that every consumer of the
 * model was suddenly carrying, including the desktop's initial bundle, whose
 * budget is enforced (`scripts/verify-visual-release.mjs`).
 *
 * Splitting them means the model costs what the model costs. A surface that
 * renders rows takes the engine with it; one that only reads a schema does not.
 * That is rule 6's "per-concern sibling" applied for a measurable reason rather
 * than a stylistic one — and the seam is real, not cosmetic: nothing here is
 * needed to READ a database, and nothing in `database.ts` computes anything.
 *
 * The order inside `projectDatabase` is filter, then sort, then group, and
 * grouping last is what makes the group counts describe the rows the person can
 * actually see.
 */
import { isLiveBlock, noteBlockUri, pageTitleOrDefault, type NoteBlock } from './block.js';
import { createComputedReader, type ComputedReader } from './computed.js';
import {
  databaseRowBlocks, isDatabaseBlock, readDatabase, rowPropertyValue, schemaIndex,
} from './database.js';
import {
  evaluateFilter, groupRows, sortRows, GROUPED_VIEW_KINDS,
  type NoteDatabaseView, type NoteViewKind, type RowGroup, type SkippedRule,
} from './databaseView.js';
import type { NotePropertyDef, NotePropertyValue } from './properties.js';
import { compareRank } from './rank.js';
import type { WorkspaceRef } from '../workspace/references/ref.js';

/* ------------------------------------------------------------- projection */

export interface DatabaseCell {
  property: NotePropertyDef;
  value: NotePropertyValue;
  /** One line of text for the cell, so every surface shows the same string. */
  display: string;
  /** True when this build cannot evaluate the property's type (a newer client's). */
  unsupported: boolean;
  /**
   * F2/F3 — the value was COMPUTED, so nothing may write it.
   *
   * Distinct from `unsupported`, and the difference is what a surface does: an
   * unsupported cell is one this build cannot read and shows as it was stored, a
   * computed one is read-only because writing it would be writing to a
   * derivation. Collapsing them would make every formula look like a column from
   * a newer client.
   */
  computed: boolean;
  /** F2 — why a computed cell has no value. Rendered IN the cell. */
  error?: string;
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

function cellsFor(
  block: NoteBlock,
  columns: readonly NotePropertyDef[],
  unsupported: ReadonlySet<string>,
  reader: ComputedReader,
): DatabaseCell[] {
  return columns.map((property) => {
    const cell = reader.read(block, property);
    return {
      property,
      value: cell.value,
      display: cell.display,
      unsupported: unsupported.has(property.id),
      computed: cell.computed,
      ...(cell.error ? { error: cell.error } : {}),
    };
  });
}

/**
 * F2/F3 — the reader a projection computes its derived cells with.
 *
 * Exported because the SERVER projects databases too (E7/Q5), and a rollup that
 * counted different rows on the dashboard and the desktop would be the split E1
 * exists to prevent, with a number instead of a row.
 *
 * The schema lookups are memoised per parent block: a rollup over four hundred
 * rows otherwise re-parses one target database's schema four hundred times, and
 * `readDatabase` is a repair pass rather than a getter.
 */
export function databaseComputedReader(
  blocks: readonly NoteBlock[],
  opts: ComputeOptions = {},
): ComputedReader {
  const byId = new Map(blocks.map((block) => [block.id, block] as const));
  const schemas = new Map<string, readonly NotePropertyDef[]>();

  const schemaOf = (block: NoteBlock): readonly NotePropertyDef[] => {
    const parentId = block.parentId.value;
    // A database block's OWN schema governs its rows; a block that is itself a
    // database is governed by nothing, and asking for its cells is a question
    // about the wrong noun.
    const owner = parentId ? byId.get(parentId) : undefined;
    if (!owner || !isDatabaseBlock(owner)) return [];
    const cached = schemas.get(owner.id);
    if (cached) return cached;
    const schema = readDatabase(owner).schema;
    schemas.set(owner.id, schema);
    return schema;
  };

  return createComputedReader({
    blockById: (id) => byId.get(id),
    schemaOf,
    storedValue: rowPropertyValue,
    nowMs: opts.nowMs ?? Date.now(),
    ...(opts.deviceId ? { deviceId: opts.deviceId } : {}),
    ...(opts.canSee ? { canSee: opts.canSee } : {}),
  });
}

/** What a projection needs in order to compute F2/F3's derived columns. */
export interface ComputeOptions {
  /** `now()` and `today()`. Passed in so a test is not a race against the clock. */
  nowMs?: number;
  /** This device, so `created by` reads as "This device" rather than a hash. */
  deviceId?: string;
  /** A4 — whether the viewer may see a rollup's target. See `rollup.ts`. */
  canSee?: (ref: WorkspaceRef) => boolean;
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
  opts: ComputeOptions = {},
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

  // F2/F3 — ONE reader for the whole projection, so a formula is worked out once
  // per row and the filter, the sort, the grouping and the cell all read the
  // same answer. A filter that recomputed separately could keep a row the cell
  // then renders differently, and there would be nothing on screen to say which
  // of the two was the value.
  const reader = databaseComputedReader(all, opts);

  const kept: NoteBlock[] = [];
  for (const row of rowBlocks) {
    const outcome = evaluateFilter(view.filter, defs, (propertyId) => {
      const def = defs.get(propertyId);
      return def ? reader.valueOf(row, def) : null;
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
      return def ? reader.valueOf(row, def) : null;
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
    cells: cellsFor(row, columns, unsupported, reader),
  }));

  const groups = groupProjection(view, defs, rows, skipped, notices, reader);

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
  reader: ComputedReader,
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

  return groupRows(rows, def, (row) => reader.valueOf(row.block, def));
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
  opts: ComputeOptions = {},
): NoteDatabaseSummary | null {
  const projection = projectDatabase(blocks, databaseId, undefined, opts);
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
