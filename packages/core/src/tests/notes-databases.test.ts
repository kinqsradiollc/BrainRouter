/**
 * ADR-029 E3 — a database row IS a page, and these tests are how that is
 * checked rather than asserted.
 *
 * The claims worth pinning are the ones a second store would fail:
 *
 *  - A row's id is a BLOCK id, its parent is the database block, and deleting it
 *    puts it in the same trash everything else lands in.
 *  - Two devices setting two different properties of one row do not conflict,
 *    which is B1's sentence about paragraphs applied one level down.
 *  - A relation cell reaches the same backlink extractor a paragraph does, so
 *    "what links here" cannot answer correctly for one and miss the other (A2).
 *  - A notes file written before this layer READS, with a fixture in the older
 *    shape rather than a claim that it would.
 *
 * The filter and grouping tests are about the two silent failures the ADR names:
 * a rule that could not be evaluated must not remove rows, and a row with no
 * value for the grouping property must not disappear.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Hlc } from '../sync/hybridClock.js';
import type { NoteBlock } from '../notes/block.js';
import { mergeNoteBlock } from '../notes/blockMerge.js';
import {
  coercePropertyValue, comparePropertyValues, formatPropertyValue, normaliseDateValue,
  propertyGroupKeys, propertyValueRefs, type NotePropertyDef,
} from '../notes/properties.js';
import {
  evaluateFilter, groupRows, operatorsFor, sortRows,
  type NoteFilterGroup,
} from '../notes/databaseView.js';
import {
  projectDatabase, readDatabase, rowPropertyValue, validateDatabaseFields,
} from '../notes/database.js';
import {
  addProperty, addRow, createDatabase, listDatabases, readDatabaseView, removeProperty,
  removeRow, removeView, saveView, setRowValue, updateProperty,
} from '../notes/databaseOps.js';
import { createBlock, deleteBlock, getBlock, listTrash, readNotes, writeNotes } from '../notes/noteStore.js';
import { blockReferences, blocksReferencing, noteReferenceSources } from '../notes/noteSearch.js';
import { WorkspaceBacklinkIndex } from '../workspace/references/backlinks.js';

const T = Date.parse('2026-08-07T09:00:00.000Z');

/** Notes are USER-scoped (D1), so a test that does not redirect the home writes real notes. */
function home(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'br-notes-db-'));
  process.env.BRAINROUTER_HOME = dir;
  return dir;
}
function cleanup(dir: string): void {
  delete process.env.BRAINROUTER_HOME;
  rmSync(dir, { recursive: true, force: true });
}

const at = (physical: number, logical = 0, deviceId = 'da'): Hlc => ({ physical, logical, deviceId });
const s = <T>(value: T, stamp = at(100)) => ({ value, at: stamp });

function textDef(over: Partial<NotePropertyDef> = {}): NotePropertyDef {
  return { id: 'notes', name: 'Notes', type: 'text', ...over };
}

/* ------------------------------------------------- a row is a page, not a row */

test('a row has a block id, a block parent and nothing else that identifies it', () => {
  const dir = home();
  try {
    const database = createDatabase(undefined, { title: 'Reading list' }, T);
    const added = addRow(undefined, database.id, { title: 'Designing Data-Intensive Applications' }, T);
    assert.ok(added.ok);

    const row = getBlock(undefined, added.value.id)!;
    // The properties a second store would have had to provide separately.
    assert.equal(row.parentId.value, database.id, 'the row hangs off the database block');
    assert.equal(row.kind.value, 'page', 'a row IS a page');
    assert.equal(row.text.value, 'Designing Data-Intensive Applications', 'the title is the page’s own text');
    assert.ok(row.rank.value.length > 0, 'a row sorts by the same rank string every sibling uses');
  } finally { cleanup(dir); }
});

test('deleting a row puts it in the ordinary trash, tombstoned like any block', () => {
  const dir = home();
  try {
    const database = createDatabase(undefined, { title: 'CRM' }, T);
    const added = addRow(undefined, database.id, { title: 'Acme' }, T);
    assert.ok(added.ok);

    const removed = removeRow(undefined, added.value.id, T + 1);
    assert.ok(removed.ok);
    assert.deepEqual(removed.value, [added.value.id]);

    const trash = listTrash(undefined);
    assert.equal(trash.length, 1);
    assert.equal(trash[0]!.block.id, added.value.id);
  } finally { cleanup(dir); }
});

test('a cell write travels the block’s own outbox — no second sync path', () => {
  const dir = home();
  try {
    const database = createDatabase(undefined, { title: 'Recipes' }, T);
    const added = addProperty(undefined, database.id, { name: 'Servings', type: 'number' }, T);
    assert.ok(added.ok);
    const row = addRow(undefined, database.id, { title: 'Soup' }, T);
    assert.ok(row.ok);

    const before = readNotes(undefined).outbox.operations.length;
    const written = setRowValue(undefined, row.value.id, added.value.id, 4, T + 1);
    assert.ok(written.ok);

    const operations = readNotes(undefined).outbox.operations;
    assert.equal(operations.length, before + 1, 'exactly one queued operation');
    const queued = operations[operations.length - 1]!;
    assert.equal(queued.itemId, row.value.id, 'queued against the ROW block, per B3');
    assert.deepEqual((queued.payload as { props: Record<string, unknown> }).props, { servings: 4 });
  } finally { cleanup(dir); }
});

/* ------------------------------------------------------------ the title field */

test('a title write goes to the page’s own text, never into props', () => {
  const dir = home();
  try {
    const database = createDatabase(undefined, { title: 'Books' }, T);
    const row = addRow(undefined, database.id, { title: 'first' }, T);
    assert.ok(row.ok);

    const written = setRowValue(undefined, row.value.id, 'title', 'second', T + 1);
    assert.ok(written.ok);

    const block = getBlock(undefined, row.value.id)!;
    assert.equal(block.text.value, 'second');
    assert.equal(block.props?.title, undefined, 'a second copy of the title is E2’s mistake in miniature');
  } finally { cleanup(dir); }
});

test('a second title column is refused, because both would read the same field', () => {
  const dir = home();
  try {
    const database = createDatabase(undefined, { title: 'Books' }, T);
    const second = addProperty(undefined, database.id, { name: 'Name again', type: 'title' }, T);
    assert.equal(second.ok, false);
  } finally { cleanup(dir); }
});

/* ------------------------------------------------------------------- merging */

test('two devices setting two DIFFERENT properties of one row do not conflict', () => {
  // B1's sentence about two paragraphs of one page, one level down. A whole-map
  // stamp would make the later write take both cells and silently drop one.
  const base: NoteBlock = {
    id: 'row', parentId: s<string | null>('db'), rank: s('A1'), kind: s('page' as const), text: s('Acme'),
  };
  const ours: NoteBlock = { ...base, props: { status: { value: 'open', at: at(200, 0, 'da') } } };
  const theirs: NoteBlock = { ...base, props: { owner: { value: ['sam'], at: at(201, 0, 'db') } } };

  const merged = mergeNoteBlock(ours, theirs);
  assert.equal(merged.props?.status?.value, 'open');
  assert.deepEqual(merged.props?.owner?.value, ['sam']);
  assert.equal(merged.conflicts, undefined, 'different properties are not a conflict at all');
});

test('a concurrent edit to ONE property is last-writer-wins with no marker', () => {
  // Deliberate, and stated in `mergeProps`: this function has one block and can
  // never see the database, so it cannot know a property's type — and a cell is
  // not a paragraph. Prose lives in the row's page body, where `mergeText` does
  // keep both versions.
  const base: NoteBlock = {
    id: 'row', parentId: s<string | null>('db'), rank: s('A1'), kind: s('page' as const), text: s('Acme'),
  };
  const ours: NoteBlock = { ...base, props: { status: { value: 'open', at: at(300, 0, 'da') } } };
  const theirs: NoteBlock = { ...base, props: { status: { value: 'won', at: at(300, 0, 'db') } } };

  const merged = mergeNoteBlock(ours, theirs);
  assert.equal(merged.conflicts, undefined, 'no conflict banner over a cell');
  // The HLC's device tie-break decides, so both devices reach the same answer.
  assert.equal(merged.props?.status?.value, 'won');
  assert.equal(mergeNoteBlock(theirs, ours).props?.status?.value, 'won', 'and it is symmetric');
});

test('setting a cell counts as work, so it outranks a tombstone from another device', () => {
  const base: NoteBlock = {
    id: 'row', parentId: s<string | null>('db'), rank: s('A1'), kind: s('page' as const), text: s('Acme'),
  };
  const deleted: NoteBlock = { ...base, deletedAt: at(400, 0, 'da') };
  const edited: NoteBlock = { ...base, props: { status: { value: 'won', at: at(500, 0, 'db') } } };

  const merged = mergeNoteBlock(deleted, edited);
  assert.ok(merged.conflicts?.deleted, 'a cell written after a delete is a decision for a person');
});

/* -------------------------------------------------------------- coercion */

test('a value that cannot be coerced becomes empty rather than being stored as typed', () => {
  const number = { id: 'n', name: 'N', type: 'number' } satisfies NotePropertyDef;
  assert.equal(coercePropertyValue(number, '42'), 42);
  assert.equal(coercePropertyValue(number, 'abc'), null);
  // An unset checkbox is FALSE, not empty — a third state nobody can enter.
  const checkbox = { id: 'c', name: 'C', type: 'checkbox' } satisfies NotePropertyDef;
  assert.equal(coercePropertyValue(checkbox, undefined), null);
  assert.equal(coercePropertyValue(checkbox, 'nonsense'), false);
});

test('a date-only value stays a day, because turning it into an instant picks a timezone', () => {
  assert.equal(normaliseDateValue('2026-08-07'), '2026-08-07');
  assert.equal(normaliseDateValue('2026-08-07T10:30:00Z'), '2026-08-07T10:30:00.000Z');
  assert.equal(normaliseDateValue('not a date'), null);
});

test('a relation keeps only well-formed references, canonically spelled', () => {
  const relation = { id: 'r', name: 'R', type: 'relation' } satisfies NotePropertyDef;
  const value = coercePropertyValue(relation, [
    'brainrouter://planner/item/itm_4f2a',
    'not-a-uri',
  ]);
  assert.deepEqual(value, ['brainrouter://planner/item/itm_4f2a']);
  assert.equal(propertyValueRefs(value).length, 1);
});

/* ------------------------------------------------------------ E5 — backlinks */

test('a relation cell is a reference the backlink index sees, exactly like prose', () => {
  const dir = home();
  try {
    const database = createDatabase(undefined, { title: 'Work' }, T);
    const property = addProperty(undefined, database.id, { name: 'Pull request', type: 'relation' }, T);
    assert.ok(property.ok);
    const row = addRow(undefined, database.id, { title: 'Ship the parser' }, T);
    assert.ok(row.ok);

    const target = 'brainrouter://code/file/packages/core/src/notes/database.ts';
    const written = setRowValue(undefined, row.value.id, property.value.id, [target], T + 1);
    assert.ok(written.ok);

    const blocks = Object.values(readNotes(undefined).blocks);
    assert.deepEqual(blocksReferencing(blocks, target), [row.value.id]);
    assert.ok(blockReferences(getBlock(undefined, row.value.id)!).includes(target));

    // And the derived index agrees, because it is built from the same sources.
    const index = WorkspaceBacklinkIndex.rebuild(noteReferenceSources(blocks));
    const backlinks = index.backlinksTo({ mode: 'code', kind: 'file', id: 'packages/core/src/notes/database.ts' });
    assert.equal(backlinks.length, 1);
    assert.equal(backlinks[0]!.from.id, row.value.id);
  } finally { cleanup(dir); }
});

/* ---------------------------------------------------------------- filtering */

test('a filter rule this build cannot evaluate does NOT hide rows, and is reported', () => {
  // Both alternatives are silent lies: matching nothing empties a view someone
  // relies on, matching everything claims a filter ran when it did not.
  const defs = new Map<string, NotePropertyDef>([['formula', { id: 'formula', name: 'Total', type: 'formula' }]]);
  const filter: NoteFilterGroup = {
    combinator: 'and',
    rules: [{ property: 'formula', operator: 'greater-than', value: 10 }],
  };

  const outcome = evaluateFilter(filter, defs, () => null);
  assert.equal(outcome.matched, true, 'the row survives');
  assert.equal(outcome.skipped.length, 1);
  assert.equal(outcome.skipped[0]!.reason, 'unsupported_type');
});

test('an operator that does not apply to the type is skipped rather than guessed at', () => {
  const defs = new Map<string, NotePropertyDef>([['done', { id: 'done', name: 'Done', type: 'checkbox' }]]);
  const outcome = evaluateFilter(
    { combinator: 'and', rules: [{ property: 'done', operator: 'contains', value: 'x' }] },
    defs,
    () => true,
  );
  assert.equal(outcome.matched, true);
  assert.equal(outcome.skipped[0]!.reason, 'unsupported_operator');
});

test('an empty cell fails is-not, rather than being read as "not that value"', () => {
  // A blank status matching `is-not Done` mixes rows nobody triaged in with rows
  // someone actively marked, and the two mean different things.
  const defs = new Map<string, NotePropertyDef>([
    ['status', { id: 'status', name: 'Status', type: 'select', options: [{ id: 'done', label: 'Done' }] }],
  ]);
  const filter: NoteFilterGroup = {
    combinator: 'and',
    rules: [{ property: 'status', operator: 'is-not', value: 'done' }],
  };
  assert.equal(evaluateFilter(filter, defs, () => null).matched, false);
  assert.equal(evaluateFilter(filter, defs, () => 'open').matched, true);
  assert.equal(evaluateFilter(filter, defs, () => 'done').matched, false);
});

test('a multi-value cell is compared as a SET, not as a substring of its labels', () => {
  const defs = new Map<string, NotePropertyDef>([
    ['tags', { id: 'tags', name: 'Tags', type: 'multi-select' }],
  ]);
  const contains = { combinator: 'and' as const, rules: [{ property: 'tags', operator: 'contains' as const, value: ['ops'] }] };
  assert.equal(evaluateFilter(contains, defs, () => ['devops']).matched, false, '"ops" must not match "devops"');
  assert.equal(evaluateFilter(contains, defs, () => ['ops', 'devops']).matched, true);
});

test('links-to matches a relation ignoring the fragment, like every other backlink', () => {
  const defs = new Map<string, NotePropertyDef>([
    ['ref', { id: 'ref', name: 'Ref', type: 'relation' }],
  ]);
  const filter: NoteFilterGroup = {
    combinator: 'and',
    rules: [{ property: 'ref', operator: 'links-to', value: 'brainrouter://code/file/a.ts#L1' }],
  };
  assert.equal(evaluateFilter(filter, defs, () => ['brainrouter://code/file/a.ts#L99']).matched, true);
});

/* ------------------------------------------------------------------- sorting */

test('an empty cell sorts last in BOTH directions', () => {
  // Reversing a sort must not sweep every blank to the top, where they push the
  // rows that have values off the screen.
  const def: NotePropertyDef = { id: 'n', name: 'N', type: 'number' };
  const defs = new Map([[def.id, def]]);
  const rows = [{ id: 'a', n: 2 }, { id: 'b', n: null }, { id: 'c', n: 1 }];
  const cell = (row: typeof rows[number]) => row.n;
  const byId = (a: typeof rows[number], b: typeof rows[number]) => a.id.localeCompare(b.id);

  const asc = sortRows(rows, [{ property: 'n', direction: 'asc' }], defs, cell, byId);
  assert.deepEqual(asc.rows.map((r) => r.id), ['c', 'a', 'b']);
  const desc = sortRows(rows, [{ property: 'n', direction: 'desc' }], defs, cell, byId);
  assert.deepEqual(desc.rows.map((r) => r.id), ['a', 'c', 'b']);
});

test('a select sorts by the option order someone chose, never alphabetically', () => {
  const def: NotePropertyDef = {
    id: 'status', name: 'Status', type: 'select',
    options: [{ id: 'todo', label: 'To do' }, { id: 'doing', label: 'In progress' }, { id: 'done', label: 'Done' }],
  };
  assert.ok(comparePropertyValues(def, 'todo', 'done')! < 0, 'To do comes before Done because the person said so');
});

test('a sort on a type this build cannot order is skipped and reported', () => {
  const def: NotePropertyDef = { id: 'rollup', name: 'Rollup', type: 'rollup' };
  const outcome = sortRows(
    [{ id: 'a' }, { id: 'b' }],
    [{ property: 'rollup', direction: 'asc' }],
    new Map([[def.id, def]]),
    () => null,
    (a, b) => a.id.localeCompare(b.id),
  );
  assert.equal(outcome.skipped[0]!.reason, 'unsupported_type');
  assert.deepEqual(outcome.rows.map((r) => r.id), ['a', 'b'], 'the rows are still all there');
});

/* ------------------------------------------------------------------ grouping */

test('a row with no value for the grouping property lands in a bucket that is always there', () => {
  const def: NotePropertyDef = {
    id: 'status', name: 'Status', type: 'select',
    options: [{ id: 'todo', label: 'To do' }],
  };
  const rows = [{ id: 'a', status: 'todo' }, { id: 'b', status: null }];
  const groups = groupRows(rows, def, (row) => row.status);

  const none = groups.find((group) => group.empty)!;
  assert.ok(none, 'the no-value bucket exists');
  assert.equal(none.label, 'No Status');
  assert.deepEqual(none.rows.map((r) => r.id), ['b']);
  assert.equal(groups[groups.length - 1], none, 'and it is last, behind the work');
});

test('the no-value bucket exists even when nothing is in it', () => {
  const def: NotePropertyDef = { id: 'status', name: 'Status', type: 'select', options: [{ id: 'todo', label: 'To do' }] };
  const groups = groupRows([{ id: 'a', status: 'todo' }], def, (row) => row.status);
  assert.equal(groups.filter((group) => group.empty).length, 1);
});

test('a value naming an option the schema no longer lists gets its own group, not the empty one', () => {
  const def: NotePropertyDef = { id: 'status', name: 'Status', type: 'select', options: [{ id: 'todo', label: 'To do' }] };
  const groups = groupRows([{ id: 'a', status: 'archived' }], def, (row) => row.status);
  const orphan = groups.find((group) => group.key === 'archived');
  assert.ok(orphan, 'the row keeps its value rather than being called untriaged');
  assert.deepEqual(orphan!.rows.map((r) => r.id), ['a']);
});

test('a multi-value row appears in every group its value names', () => {
  const def: NotePropertyDef = { id: 'tags', name: 'Tags', type: 'multi-select' };
  assert.deepEqual(propertyGroupKeys(def, ['a', 'b']), ['a', 'b']);
  const groups = groupRows([{ id: 'r', tags: ['a', 'b'] }], def, (row) => row.tags);
  assert.equal(groups.filter((group) => group.rows.length === 1).length, 2);
});

/* ---------------------------------------------------------------- projection */

test('a board with no grouping property still shows every row, with a notice', () => {
  const dir = home();
  try {
    const database = createDatabase(undefined, { title: 'Pipeline' }, T);
    assert.ok(addRow(undefined, database.id, { title: 'one' }, T).ok);
    assert.ok(addRow(undefined, database.id, { title: 'two' }, T).ok);
    const view = saveView(undefined, database.id, { name: 'Board', kind: 'board' }, T);
    assert.ok(view.ok);

    const projection = readDatabaseView(undefined, database.id, view.value.id)!;
    assert.equal(projection.rows.length, 2);
    assert.equal(projection.groups.length, 1);
    assert.equal(projection.groups[0]!.rows.length, 2, 'nothing is hidden behind a configuration step');
    assert.ok(projection.notices.some((notice) => notice.includes('group by')));
  } finally { cleanup(dir); }
});

test('a projection reports how many rows the filter removed', () => {
  const dir = home();
  try {
    const database = createDatabase(undefined, { title: 'Tasks' }, T);
    const done = addProperty(undefined, database.id, { name: 'Done', type: 'checkbox' }, T);
    assert.ok(done.ok);
    const a = addRow(undefined, database.id, { title: 'a' }, T);
    const b = addRow(undefined, database.id, { title: 'b' }, T);
    assert.ok(a.ok && b.ok);
    assert.ok(setRowValue(undefined, a.value.id, done.value.id, true, T + 1).ok);

    const view = saveView(undefined, database.id, {
      id: 'table', filter: { combinator: 'and', rules: [{ property: done.value.id, operator: 'is', value: true }] },
    }, T + 2);
    assert.ok(view.ok);

    const projection = readDatabaseView(undefined, database.id, 'table')!;
    assert.deepEqual(projection.rows.map((row) => row.title), ['a']);
    assert.equal(projection.total, 2);
    assert.equal(projection.filteredOut, 1, '"where did my row go" has an answer');
  } finally { cleanup(dir); }
});

test('a calendar groups by day and keeps the rows with no date in an Unscheduled bucket', () => {
  const dir = home();
  try {
    const database = createDatabase(undefined, { title: 'Plan' }, T);
    const due = addProperty(undefined, database.id, { name: 'Due', type: 'date' }, T);
    assert.ok(due.ok);
    const scheduled = addRow(undefined, database.id, { title: 'scheduled' }, T);
    const floating = addRow(undefined, database.id, { title: 'floating' }, T);
    assert.ok(scheduled.ok && floating.ok);
    assert.ok(setRowValue(undefined, scheduled.value.id, due.value.id, '2026-09-01', T + 1).ok);

    const view = saveView(undefined, database.id, { name: 'Calendar', kind: 'calendar', groupBy: due.value.id }, T + 2);
    assert.ok(view.ok);

    const projection = readDatabaseView(undefined, database.id, view.value.id)!;
    const day = projection.groups.find((group) => group.key === '2026-09-01');
    assert.ok(day, 'the scheduled row is on its day');
    const unscheduled = projection.groups.find((group) => group.empty)!;
    assert.equal(unscheduled.label, 'Unscheduled');
    assert.deepEqual(unscheduled.rows.map((row) => row.title), ['floating']);
  } finally { cleanup(dir); }
});

/* ------------------------------------------------------------- schema edits */

test('removing a column removes the definition and KEEPS the values on the rows', () => {
  const dir = home();
  try {
    const database = createDatabase(undefined, { title: 'CRM' }, T);
    const stage = addProperty(undefined, database.id, { name: 'Stage', type: 'text' }, T);
    assert.ok(stage.ok);
    const row = addRow(undefined, database.id, { title: 'Acme' }, T);
    assert.ok(row.ok);
    assert.ok(setRowValue(undefined, row.value.id, stage.value.id, 'negotiating', T + 1).ok);

    assert.ok(removeProperty(undefined, database.id, stage.value.id, T + 2).ok);
    assert.equal(getBlock(undefined, row.value.id)!.props?.[stage.value.id]?.value, 'negotiating');

    // Re-adding the same id brings the data straight back.
    const readded = addProperty(undefined, database.id, { name: 'Stage', type: 'text', id: stage.value.id }, T + 3);
    assert.ok(readded.ok);
    const projection = readDatabaseView(undefined, database.id)!;
    const cell = projection.rows[0]!.cells.find((c) => c.property.id === stage.value.id);
    assert.equal(cell?.value, 'negotiating');
  } finally { cleanup(dir); }
});

test('the title column cannot be removed, and the last view cannot be removed', () => {
  const dir = home();
  try {
    const database = createDatabase(undefined, { title: 'Books' }, T);
    assert.equal(removeProperty(undefined, database.id, 'title', T).ok, false);
    assert.equal(removeView(undefined, database.id, 'table', T).ok, false);
  } finally { cleanup(dir); }
});

test('a value written for a column that does not exist is refused, not stored', () => {
  const dir = home();
  try {
    const database = createDatabase(undefined, { title: 'Books' }, T);
    const row = addRow(undefined, database.id, { title: 'one' }, T);
    assert.ok(row.ok);
    const written = setRowValue(undefined, row.value.id, 'nonexistent', 'x', T + 1);
    assert.equal(written.ok, false);
  } finally { cleanup(dir); }
});

test('a block that is not a row of a database refuses a cell write', () => {
  const dir = home();
  try {
    const paragraph = createBlock(undefined, { text: 'just a line' }, T);
    const written = setRowValue(undefined, paragraph.id, 'title', 'x', T + 1);
    assert.equal(written.ok, false);
  } finally { cleanup(dir); }
});

test('a property type cannot be changed in place — the values would have to be reinterpreted', () => {
  const dir = home();
  try {
    const database = createDatabase(undefined, { title: 'Books' }, T);
    const rating = addProperty(undefined, database.id, { name: 'Rating', type: 'number' }, T);
    assert.ok(rating.ok);
    const renamed = updateProperty(undefined, database.id, rating.value.id, { name: 'Score' }, T + 1);
    assert.ok(renamed.ok);
    assert.equal(renamed.value.type, 'number', 'the type is not patchable');
    assert.equal(renamed.value.name, 'Score');
  } finally { cleanup(dir); }
});

/* ------------------------------------------------- reachability and defaults */

test('a database created through the slash menu’s kind is seeded, not left column-less', () => {
  const dir = home();
  try {
    // What `notes-create` with kind `database` does — the slash menu's path.
    const block = createBlock(undefined, { kind: 'database', text: 'Inbox' }, T);
    const database = readDatabase(block);
    assert.equal(database.schema.length, 1);
    assert.equal(database.schema[0]!.type, 'title');
    assert.equal(database.views.length, 1);
    assert.equal(database.views[0]!.kind, 'table');
    assert.deepEqual(listDatabases(undefined).map((b) => b.id), [block.id]);
  } finally { cleanup(dir); }
});

/* ---------------------------------------------------- forward compatibility */

test('a notes file written BEFORE this layer reads, and reads as an empty database', () => {
  // The fixture is deliberately in the older shape: a `database`-kinded block
  // with no `schema`, no `views` and no `props` anywhere, which is exactly what
  // a stored file from before E3 contains. `readPlanner` established that a file
  // missing whole sections must read rather than throw; this is the same
  // property one level down.
  const dir = home();
  try {
    const old = {
      schemaVersion: 1,
      deviceId: 'legacy-device',
      clock: { physical: T, logical: 0, deviceId: 'legacy-device' },
      blocks: {
        blk_old: {
          id: 'blk_old',
          parentId: { value: null, at: at(T) },
          rank: { value: 'A1', at: at(T) },
          kind: { value: 'database', at: at(T) },
          text: { value: 'Reading list', at: at(T) },
        },
        blk_row: {
          id: 'blk_row',
          parentId: { value: 'blk_old', at: at(T) },
          rank: { value: 'A1', at: at(T) },
          kind: { value: 'page', at: at(T) },
          text: { value: 'A book', at: at(T) },
        },
      },
      leases: {},
      outbox: { operations: [], shed: 0 },
    };
    writeNotes(undefined, old as unknown as ReturnType<typeof readNotes>);

    const projection = readDatabaseView(undefined, 'blk_old');
    assert.ok(projection, 'it reads');
    assert.equal(projection!.title, 'Reading list');
    assert.equal(projection!.columns.length, 1, 'a title column is supplied');
    assert.equal(projection!.rows.length, 1);
    assert.equal(projection!.rows[0]!.title, 'A book');
    assert.deepEqual(projection!.skipped, []);
  } finally { cleanup(dir); }
});

test('a schema written by a NEWER client keeps its unknown column and reports it', () => {
  // §3 keeps formulas and rollups out of this pass. A column of a type this
  // build cannot compute arrives the same way as one from a future release, and
  // both must be named rather than approximated.
  const block: NoteBlock = {
    id: 'db', parentId: s<string | null>(null), rank: s('A1'), kind: s('database' as const), text: s('Budget'),
    schema: s([
      { id: 'title', name: 'Name', type: 'title' },
      { id: 'total', name: 'Total', type: 'formula' },
    ] as NotePropertyDef[]),
    views: s([{ id: 'table', name: 'Table', kind: 'table' as const, visible: ['title', 'total'] }]),
  };

  const database = readDatabase(block);
  assert.equal(database.schema.length, 2, 'the column is KEPT');
  assert.deepEqual(database.unsupported, ['total']);
  assert.deepEqual(operatorsFor(database.schema[1]!), [], 'and it offers no operators to filter with');
});

test('a database block with a corrupt schema still renders', () => {
  const block: NoteBlock = {
    id: 'db', parentId: s<string | null>(null), rank: s('A1'), kind: s('database' as const), text: s('Broken'),
    schema: s(['nonsense', { name: 'no id' }, null] as unknown as NotePropertyDef[]),
    views: s('not a list' as unknown as never),
  };
  const database = readDatabase(block);
  assert.equal(database.schema.length, 1, 'only the supplied title column survives');
  assert.equal(database.schema[0]!.type, 'title');
  assert.equal(database.views.length, 1);
});

test('a view pointing at a removed column does not render a header with no cells', () => {
  const block: NoteBlock = {
    id: 'db', parentId: s<string | null>(null), rank: s('A1'), kind: s('database' as const), text: s('X'),
    schema: s([{ id: 'title', name: 'Name', type: 'title' }] as NotePropertyDef[]),
    views: s([{ id: 'table', name: 'Table', kind: 'table' as const, visible: ['title', 'gone'] }]),
  };
  assert.deepEqual(readDatabase(block).views[0]!.visible, ['title']);
});

/* ---------------------------------------------------------------- bounds */

test('the database fields of a push are bounded by the function the client uses', () => {
  assert.equal(validateDatabaseFields({}), null);
  assert.ok(validateDatabaseFields({ props: [] }), 'a list is not a keyed map');
  assert.ok(validateDatabaseFields({ props: { a: 'x'.repeat(5000) } }));
  assert.ok(validateDatabaseFields({ schema: 'nope' }));
  assert.equal(validateDatabaseFields({ props: { a: 'x' }, schema: [], views: [] }), null);
});

/* -------------------------------------------------------------- formatting */

test('a select renders its option label, and a relation renders its URI', () => {
  const select = textDef({ id: 's', type: 'select', options: [{ id: 'won', label: 'Closed won' }] });
  assert.equal(formatPropertyValue(select, 'won'), 'Closed won');
  // A3 — a reference is live, so the LABEL belongs to whoever resolves it at the
  // moment of rendering, never to a title baked in at write time.
  const relation = textDef({ id: 'r', type: 'relation' });
  assert.equal(formatPropertyValue(relation, ['brainrouter://planner/item/a']), 'brainrouter://planner/item/a');
});

test('rowPropertyValue reads the page’s text for a title and props for everything else', () => {
  const row: NoteBlock = {
    id: 'r', parentId: s<string | null>('db'), rank: s('A1'), kind: s('page' as const), text: s('Acme'),
    props: { stage: { value: 'won', at: at(100) } },
  };
  assert.equal(rowPropertyValue(row, { id: 'title', name: 'Name', type: 'title' }), 'Acme');
  assert.equal(rowPropertyValue(row, { id: 'stage', name: 'Stage', type: 'text' }), 'won');
  assert.equal(rowPropertyValue(row, { id: 'missing', name: 'M', type: 'text' }), null);
});

test('projectDatabase returns null for a block that is not there, rather than an empty database', () => {
  assert.equal(projectDatabase([], 'nothing'), null);
});

test('a paragraph is not projected as a database with its children as rows', () => {
  const dir = home();
  try {
    const paragraph = createBlock(undefined, { text: 'just a line' }, T);
    createBlock(undefined, { text: 'a child', parentId: paragraph.id }, T);
    assert.equal(readDatabaseView(undefined, paragraph.id), null);
  } finally { cleanup(dir); }
});

test('a deleted row leaves the projection without leaving the trash', () => {
  const dir = home();
  try {
    const database = createDatabase(undefined, { title: 'X' }, T);
    const row = addRow(undefined, database.id, { title: 'one' }, T);
    assert.ok(row.ok);
    deleteBlock(undefined, row.value.id, T + 1);
    assert.equal(readDatabaseView(undefined, database.id)!.rows.length, 0);
    assert.equal(listTrash(undefined).length, 1);
  } finally { cleanup(dir); }
});
