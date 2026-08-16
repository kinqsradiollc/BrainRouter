/**
 * ADR-029 E3 — the gestures that make a database, through the store that
 * already exists.
 *
 * **Every one of these composes `noteStore`'s mutations.** Creating a database,
 * adding a column, adding a row and setting a cell are `createBlock` and
 * `updateBlock` calls — so leases are still checked, clocks still stamp, and the
 * outbox still queues one operation per block (B3). This is the same discipline
 * `blockOps.ts` follows for Enter and Backspace, and for the same reason: a
 * second write path is a path a lock cannot refuse and a sync cannot order.
 *
 * It is also how E3's decision is enforced rather than merely stated. A row is
 * created by `createBlock` with kind `page`, so it has a block id and no other
 * kind of id; a cell is written by `updateBlock`, so it travels the block's own
 * outbox stream; a row is deleted by `deleteBlock`, so it lands in the trash
 * with a tombstone like everything else.
 *
 * **What a concurrent SCHEMA edit costs, stated rather than discovered.** The
 * schema is one stamped field, so two devices adding a column at the same moment
 * keep one of the two definitions. That loss is bounded and recoverable in a way
 * a lost sentence is not: the property VALUES both devices wrote survive
 * untouched, because `props` merges per key on the row — so re-adding the column
 * brings its data straight back. `removeProperty` leaves the values on the rows
 * for exactly the same reason.
 */
import { isLiveBlock, type NoteBlock } from './block.js';
import {
  DATABASE_BLOCK_KIND, isDatabaseBlock, readDatabase, type NoteDatabase,
} from './database.js';
import {
  planAddDatabaseProperty, planCreateDatabaseRow, planDeleteDatabaseProperty,
  planDeleteDatabaseView, planReorderDatabaseProperties, planSaveDatabaseView,
  planSetDatabaseRowValue, planUpdateDatabaseProperty,
  rollupTargetPropertiesFromBlocks,
  type DatabaseMutationPlan,
} from './databaseMutation.js';
import {
  projectDatabase, type ComputeOptions, type DatabaseProjection,
} from './databaseProjection.js';
import { type NoteDatabaseView, type NoteViewKind } from './databaseView.js';
import {
  type NotePropertyDef, type NotePropertyType, type NoteRollupSpec,
  type NoteSelectOption, type NotePropertyValue,
} from './properties.js';
import {
  createBlock, deleteBlock, getBlock, listAllBlocks, listBlocks, notesDeviceId, updateBlock,
  type BlockPosition,
} from './noteStore.js';

export type DatabaseOpResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'not_found' | 'not_a_database' | 'refused' | 'locked'; detail: string };

const refuse = (
  reason: 'not_found' | 'not_a_database' | 'refused' | 'locked',
  detail: string,
): DatabaseOpResult<never> => ({ ok: false, reason, detail });

/** Read-only lookup used by the rollup picker; writes use the pure planners. */
function databaseAt(userId: string | undefined, id: string): DatabaseOpResult<NoteDatabase> {
  const block = getBlock(userId, id);
  if (!block || !isLiveBlock(block)) return refuse('not_found', `There is no database ${id}.`);
  if (!isDatabaseBlock(block)) return refuse('not_a_database', `Block ${id} is not a database.`);
  return { ok: true, value: readDatabase(block) };
}

function writePlan<T>(
  userId: string | undefined,
  blockId: string,
  plan: DatabaseMutationPlan<T>,
  nowMs: number,
): DatabaseOpResult<T> {
  if (!plan.ok) return plan;
  const written = updateBlock(userId, blockId, plan.patch, nowMs);
  if (!written.ok) {
    return written.reason === 'locked'
      ? refuse('locked', written.detail)
      : refuse('refused', 'The database could not be written.');
  }
  return { ok: true, value: plan.value };
}

/* --------------------------------------------------------------- creating */

export interface CreateDatabaseInput extends BlockPosition {
  title?: string;
  /** Supply a schema to start from; otherwise the default title column is used. */
  schema?: readonly NotePropertyDef[];
  views?: readonly NoteDatabaseView[];
}

/**
 * A new database — a block, with children that will be pages.
 *
 * There is nothing else to create. That is the whole of E3's claim: no table is
 * provisioned, no row type is registered, and nothing here knows about sync,
 * because the block it made already syncs.
 */
export function createDatabase(
  userId: string | undefined,
  input: CreateDatabaseInput,
  nowMs: number,
): NoteBlock {
  return createBlock(userId, {
    kind: DATABASE_BLOCK_KIND,
    text: input.title ?? '',
    ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
    ...(input.after ? { after: input.after } : {}),
    ...(input.before ? { before: input.before } : {}),
    ...(input.schema ? { schema: input.schema } : {}),
    ...(input.views ? { views: input.views } : {}),
  }, nowMs);
}

/** Every database in the notes tree — what a picker of "add a row to…" lists. */
export function listDatabases(userId: string | undefined): NoteBlock[] {
  return listBlocks(userId).filter(isDatabaseBlock);
}

/* -------------------------------------------------------------- the schema */

/**
 * A readable, stable id for a column.
 *
 * Derived from the name so a stored schema is legible when someone opens the
 * file, and de-duplicated against the schema it is joining because the id is
 * what every row's `props` key on. Two columns sharing an id would make one
 * column's values appear in the other.
 */
export { propertyIdFor } from './databaseMutation.js';

export interface AddPropertyInput {
  name: string;
  type: NotePropertyType;
  options?: readonly NoteSelectOption[];
  description?: string;
  /** Give the column a specific id — used when re-adding one whose values remain. */
  id?: string;
  /** F2 — the expression a `formula` column computes. */
  formula?: string;
  /** F2 — what a `rollup` column aggregates. */
  rollup?: NoteRollupSpec;
}

/**
 * Add a column.
 *
 * A second `title` is refused. Every title property reads the same field — the
 * row page's own `text` — so two of them are two columns that cannot disagree,
 * one of which is noise the person then has to maintain.
 */
export function addProperty(
  userId: string | undefined,
  databaseId: string,
  input: AddPropertyInput,
  nowMs: number,
): DatabaseOpResult<NotePropertyDef> {
  return writePlan(
    userId,
    databaseId,
    planAddDatabaseProperty(getBlock(userId, databaseId), databaseId, input),
    nowMs,
  );
}

export function updateProperty(
  userId: string | undefined,
  databaseId: string,
  propertyId: string,
  patch: {
    name?: string;
    options?: readonly NoteSelectOption[];
    description?: string;
    /** F2 — the formula IS patchable, unlike the type. See below. */
    formula?: string;
    rollup?: NoteRollupSpec;
  },
  nowMs: number,
): DatabaseOpResult<NotePropertyDef> {
  return writePlan(
    userId,
    databaseId,
    planUpdateDatabaseProperty(getBlock(userId, databaseId), databaseId, propertyId, patch),
    nowMs,
  );
}

/**
 * Remove a column — the definition only.
 *
 * **The values stay on the rows.** Removing a column must not delete data: a
 * person hiding a column they no longer want should be able to change their mind
 * an hour later and find their notes still there. Re-adding a property with the
 * same id brings every value straight back, because the values were never keyed
 * by anything but that id.
 *
 * The title column cannot be removed. It is the row page's own title, and a
 * database whose rows have no name is a list of blank lines.
 */
export function removeProperty(
  userId: string | undefined,
  databaseId: string,
  propertyId: string,
  nowMs: number,
): DatabaseOpResult<NotePropertyDef[]> {
  return writePlan(
    userId,
    databaseId,
    planDeleteDatabaseProperty(getBlock(userId, databaseId), databaseId, propertyId),
    nowMs,
  );
}

export function reorderProperties(
  userId: string | undefined,
  databaseId: string,
  order: readonly string[],
  nowMs: number,
): DatabaseOpResult<NotePropertyDef[]> {
  return writePlan(
    userId,
    databaseId,
    planReorderDatabaseProperties(getBlock(userId, databaseId), databaseId, order),
    nowMs,
  );
}

/* ---------------------------------------------------------------- the rows */

export interface AddRowInput extends BlockPosition {
  title?: string;
  /** Cell values by property id. Coerced against the schema before they are written. */
  values?: Record<string, unknown>;
}

/**
 * Add a row — which is to say, create a page under the database.
 *
 * The title goes into the page's `text` and never into `props`, so the name in
 * the table and the heading on the row's page are one string.
 */
export function addRow(
  userId: string | undefined,
  databaseId: string,
  input: AddRowInput,
  nowMs: number,
): DatabaseOpResult<NoteBlock> {
  const planned = planCreateDatabaseRow(getBlock(userId, databaseId), databaseId, input);
  if (!planned.ok) return planned;
  const row = createBlock(userId, {
    ...planned.value,
    parentId: databaseId,
    ...(input.after ? { after: input.after } : {}),
    ...(input.before ? { before: input.before } : {}),
  }, nowMs);
  return { ok: true, value: row };
}

/**
 * Write one cell.
 *
 * The database is found by walking to the row's PARENT rather than being passed
 * in, so a caller cannot write a value under a schema the row does not belong
 * to. The write itself is `updateBlock`, which means the lease refuses it while
 * another device is editing the row and the outbox carries it in order — the
 * same treatment a paragraph gets.
 */
export function setRowValue(
  userId: string | undefined,
  rowId: string,
  propertyId: string,
  raw: unknown,
  nowMs: number,
): DatabaseOpResult<NoteBlock> {
  const row = getBlock(userId, rowId);
  if (!row || !isLiveBlock(row)) return refuse('not_found', `There is no row ${rowId}.`);
  const parentId = row.parentId.value;
  if (!parentId) return refuse('not_a_database', 'That block is not a row of a database.');
  const planned = planSetDatabaseRowValue(
    getBlock(userId, parentId), parentId, row, propertyId, raw,
  );
  if (!planned.ok) {
    return planned.reason === 'not_a_database'
      ? refuse('not_a_database', 'That block is not a row of a database.')
      : planned;
  }
  const written = updateBlock(userId, rowId, planned.patch, nowMs);

  if (!written.ok) {
    return written.reason === 'locked'
      ? refuse('locked', written.detail)
      : refuse('refused', 'That cell could not be written.');
  }
  return { ok: true, value: written.block };
}

/** Remove a row. A tombstone in the trash, like every other block (C5). */
export function removeRow(
  userId: string | undefined,
  rowId: string,
  nowMs: number,
): DatabaseOpResult<string[]> {
  const row = getBlock(userId, rowId);
  if (!row || !isLiveBlock(row)) return refuse('not_found', `There is no row ${rowId}.`);
  return { ok: true, value: deleteBlock(userId, rowId, nowMs) };
}

/* --------------------------------------------------------------- the views */

export interface SaveViewInput {
  id?: string;
  name?: string;
  kind?: NoteViewKind;
  visible?: readonly string[];
  filter?: NoteDatabaseView['filter'];
  sort?: NoteDatabaseView['sort'];
  /** Pass `null` to stop grouping. */
  groupBy?: string | null;
}

/**
 * Create or replace a view.
 *
 * A view is configuration, not content, and it is stored on the database block
 * as one stamped field — so the last device to change a view wins the whole
 * list. That is the right trade here for the reason `blockMerge` gives about
 * `collapsed`: nobody's sentence is at stake, and a conflict banner over a sort
 * order teaches people to dismiss the banner that matters.
 */
export function saveView(
  userId: string | undefined,
  databaseId: string,
  input: SaveViewInput,
  nowMs: number,
): DatabaseOpResult<NoteDatabaseView> {
  return writePlan(
    userId,
    databaseId,
    planSaveDatabaseView(getBlock(userId, databaseId), databaseId, input),
    nowMs,
  );
}

/**
 * Remove a view.
 *
 * The last one cannot go. A database with no views renders nothing, which is
 * indistinguishable from a database with no rows — so the person who deleted
 * their only view would conclude they had deleted their data.
 */
export function removeView(
  userId: string | undefined,
  databaseId: string,
  viewId: string,
  nowMs: number,
): DatabaseOpResult<NoteDatabaseView[]> {
  return writePlan(
    userId,
    databaseId,
    planDeleteDatabaseView(getBlock(userId, databaseId), databaseId, viewId),
    nowMs,
  );
}

/* -------------------------------------------------------------- projection */

/**
 * What a surface renders — filter, sort and grouping applied in core.
 *
 * Computed here rather than per surface so E1's parity argument holds for
 * databases too: a saved view that hid different rows on the desktop and the
 * dashboard would be indistinguishable from data having gone missing.
 */
export function readDatabaseView(
  userId: string | undefined,
  databaseId: string,
  viewId?: string,
  opts: ComputeOptions = {},
): DatabaseProjection | null {
  return projectDatabase(listAllBlocks(userId), databaseId, viewId, {
    // F3 — the reading device, so `created by` says "This device" rather than
    // printing an id. Defaulted here rather than at every call site: a caller
    // that forgot would get a column reading "Another device" for its own work.
    deviceId: notesDeviceId(userId),
    ...opts,
  });
}

/**
 * F2 — the properties a rollup on this database could summarise.
 *
 * Derived from where the relation column actually POINTS rather than from a
 * fixed list, because a relation can address any row of any database (E5). A
 * picker built from this offers exactly the columns that exist on the other end;
 * one built from a guess offers a target that every row reports as unreadable.
 */
export function rollupTargetProperties(
  userId: string | undefined,
  databaseId: string,
  relationPropertyId: string,
): DatabaseOpResult<{ properties: NotePropertyDef[]; databases: Array<{ id: string; title: string }> }> {
  return rollupTargetPropertiesFromBlocks(listAllBlocks(userId), databaseId, relationPropertyId);
}
