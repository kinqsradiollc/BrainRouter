/**
 * ADR-029 E1/E4 — the slash menu's catalog.
 *
 * The properties that matter are about ORDER and COVERAGE, not about the labels:
 * every kind E4 lists has to be reachable from `/`, and typing a prefix has to
 * put the obvious answer first. Muscle memory lives in the order, so a menu that
 * ranks unpredictably fails E1's test while satisfying E4's table.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  searchSlashCatalog, slashCatalogByGroup, slashCommand, slashCommandInput, SLASH_CATALOG,
} from '../notes/slashCatalog.js';
import { applyInputRule } from '../notes/inputRules.js';
import { NOTE_BLOCK_KINDS } from '../notes/block.js';

test('every block kind E4 names is reachable from the slash menu', () => {
  // "The model supports it" is not built (§5). A kind with no way in is a kind
  // nobody uses.
  const offered = new Set(SLASH_CATALOG.map((entry) => entry.kind));
  for (const kind of ['heading', 'paragraph', 'bullet', 'numbered', 'todo', 'toggle',
    'quote', 'callout', 'code', 'divider', 'image', 'bookmark', 'table', 'page', 'embed'] as const) {
    assert.ok(offered.has(kind), `${kind} has no slash command`);
  }
});

test('every command names a real block kind', () => {
  for (const entry of SLASH_CATALOG) {
    assert.ok(NOTE_BLOCK_KINDS.includes(entry.kind), `${entry.id} → ${entry.kind}`);
  }
});

test('ids are unique, because a caller resolves a picked command by id', () => {
  const ids = SLASH_CATALOG.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('an empty query is the menu opening, not a search with no results', () => {
  assert.equal(searchSlashCatalog('').length, SLASH_CATALOG.length);
  assert.equal(searchSlashCatalog('   ')[0]!.id, SLASH_CATALOG[0]!.id, 'authored order is preserved');
});

test('an exact prefix wins over a substring anywhere', () => {
  assert.equal(searchSlashCatalog('head')[0]!.id, 'heading-1');
  assert.equal(searchSlashCatalog('num')[0]!.id, 'numbered');
  assert.equal(searchSlashCatalog('quo')[0]!.id, 'quote');
});

test('an alias finds a command whose label does not contain the word', () => {
  assert.equal(searchSlashCatalog('h2')[0]!.id, 'heading-2');
  assert.equal(searchSlashCatalog('checkbox')[0]!.id, 'todo');
  assert.equal(searchSlashCatalog('hr')[0]!.id, 'divider');
});

test('a query nothing matches returns nothing rather than everything', () => {
  assert.deepEqual(searchSlashCatalog('zzzz'), []);
});

test('a limit truncates the ranking rather than the catalog', () => {
  const top = searchSlashCatalog('list', 2);
  assert.equal(top.length, 2);
  assert.deepEqual(top.map((e) => e.id), searchSlashCatalog('list').slice(0, 2).map((e) => e.id));
});

test('the markers the menu advertises are markers that actually fire', () => {
  // A menu that shows a shortcut the rules do not implement teaches a keystroke
  // that does nothing.
  for (const entry of SLASH_CATALOG) {
    if (!entry.marker) continue;
    const hit = applyInputRule({ kind: 'paragraph', text: entry.marker, caret: entry.marker.length });
    assert.ok(hit, `${entry.id} advertises ${JSON.stringify(entry.marker)} but no rule fires`);
    assert.equal(hit.kind, entry.kind, entry.id);
    if (entry.level !== undefined) assert.equal(hit.level, entry.level, entry.id);
  }
});

test('grouping covers the whole catalog, so nothing is offered only by search', () => {
  const grouped = slashCatalogByGroup().flatMap((bucket) => bucket.commands.map((c) => c.id));
  assert.equal(grouped.length, SLASH_CATALOG.length);
  assert.equal(new Set(grouped).size, SLASH_CATALOG.length);
});

test('a picked command produces store INPUT, not a block', () => {
  // The store still mints the id, stamps the clock and queues the outbox entry.
  assert.deepEqual(slashCommandInput(slashCommand('heading-2')!), { kind: 'heading', level: 2 });
  assert.deepEqual(slashCommandInput(slashCommand('bullet')!), { kind: 'bullet' });
  assert.equal(slashCommand('no-such-thing'), null);
});
