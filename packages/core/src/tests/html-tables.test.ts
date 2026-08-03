/**
 * ADR-027 D10 (P7-2) — tables survive conversion, or say they did not.
 *
 * The property under test is refusal. Every assertion here is about NOT
 * producing a plausible-looking table that has moved values under the wrong
 * headers — because a reader cannot tell a wrong table from a right one, and
 * the agent will cite it either way.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tableToMarkdown,
  escapeCell,
  absolutizeUrl,
  unconvertibleTableNote,
  type ParsedTable,
  type TableCell,
} from '../research/htmlTables.js';

const cell = (text: string, colSpan = 1, rowSpan = 1): TableCell => ({ text, colSpan, rowSpan });
const row = (...texts: string[]): TableCell[] => texts.map((t) => cell(t));

test('a rectangular table converts with its header intact', () => {
  const table: ParsedTable = {
    head: row('Param', 'Type', 'Default'),
    rows: [row('timeout', 'number', '30'), row('retries', 'number', '3')],
  };
  const out = tableToMarkdown(table);
  assert.ok(out.ok);
  assert.equal(out.markdown, [
    '| Param | Type | Default |',
    '| --- | --- | --- |',
    '| timeout | number | 30 |',
    '| retries | number | 3 |',
  ].join('\n'));
});

test('a merged cell is REFUSED rather than flattened', () => {
  // Markdown has no spanning cell. Dropping the span would shift every value
  // after it under the wrong header, and the result would read perfectly.
  const table: ParsedTable = {
    head: row('Region', 'Price'),
    rows: [[cell('EU', 2), cell('€10')]],
  };
  const out = tableToMarkdown(table);
  assert.equal(out.ok, false);
  assert.match((out as { reason: string }).reason, /merged cells/);
});

test('a ragged table is REFUSED rather than padded', () => {
  // Padding invents cells that are not in the source.
  const table: ParsedTable = { head: row('A', 'B', 'C'), rows: [row('1', '2')] };
  const out = tableToMarkdown(table);
  assert.equal(out.ok, false);
  assert.match((out as { reason: string }).reason, /ragged/);
});

test('a pipe in a cell cannot forge a column', () => {
  // The attack and the accident are the same shape: one stray `|` silently
  // shifts every later value one column left.
  const table: ParsedTable = {
    head: row('Name', 'Pattern'),
    rows: [row('alt', 'a|b')],
  };
  const out = tableToMarkdown(table);
  assert.ok(out.ok);
  assert.match(out.markdown, /a\\\|b/);
  // The row still has exactly the header's column count.
  const dataRow = out.markdown.split('\n')[2]!;
  assert.equal(dataRow.split(/(?<!\\)\|/).length - 2, 2);
});

test('a newline in a cell cannot end the row early', () => {
  assert.equal(escapeCell('one\ntwo'), 'one two');
  assert.equal(escapeCell('  spaced   out  '), 'spaced out');
});

test('a table with no rows or no columns is refused', () => {
  assert.equal(tableToMarkdown({ head: null, rows: [] }).ok, false);
  assert.equal(tableToMarkdown({ head: [], rows: [[]] }).ok, false);
});

test('a headerless table gets synthetic headers, not a missing header row', () => {
  // A markdown table without a header row does not render as a table at all.
  const out = tableToMarkdown({ head: null, rows: [row('a', 'b'), row('c', 'd')] });
  assert.ok(out.ok);
  assert.match(out.markdown, /Column 1 \| Column 2/);
});

test('relative URLs absolutize against the page', () => {
  // An artifact read weeks later cannot resolve `/docs/x` on its own.
  assert.equal(absolutizeUrl('/docs/x', 'https://e.com/a/b'), 'https://e.com/docs/x');
  assert.equal(absolutizeUrl('y', 'https://e.com/a/b'), 'https://e.com/a/y');
  assert.equal(absolutizeUrl('https://other.com/z', 'https://e.com/a'), 'https://other.com/z');
});

test('an unresolvable URL is returned unchanged rather than guessed at', () => {
  assert.equal(absolutizeUrl('not a url', 'also not a url'), 'not a url');
});

test('an omitted table leaves a visible note, not silence', () => {
  // Silence reads as "there was nothing here", which is a different and worse
  // claim than "there was something we could not render".
  const note = unconvertibleTableNote('it uses merged cells', 'https://e.com/spec');
  assert.match(note, /Table omitted/);
  assert.match(note, /merged cells/);
  assert.match(note, /https:\/\/e\.com\/spec/);
});
