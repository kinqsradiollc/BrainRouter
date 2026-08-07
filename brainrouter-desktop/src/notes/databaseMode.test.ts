/**
 * ADR-029 E3 — the database views, and the claim that a person can reach them.
 *
 * ADR-028 E1's standard: a module that compiles, is tested and has no caller is
 * not done. Every assertion here names the gesture that reaches something, and
 * each has failed silently in this repository before:
 *
 *   - a handler served and never called (the slash menu and the input rules
 *     shipped that way for a release),
 *   - a block kind with no renderer (a `/database` that made a correct, syncing
 *     block the page then drew as a blank line),
 *   - a container whose children are rendered twice, once by it and once by the
 *     page above it,
 *   - a shell that fills half the window because a flex child has no `flex: 1`.
 *
 * The view-model behaviour is tested in `lib/notes/database.test.ts`; this file
 * is the wiring, asserted at the source because the components are hook-heavy
 * and cannot be rendered outside React here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  blocksOnPage, buildPageTree, containerParents, isContainerKind, pageBreadcrumbs,
  selectedPageOrTop,
} from '../lib/notes/pageTree.js';
import { pageHeaderView } from '../lib/notes/pageHeader.js';
import type { NoteBlockView } from '../lib/notes/notesView.js';

const source = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');

function block(over: Partial<NoteBlockView> & { id: string }): NoteBlockView {
  return {
    parentId: null, depth: 0, kind: 'paragraph', text: '', checked: false, level: null,
    hasChildren: false, refs: [], conflicts: [], lockedBy: null, title: null,
    icon: null, cover: null, favourite: false, ...over,
  };
}

/** A page holding a database, whose two rows each hold a paragraph. */
const TREE: NoteBlockView[] = [
  block({ id: 'page', kind: 'page', text: 'Notes', title: 'Notes' }),
  block({ id: 'para', parentId: 'page', depth: 1, text: 'A line above the table.' }),
  block({ id: 'db', parentId: 'page', depth: 1, kind: 'database', text: 'Reading list', title: 'Reading list' }),
  block({ id: 'row1', parentId: 'db', depth: 2, kind: 'page', text: 'HLCs', title: 'HLCs' }),
  block({ id: 'row2', parentId: 'db', depth: 2, kind: 'page', text: 'Parsing', title: 'Parsing' }),
  block({ id: 'row1body', parentId: 'row1', depth: 3, text: 'A row is a page, so this lives on it.' }),
];

/* ------------------------------------------------------------ reachability */

test('a `/database` gesture reaches the database creator, not a bare block with a kind', () => {
  const mode = source('./NotesMode.tsx');
  // `notes-create` with kind `database` makes a block with no schema and no
  // views. Core repairs it on read, but the person sees a database with no
  // columns, which reads as one that failed to load.
  assert.match(mode, /plan\.kind === 'database'/, 'the slash command falls through to a plain block');
  assert.match(mode, /ops\.addDatabase\(/, 'nothing calls the database creator');
  assert.match(
    source('./NotesModeContainer.tsx'),
    /addDatabase[\s\S]{0,300}'notes-database-create'/,
    'addDatabase does not reach notes-database-create',
  );
});

test('a database block RENDERS — the kind having a store is not the kind having a surface', () => {
  const mode = source('./NotesMode.tsx');
  assert.match(mode, /block\.kind === 'database' \?/, 'a database block falls through to the text editor');
  assert.match(mode, /<DatabaseBlock/, 'nothing renders a database');
  // E3's full-page half. Without it the only way to see a database is the page
  // it happens to be embedded in.
  assert.match(mode, /fullPageDatabase/, 'a database cannot be opened as a page');
});

test('every view kind has a renderer, so the switcher cannot offer a blank one', () => {
  const view = source('./DatabaseBlock.tsx');
  for (const [kind, component] of [
    ['board', 'BoardView'], ['list', 'ListView'], ['calendar', 'CalendarView'],
    ['gallery', 'GalleryView'], ['table', 'TableView'],
  ] as const) {
    assert.match(view, new RegExp(`function ${component}\\(`), `no renderer for the ${kind} view`);
  }
  assert.match(view, /case 'board': return <BoardView/, 'the switch does not reach the board');
  assert.match(view, /case 'calendar': return <CalendarView/, 'the switch does not reach the calendar');
});

test('adding a row creates a page AND opens it — E3 refuses a record beside one', () => {
  const view = source('./DatabaseBlock.tsx');
  assert.match(
    view,
    /ops\.addRow\(\)\.then\(\(id\) => \{ if \(id\) ops\.openRow\(id\); \}\)/,
    'a new row is created and never opened, so its page is unreachable',
  );
  assert.match(
    source('./databaseOps.ts'),
    /openRow: \(rowId\) => host\.openPage\(rowId\)/,
    'opening a row is not the ordinary page navigation',
  );
  // The row's id has to come back from the host, or nothing can open it.
  assert.match(
    source('./NotesModeContainer.tsx'),
    /'notes-database-add-row'[\s\S]{0,400}return created\?\.id/,
    'the created row id is discarded',
  );
});

test('every filter, sort and group control writes a SAVED VIEW rather than filtering locally', () => {
  const controls = source('./DatabaseControls.tsx');
  for (const [control, field] of [
    ['FilterControl', 'filter'], ['SortControl', 'sort'], ['GroupControl', 'groupBy'],
  ] as const) {
    assert.match(controls, new RegExp(`function ${control}\\(`), `no ${control}`);
    assert.match(controls, new RegExp(`${field}:`), `${control} writes nothing`);
  }
  assert.match(controls, /ops\.saveView\(/, 'the controls never save');
  // The one thing that must NOT be here: a second predicate. Core evaluates the
  // rules and answers with the rows; a renderer that also filtered would hide a
  // different set for the same saved view.
  assert.doesNotMatch(source('./DatabaseBlock.tsx'), /\.filter\(\(row\)/, 'the renderer filters rows itself');
});

test('E3: the column types, the column ORDER and the database list all reach a gesture', () => {
  // ADR-028 E1: the host served these three and nothing in the renderer called
  // any of them. A handler with no caller is a feature that exists in the
  // process and not in the app.
  const controls = source('./DatabaseControls.tsx');
  const container = source('./NotesModeContainer.tsx');

  // The "New column" picker offers core's types, not a list in this file. Nine
  // strings here is the same defect as a hand-built operator list one level up:
  // a build that learns a tenth type would never show it.
  assert.match(controls, /ops\.propertyCatalog;/, 'the type picker is a list in the renderer');
  assert.match(controls, /readCatalog\(\)\.then/, 'the catalog is never read');
  assert.match(container, /'notes-property-catalog'/, 'the catalog is never asked for');
  assert.doesNotMatch(controls, /NEW_PROPERTY_TYPES/, 'the hardcoded type list is back');

  // Reordering a column is a gesture, and it writes BOTH orders — the schema
  // every view starts from and the `visible` this table renders.
  assert.match(controls, /ops\.reorderProperties\(swapped\)/, 'no column can be moved');
  assert.match(container, /'notes-database-reorder-properties'/, 'the reorder reaches no handler');
  assert.match(controls, /aria-label=\{`Move \$\{property\.name\} earlier`\}/, 'the move has no control');

  // E5 — `@` can name a database. Its title is core's decoded one, so it comes
  // from the handler rather than from the block's own text.
  assert.match(container, /'notes-database-list'/, 'the databases are never listed');
  assert.match(container, /databases: \(databases\?\.databases \?\? \[\]\)/, 'the list reaches no picker');
});

test('the cell editors are wired per property type, and a relation writes a real URI', () => {
  const cell = source('./DatabaseCell.tsx');
  assert.match(cell, /editor === 'checkbox'/, 'a checkbox does not toggle');
  assert.match(cell, /editor === 'date'/, 'a date has no picker');
  assert.match(cell, /editor === 'select' \|\| editor === 'multi-select'/, 'a select shows no options');
  assert.match(cell, /function RelationValue/, 'a relation has no picker');
  // E5 — the same candidate list the `@` menu uses, so a row can cite a planner
  // item or a meeting. A picker that wrote a title instead of a URI would break
  // the moment the target was renamed.
  assert.match(cell, /onWrite\(toggleMultiValue\(value, candidate\.uri\)\)/, 'the picker stores something other than a URI');
  assert.match(
    source('./NotesModeContainer.tsx'),
    /searchRefs: async \(query\) => mentionCandidates\(/,
    'the relation picker has no candidates',
  );
});

test('a database block sizes to the page instead of widening it', () => {
  const css = source('../theme.css');
  // `.notes-body` is a reading column. A table that forced it wider would make
  // every paragraph on the page scroll sideways with the table.
  const rule = /\.db-block \{([^}]*)\}/.exec(css);
  assert.ok(rule, 'no rule for .db-block');
  assert.match(rule![1]!, /min-width: 0/, '.db-block must be able to shrink below its content');
  assert.match(css, /\.db-table-scroll \{[^}]*overflow-x: auto/, 'a wide table has nowhere to scroll');
  assert.match(css, /\.db-board \{[^}]*overflow-x: auto/, 'a board with many columns has nowhere to scroll');
});

/* -------------------------------------------------------------- behaviour */

test('a database owns its rows, so the page above it does not render them twice', () => {
  assert.equal(isContainerKind('database'), true);
  assert.equal(isContainerKind('page'), true);
  assert.equal(isContainerKind('toggle'), false);

  const parents = containerParents(TREE);
  assert.equal(parents.get('row1'), 'db', 'a row belongs to the database, not to the page above it');
  assert.equal(parents.get('db'), 'page');

  // The page's body has the paragraph and the database — and NOT the rows,
  // which would otherwise appear as sub-page rows beside the table listing the
  // same rows.
  assert.deepEqual(blocksOnPage(TREE, 'page').map((b) => b.id), ['para', 'db']);
  // The database's own children are its rows, which it renders itself.
  assert.deepEqual(blocksOnPage(TREE, 'db').map((b) => b.id), ['row1', 'row2']);
  // And a row is a page with a body, which is what "a row IS a page" means.
  assert.deepEqual(blocksOnPage(TREE, 'row1').map((b) => b.id), ['row1body']);
});

test('a database is a place the shell can be, and a row knows its way back to it', () => {
  // Without this the full-page database falls back to the top level and the
  // button that opens it looks like it does nothing.
  assert.equal(selectedPageOrTop(TREE, 'db'), 'db');
  assert.equal(selectedPageOrTop(TREE, 'row1'), 'row1');
  assert.equal(selectedPageOrTop(TREE, 'para'), null, 'a paragraph is not a destination');

  assert.deepEqual(
    pageBreadcrumbs(TREE, 'row1').map((crumb) => crumb.title),
    ['Notes', 'Reading list', 'HLCs'],
    'a row opened from a table has no route back to the database that owns it',
  );
});

test('a full-page database keeps its title and drops the control that would make a stray row', () => {
  const header = pageHeaderView(TREE, 'db');
  assert.equal(header.title, 'Reading list', 'the database has no name on its own page');
  assert.equal(header.editable, true, 'a database cannot be renamed');
  // "New page inside" under a database would create a row outside the
  // database's own control, so it would never open and would read as a blank
  // line someone has to go and delete.
  assert.equal(header.database, true);
  assert.equal(pageHeaderView(TREE, 'page').database, false);
  assert.equal(pageHeaderView(TREE, null).database, false);
});

test('the sidebar lists the database and nests its rows under it, not under the page', () => {
  const roots = buildPageTree(TREE);
  assert.deepEqual(roots.map((node) => node.id), ['page']);
  const children = roots[0]!.children;
  assert.deepEqual(children.map((node) => node.id), ['db']);
  assert.equal(children[0]!.database, true, 'the database is not marked, so its row looks like a page');
  assert.deepEqual(children[0]!.children.map((node) => node.id), ['row1', 'row2']);
  // A row is still a page in the tree, so its own sub-pages keep working.
  assert.equal(children[0]!.children[0]!.database, false);
});
