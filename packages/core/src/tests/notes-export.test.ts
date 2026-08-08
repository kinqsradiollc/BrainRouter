/**
 * ADR-029 F3 — "can I leave", tested as the file a person actually gets.
 *
 * Three properties, and none of them is "the writer runs":
 *
 *  - **The Markdown is the page.** Every kind the slash menu offers comes out as
 *    that kind, and a synced block comes out as the WORDS it shows rather than
 *    as an address — a file showing `brainrouter://…` where a paragraph is would
 *    not be the page somebody exported.
 *  - **The CSV is safe in the two readers it has.** RFC 4180 for the parser, and
 *    the leading-character guard for the spreadsheet: a cell beginning `=` is a
 *    formula to Excel, Numbers and Sheets, and the value arrived over sync from
 *    another device.
 *  - **What the file cannot carry is IN the file.** An export that silently
 *    dropped a picture would look complete, which is worse than one that is
 *    visibly partial.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  csvField, exportDatabaseCsv, exportFormatsFor, exportNote, exportPageMarkdown,
} from '../notes/export/index.js';
import { walkSubtree } from '../notes/export/walk.js';
import type { NoteBlock } from '../notes/block.js';
import type { NotePropertyDef } from '../notes/properties.js';

const AT = { physical: 1_700_000_000_000, logical: 0, deviceId: 'dev-a' };
const S = <T>(value: T): { value: T; at: typeof AT } => ({ value, at: AT });

interface Seed {
  id: string;
  parent?: string | null;
  rank?: string;
  kind?: string;
  text?: string;
  level?: number;
  checked?: boolean;
  icon?: string;
  schema?: NotePropertyDef[];
  props?: Record<string, unknown>;
}

function block(seed: Seed): NoteBlock {
  return {
    id: seed.id,
    parentId: S(seed.parent ?? null),
    rank: S(seed.rank ?? seed.id),
    kind: S((seed.kind ?? 'paragraph') as NoteBlock['kind']['value']),
    text: S(seed.text ?? ''),
    createdAt: AT,
    ...(seed.level === undefined ? {} : { level: S(seed.level) }),
    ...(seed.checked === undefined ? {} : { checked: S(seed.checked) }),
    ...(seed.icon === undefined ? {} : { icon: S(seed.icon) }),
    ...(seed.schema === undefined ? {} : { schema: S(seed.schema) }),
    ...(seed.props === undefined
      ? {}
      : { props: Object.fromEntries(Object.entries(seed.props).map(([k, v]) => [k, S(v)])) as NoteBlock['props'] }),
  } as NoteBlock;
}

test('F3 — every kind the menu offers comes out of Markdown as that kind', () => {
  const blocks = [
    block({ id: 'page', kind: 'page', text: 'Release plan', level: 1 }),
    block({ id: 'b1', parent: 'page', rank: 'a', kind: 'heading', text: 'Before we ship', level: 2 }),
    block({ id: 'b2', parent: 'page', rank: 'b', kind: 'bullet', text: 'one thing' }),
    block({ id: 'b3', parent: 'page', rank: 'c', kind: 'numbered', text: 'first' }),
    block({ id: 'b4', parent: 'page', rank: 'd', kind: 'numbered', text: 'second' }),
    block({ id: 'b5', parent: 'page', rank: 'e', kind: 'todo', text: 'done thing', checked: true }),
    block({ id: 'b6', parent: 'page', rank: 'f', kind: 'todo', text: 'open thing' }),
    block({ id: 'b7', parent: 'page', rank: 'g', kind: 'quote', text: 'as somebody said' }),
    block({ id: 'b8', parent: 'page', rank: 'h', kind: 'callout', text: 'do not skim this', icon: '⚠️' }),
    block({ id: 'b9', parent: 'page', rank: 'i', kind: 'code', text: 'const a = 1;' }),
    block({ id: 'b10', parent: 'page', rank: 'j', kind: 'divider' }),
    block({ id: 'b11', parent: 'page', rank: 'k', kind: 'toggle', text: 'the details' }),
    block({ id: 'b12', parent: 'b11', rank: 'a', text: 'nested under the toggle' }),
    block({ id: 'b13', parent: 'page', rank: 'l', kind: 'image', text: 'brainrouter://attachment/att_1' }),
    block({ id: 'b14', parent: 'page', rank: 'm', kind: 'bookmark', text: 'https://example.com/x' }),
    block({ id: 'b15', parent: 'page', rank: 'n', kind: 'embed', text: 'brainrouter://planner/item/itm_1' }),
  ];

  const out = exportPageMarkdown(blocks, 'page');
  assert.ok(out);
  const text = out!.content;

  assert.match(text, /^# Release plan/m);
  assert.match(text, /^## Before we ship/m);
  assert.match(text, /^- one thing/m);
  assert.match(text, /^1\. first/m);
  assert.match(text, /^2\. second/m);
  assert.match(text, /^- \[x\] done thing/m);
  assert.match(text, /^- \[ \] open thing/m);
  assert.match(text, /^> as somebody said/m);
  assert.match(text, /^> ⚠️ do not skim this/m);
  assert.match(text, /```\nconst a = 1;\n```/);
  assert.match(text, /^---$/m);
  assert.match(text, /^- the details/m);
  assert.match(text, /^ {2}nested under the toggle/m);
  assert.match(text, /!\[\]\(brainrouter:\/\/attachment\/att_1\)/);
  assert.match(text, /<https:\/\/example\.com\/x>/);

  // The two things the file cannot carry, named IN the file rather than dropped.
  assert.match(text, /What this file does not carry/);
  assert.match(text, /Pictures are linked by their address/);
  assert.match(text, /An embed shows another part of the workspace live/);
  assert.equal(out!.filename, 'Release-plan.md');
  assert.equal(out!.contentType, 'text/markdown; charset=utf-8');
});

test('F3 — a code block whose text contains a fence cannot break out of it', () => {
  const blocks = [
    block({ id: 'p', kind: 'page', text: 'Doc' }),
    block({ id: 'c', parent: 'p', kind: 'code', text: '```\nnot the end\n```' }),
  ];
  const out = exportPageMarkdown(blocks, 'p')!;
  // A four-backtick fence, because the content holds a three-backtick one. A
  // shorter fence would end the block on the line the person wrote inside it.
  assert.match(out.content, /````\n```\nnot the end\n```\n````/);
});

test('F3 — a synced block exports the WORDS it shows, not its address', () => {
  const blocks = [
    block({ id: 'p', kind: 'page', text: 'Runbook' }),
    block({ id: 'mirror', parent: 'p', rank: 'a', kind: 'synced', text: 'brainrouter://notes/block/src' }),
    block({ id: 'other', kind: 'page', rank: 'z', text: 'Shared' }),
    block({ id: 'src', parent: 'other', rank: 'a', text: 'how we deploy' }),
    block({ id: 'srckid', parent: 'src', rank: 'a', kind: 'bullet', text: 'step one' }),
  ];
  const out = exportPageMarkdown(blocks, 'p')!;
  assert.match(out.content, /how we deploy/);
  assert.match(out.content, /- step one/);
  assert.doesNotMatch(out.content, /brainrouter:\/\/notes\/block\/src/);
});

test('F3 — a mirror of an ancestor exports its sentence rather than looping', () => {
  // The cycle case. `readSyncedBlock` names it; the export must render the
  // sentence and terminate rather than expand forever.
  const blocks = [
    block({ id: 'p', kind: 'page', text: 'Loop' }),
    block({ id: 'mirror', parent: 'p', rank: 'a', kind: 'synced', text: 'brainrouter://notes/block/p' }),
  ];
  const out = exportPageMarkdown(blocks, 'p')!;
  assert.match(out.content, /would render inside itself/);
});

test('F3 — a table exports as a grid with every pipe escaped', () => {
  const blocks = [
    block({ id: 'p', kind: 'page', text: 'Doc' }),
    block({ id: 't', parent: 'p', rank: 'a', kind: 'table', text: '', checked: true }),
    block({ id: 'r1', parent: 't', rank: 'a', kind: 'table-row', text: 'Name|Owner' }),
    block({ id: 'r2', parent: 't', rank: 'b', kind: 'table-row', text: 'a \\| b|somebody' }),
  ];
  const out = exportPageMarkdown(blocks, 'p')!;
  assert.match(out.content, /\| Name \| Owner \|/);
  assert.match(out.content, /\| --- \| --- \|/);
  // The cell's own pipe stays inside its cell rather than opening a third column.
  assert.match(out.content, /\| a \\\| b \| somebody \|/);
  // Exactly once. The walk visits the table's rows too, so without the table
  // claiming them every grid was followed by the same rows again as loose
  // pipe-joined lines — a file that says the table twice.
  assert.equal(out.content.split('somebody').length - 1, 1, 'the table’s rows were written twice');
  assert.equal(out.content.split('Owner').length - 1, 1);
});

test('F3 — the walk and the writer agree about the bound, and the file says it stopped', () => {
  const blocks = [block({ id: 'p', kind: 'page', text: 'Long' })];
  for (let at = 0; at < 40; at += 1) {
    blocks.push(block({ id: `b${at}`, parent: 'p', rank: `r${String(at).padStart(3, '0')}`, text: `line ${at}` }));
  }
  const walked = walkSubtree(blocks, 'p', 10);
  assert.equal(walked.rows.length, 10);
  assert.equal(walked.truncated, true);
  assert.equal(walked.total, 41);

  const out = exportPageMarkdown(blocks, 'p', { maxBlocks: 10 })!;
  assert.equal(out.truncated, true);
  assert.match(out.content, /longer than an export carries/);
});

/* ------------------------------------------------------------------- CSV */

test('F3 — a CSV field is escaped for the parser AND for the spreadsheet', () => {
  // RFC 4180: quotes doubled, the field wrapped.
  assert.equal(csvField('plain'), '"plain"');
  assert.equal(csvField('a,b'), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField('two\nlines'), '"two\nlines"');

  // The leading-character guard. A correctly quoted field is STILL a formula to
  // Excel, Numbers and Sheets, so quoting alone is not the answer.
  for (const hostile of [
    '=cmd|\'/c calc\'!A1',
    '+1+1',
    '-2+3+cmd|\' /C calc\'!A0',
    '@SUM(1+1)*cmd|\'/C calc\'!A0',
    '\t=1+1',
    '\r=1+1',
  ]) {
    const written = csvField(hostile);
    assert.equal(written.startsWith('"\''), true, `${JSON.stringify(hostile)} was not disarmed`);
    // Disarmed INSIDE the quotes, where the spreadsheet reads it — outside, the
    // parser would treat the apostrophe as stray text before the field.
    assert.equal(written.endsWith('"'), true);
  }
  // And an ordinary value is not disfigured by the guard.
  assert.equal(csvField('2026-08-07'), '"2026-08-07"');
  assert.equal(csvField('42'), '"42"');
});

test('F3 — a database exports its VIEW, with the computed columns as they read', () => {
  const schema: NotePropertyDef[] = [
    { id: 'title', name: 'Name', type: 'title' },
    { id: 'cost', name: 'Cost', type: 'number' },
    { id: 'qty', name: 'Quantity', type: 'number' },
    { id: 'total', name: 'Total', type: 'formula', formula: 'Cost * Quantity' },
    { id: 'broken', name: 'Broken', type: 'formula', formula: 'prop("Nope") + 1' },
  ];
  const blocks = [
    block({
      id: 'db', kind: 'database', text: 'Orders', schema,
    }),
    block({ id: 'r1', parent: 'db', rank: 'a', text: 'Widget', props: { title: 'Widget', cost: 10, qty: 3 } }),
    block({ id: 'r2', parent: 'db', rank: 'b', text: '=DANGER()', props: { title: '=DANGER()', cost: 2, qty: 2 } }),
  ];

  const out = exportDatabaseCsv(blocks, 'db')!;
  assert.equal(out.contentType, 'text/csv; charset=utf-8');
  const lines = out.content.split('\r\n');
  assert.equal(lines[0], '"Title","Name","Cost","Quantity","Total","Broken"');
  assert.match(lines[1]!, /"Widget","Widget","10","3","30"/);
  // The formula's RESULT, worked out — and the broken column's sentence rather
  // than a blank, which is F2's rule carried into the file.
  assert.match(lines[1]!, /There is no property called/);
  // The row whose title is a formula is disarmed.
  assert.match(lines[2]!, /^"'=DANGER\(\)"/);
  assert.match(out.omissions.map((o) => o.detail).join(' '), /could not be worked out/);
});

test('F3 — a page is not offered CSV, and asking for it is refused', () => {
  const blocks = [
    block({ id: 'p', kind: 'page', text: 'Notes' }),
    block({ id: 'db', kind: 'database', text: 'Orders', schema: [{ id: 'title', name: 'Name', type: 'title' }] }),
  ];
  assert.deepEqual(exportFormatsFor(blocks[0]), ['markdown']);
  assert.deepEqual(exportFormatsFor(blocks[1]), ['markdown', 'csv']);
  assert.deepEqual(exportFormatsFor(undefined), []);
  // F1's rule, at the door: a page asked for as CSV is refused rather than
  // written as a one-column table nobody would recognise.
  assert.equal(exportNote(blocks, 'p', 'csv'), null);
  assert.ok(exportNote(blocks, 'p', 'markdown'));
  assert.ok(exportNote(blocks, 'db', 'csv'));
});

test('F3 — the writers stay linear on a 100k adversarial document', () => {
  const hostile = '`'.repeat(100_000);
  const blocks = [
    block({ id: 'p', kind: 'page', text: hostile }),
    block({ id: 'c', parent: 'p', rank: 'a', kind: 'code', text: hostile }),
    block({ id: 'q', parent: 'p', rank: 'b', text: `${'\n'.repeat(50_000)}${'|'.repeat(50_000)}` }),
    block({ id: 'w', parent: 'p', rank: 'c', kind: 'callout', text: ' '.repeat(100_000) }),
  ];
  const started = performance.now();
  const out = exportPageMarkdown(blocks, 'p');
  const markdownMs = performance.now() - started;
  assert.ok(out);
  assert.ok(markdownMs < 2_000, `markdown export took ${markdownMs.toFixed(1)}ms on 100k input`);

  const csvStarted = performance.now();
  for (const payload of ['='.repeat(100_000), '"'.repeat(100_000), ',\n'.repeat(50_000)]) {
    assert.ok(csvField(payload).length > 0);
  }
  const csvMs = performance.now() - csvStarted;
  assert.ok(csvMs < 500, `csv escaping took ${csvMs.toFixed(1)}ms on 100k input`);
});
