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
  coerceRowValue, DATABASE_BLOCK_KIND, defaultDatabaseSchema,
  isDatabaseBlock, projectDatabase, readDatabase, schemaIndex, TITLE_PROPERTY_ID,
  type DatabaseProjection, type NoteDatabase,
} from './database.js';
import {
  isNoteViewKind, MAX_DATABASE_VIEWS,
  type NoteDatabaseView, type NoteViewKind,
} from './databaseView.js';
import {
  isNotePropertyType, MAX_DATABASE_PROPERTIES,
  type NotePropertyDef, type NotePropertyType, type NoteSelectOption, type NotePropertyValue,
} from './properties.js';
import {
  createBlock, deleteBlock, getBlock, listAllBlocks, listBlocks, updateBlock,
  type BlockPosition,
} from './noteStore.js';

export type DatabaseOpResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'not_found' | 'not_a_database' | 'refused' | 'locked'; detail: string };

const refuse = (
  reason: 'not_found' | 'not_a_database' | 'refused' | 'locked',
  detail: string,
): DatabaseOpResult<never> => ({ ok: false, reason, detail });

/** The database block, or the reason it is not one. */
function databaseAt(userId: string | undefined, id: string): DatabaseOpResult<NoteDatabase> {
  const block = getBlock(userId, id);
  if (!block || !isLiveBlock(block)) return refuse('not_found', `There is no database ${id}.`);
  if (!isDatabaseBlock(block)) return refuse('not_a_database', `Block ${id} is not a database.`);
  return { ok: true, value: readDatabase(block) };
}

/**
 * Write a repaired schema back.
 *
 * `readDatabase` fills in what a stored schema was missing — a title column, a
 * default view — and this writes that repaired form rather than the stored one.
 * Otherwise the first edit to an older database would save a list that still had
 * the gap, and the repair would run again on every read forever.
 */
function saveSchema(
  userId: string | undefined,
  database: NoteDatabase,
  schema: readonly NotePropertyDef[],
  nowMs: number,
): DatabaseOpResult<NotePropertyDef[]> {
  if (schema.length > MAX_DATABASE_PROPERTIES) {
    return refuse('refused', `A database holds at most ${MAX_DATABASE_PROPERTIES} properties.`);
  }
  const known = new Set(schema.map((def) => def.id));
  // A view pointing at a column that has gone would render a header with no
  // cells, and a board grouped by one would have nothing to make columns from.
  // Both are trimmed with the schema so the two cannot drift.
  const views = database.views.map(({ groupBy, ...view }) => ({
    ...view,
    visible: view.visible.filter((id) => known.has(id)),
    ...(groupBy && known.has(groupBy) ? { groupBy } : {}),
  }));

  const written = updateBlock(userId, database.block.id, { schema, views }, nowMs);
  if (!written.ok) {
    return written.reason === 'locked'
      ? refuse('locked', written.detail)
      : refuse('refused', 'The database could not be written.');
  }
  return { ok: true, value: [...schema] };
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
export function propertyIdFor(name: string, taken: ReadonlySet<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'property';
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

export interface AddPropertyInput {
  name: string;
  type: NotePropertyType;
  options?: readonly NoteSelectOption[];
  description?: string;
  /** Give the column a specific id — used when re-adding one whose values remain. */
  id?: string;
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
  const found = databaseAt(userId, databaseId);
  if (!found.ok) return found;
  const database = found.value;

  if (!isNotePropertyType(input.type)) {
    return refuse('refused', `"${input.type}" is not a property type.`);
  }
  if (input.type === 'title' && database.schema.some((def) => def.type === 'title')) {
    return refuse('refused', 'A database has one title column, and it is the row page’s own title.');
  }

  const taken = new Set(database.schema.map((def) => def.id));
  const id = input.id && !taken.has(input.id) ? input.id : propertyIdFor(input.name, taken);
  const def: NotePropertyDef = {
    id,
    name: input.name.trim() || id,
    type: input.type,
    ...(input.options && input.options.length > 0 ? { options: input.options } : {}),
    ...(input.description ? { description: input.description } : {}),
  };

  const saved = saveSchema(userId, database, [...database.schema, def], nowMs);
  if (!saved.ok) return saved;

  // New columns are visible by default. A column added and then not shown is a
  // column the person concludes was not added.
  const views = database.views.map((view) => ({ ...view, visible: [...view.visible, id] }));
  const written = updateBlock(userId, databaseId, { views }, nowMs);
  if (!written.ok && written.reason === 'locked') return refuse('locked', written.detail);

  return { ok: true, value: def };
}

export function updateProperty(
  userId: string | undefined,
  databaseId: string,
  propertyId: string,
  patch: { name?: string; options?: readonly NoteSelectOption[]; description?: string },
  nowMs: number,
): DatabaseOpResult<NotePropertyDef> {
  const found = databaseAt(userId, databaseId);
  if (!found.ok) return found;
  const database = found.value;
  const existing = schemaIndex(database.schema).get(propertyId);
  if (!existing) return refuse('not_found', `There is no property "${propertyId}" in this database.`);

  // The TYPE is not patchable. Changing a column's type would have to reinterpret
  // every stored value, and a value that cannot be reinterpreted would be either
  // silently emptied or silently kept in the old shape — the first loses data,
  // the second leaves cells that no filter on the column can match. Adding a
  // column of the new type and moving the values is visible work with a visible
  // outcome.
  const next: NotePropertyDef = {
    ...existing,
    ...(patch.name !== undefined && patch.name.trim().length > 0 ? { name: patch.name.trim() } : {}),
    ...(patch.options !== undefined ? { options: patch.options } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
  };

  const schema = database.schema.map((def) => (def.id === propertyId ? next : def));
  const saved = saveSchema(userId, database, schema, nowMs);
  return saved.ok ? { ok: true, value: next } : saved;
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
  const found = databaseAt(userId, databaseId);
  if (!found.ok) return found;
  const database = found.value;

  const existing = schemaIndex(database.schema).get(propertyId);
  if (!existing) return refuse('not_found', `There is no property "${propertyId}" in this database.`);
  if (existing.type === 'title') {
    return refuse('refused', 'The title column is the row’s own title and cannot be removed.');
  }

  const schema = database.schema.filter((def) => def.id !== propertyId);
  return saveSchema(userId, database, schema.length > 0 ? schema : defaultDatabaseSchema(), nowMs);
}

export function reorderProperties(
  userId: string | undefined,
  databaseId: string,
  order: readonly string[],
  nowMs: number,
): DatabaseOpResult<NotePropertyDef[]> {
  const found = databaseAt(userId, databaseId);
  if (!found.ok) return found;
  const database = found.value;
  const byId = schemaIndex(database.schema);

  const moved: NotePropertyDef[] = [];
  for (const id of order) {
    const def = byId.get(id);
    if (def && !moved.includes(def)) moved.push(def);
  }
  // Anything the caller forgot keeps its place at the end rather than being
  // dropped: a reorder that silently deletes the column it did not mention is a
  // schema edit disguised as a drag.
  for (const def of database.schema) if (!moved.includes(def)) moved.push(def);

  return saveSchema(userId, database, moved, nowMs);
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
  const found = databaseAt(userId, databaseId);
  if (!found.ok) return found;
  const database = found.value;

  const props: Record<string, NotePropertyValue> = {};
  for (const [propertyId, raw] of Object.entries(input.values ?? {})) {
    const coerced = coerceRowValue(database, propertyId, raw);
    // A value for a column that does not exist is refused rather than stored:
    // data nothing can display is data nobody will find again.
    if (!coerced.ok) return refuse('refused', coerced.detail);
    if (coerced.def.type === 'title') continue;
    props[propertyId] = coerced.value;
  }

  const titleValue = input.values?.[TITLE_PROPERTY_ID];
  const title = input.title ?? (typeof titleValue === 'string' ? titleValue : '');

  const row = createBlock(userId, {
    kind: 'page',
    text: title,
    parentId: databaseId,
    ...(input.after ? { after: input.after } : {}),
    ...(input.before ? { before: input.before } : {}),
    ...(Object.keys(props).length > 0 ? { props } : {}),
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
  const found = databaseAt(userId, parentId);
  if (!found.ok) {
    return found.reason === 'not_a_database'
      ? refuse('not_a_database', 'That block is not a row of a database.')
      : found;
  }

  const coerced = coerceRowValue(found.value, propertyId, raw);
  if (!coerced.ok) return refuse('refused', coerced.detail);

  const written = coerced.def.type === 'title'
    // E4's "title as its own field": a title write is a write to the page's own
    // text, never a second copy in `props`.
    ? updateBlock(userId, rowId, { text: typeof coerced.value === 'string' ? coerced.value : '' }, nowMs)
    : updateBlock(userId, rowId, { props: { [propertyId]: coerced.value } }, nowMs);

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
  const found = databaseAt(userId, databaseId);
  if (!found.ok) return found;
  const database = found.value;

  const existing = input.id ? database.views.find((view) => view.id === input.id) : undefined;
  if (!existing && database.views.length >= MAX_DATABASE_VIEWS) {
    return refuse('refused', `A database holds at most ${MAX_DATABASE_VIEWS} views.`);
  }

  const kind: NoteViewKind = isNoteViewKind(input.kind) ? input.kind : existing?.kind ?? 'table';
  const known = new Set(database.schema.map((def) => def.id));
  const visible = (input.visible ?? existing?.visible ?? database.schema.map((def) => def.id))
    .filter((id) => known.has(id));

  const groupBy = input.groupBy === null
    ? undefined
    : input.groupBy !== undefined
      ? (known.has(input.groupBy) ? input.groupBy : undefined)
      : existing?.groupBy;

  const view: NoteDatabaseView = {
    id: existing?.id ?? input.id ?? viewIdFor(input.name ?? kind, new Set(database.views.map((v) => v.id))),
    name: input.name?.trim() || existing?.name || defaultViewName(kind),
    kind,
    visible: visible.length > 0 ? visible : database.schema.map((def) => def.id),
    ...(input.filter !== undefined ? { filter: input.filter } : existing?.filter ? { filter: existing.filter } : {}),
    ...(input.sort !== undefined ? { sort: input.sort } : existing?.sort ? { sort: existing.sort } : {}),
    ...(groupBy ? { groupBy } : {}),
  };

  const views = existing
    ? database.views.map((candidate) => (candidate.id === view.id ? view : candidate))
    : [...database.views, view];

  const written = updateBlock(userId, databaseId, { views }, nowMs);
  if (!written.ok) {
    return written.reason === 'locked'
      ? refuse('locked', written.detail)
      : refuse('refused', 'The view could not be written.');
  }
  return { ok: true, value: view };
}

function defaultViewName(kind: NoteViewKind): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

function viewIdFor(name: string, taken: ReadonlySet<string>): string {
  return propertyIdFor(name, taken);
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
  const found = databaseAt(userId, databaseId);
  if (!found.ok) return found;
  const database = found.value;

  if (database.views.length <= 1) {
    return refuse('refused', 'A database keeps at least one view.');
  }
  const views = database.views.filter((view) => view.id !== viewId);
  if (views.length === database.views.length) {
    return refuse('not_found', `There is no view "${viewId}" on this database.`);
  }

  const written = updateBlock(userId, databaseId, { views }, nowMs);
  if (!written.ok) {
    return written.reason === 'locked'
      ? refuse('locked', written.detail)
      : refuse('refused', 'The view could not be removed.');
  }
  return { ok: true, value: views };
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
): DatabaseProjection | null {
  return projectDatabase(listAllBlocks(userId), databaseId, viewId);
}
