/**
 * ADR-030 D5 on the desktop — reachability, asserted the way ADR-029 asserts it.
 *
 * Four things have to be true before a person can read a parsed document, and
 * three of them fail silently:
 *
 *   - the ELECTRON host answers for the queries, or the app shows nothing;
 *   - the DEV BRIDGE answers for the same names, or the browser harness renders
 *     "unknown query" while the app works — an unknown query is rejected by
 *     NAME, which is the trap ADR-029's own parity test exists to catch;
 *   - something in the renderer actually CALLS them (ADR-028 E1: a handler with
 *     no caller is not done, and it is invisible in every test that only checks
 *     the handler);
 *   - the reader stays OUT of the initial bundle, or Q2's own argument — 4.6 MB
 *     of parser against a 1,750,000-byte budget — is undone one layer up by the
 *     UI that reads its output.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');

const DOCUMENT_QUERIES = [
  'attachment-document',
  'attachment-document-part',
  // ADR-030 D5's second landing place. The bullet said a document becomes "a
  // note — a page of blocks, addressable at brainrouter://notes/block/…", and
  // nothing built it: no importer, no handler, no gesture, and no line anywhere
  // admitting the omission.
  'notes-import-document',
] as const;

test('both handler maps answer for a parsed document', () => {
  const host = source('../../../electron/host/queries.ts');
  const dev = source('../../devBridge/queries.ts');
  for (const name of DOCUMENT_QUERIES) {
    assert.match(host, new RegExp(`'${name}'`), `the electron host has no ${name} handler`);
    assert.match(dev, new RegExp(`'${name}'`), `the dev bridge has no ${name} handler`);
  }
});

test('the renderer calls both — a handler nothing asks for is not shipped', () => {
  const reader = source('./DocumentReader.tsx');
  for (const name of DOCUMENT_QUERIES) {
    assert.match(reader, new RegExp(`name: '${name}'`), `nothing in the renderer sends ${name}`);
  }
  const panel = source('./AttachmentsPanel.tsx');
  assert.match(panel, /<DocumentReader/, 'the reader is never mounted');
  assert.match(panel, /rec\.kind === 'pdf'/, 'the reader is mounted for attachments that have no document');
});

test('Q2: the reader is loaded on demand, never in the initial bundle', () => {
  const panel = source('./AttachmentsPanel.tsx');
  assert.match(
    panel,
    /lazy\(\(\) => import\('\.\/DocumentReader\.js'\)/,
    'the reader is statically imported, so every window pays for it before it draws',
  );
  assert.match(panel, /<Suspense/, 'a lazy component with no boundary throws on first render');
});

test('D5: importing the document is a gesture, and what it produced is said', () => {
  const reader = source('./DocumentReader.tsx');
  assert.match(reader, /Import as note/, 'nothing offers the import');
  assert.match(reader, /name: 'notes-import-document'/, 'the button sends nothing');
  // The outcome reaches the person either way. A button that silently succeeds
  // and one that silently fails look identical, which is the whole problem.
  assert.match(reader, /result\.summary/, 'the page it made is never reported');
  assert.match(reader, /result\?\.reason/, 'a refusal is swallowed');
});

test('D3 reaches the person: the panel shows what could not be read', () => {
  const panel = source('./AttachmentsPanel.tsx');
  assert.match(panel, /rec\.extractionNotice/, 'the record carries the notice and nothing renders it');
  const reader = source('./DocumentReader.tsx');
  assert.match(reader, /outline\.notice/, 'the outline carries the notice and nothing renders it');
  // A part with no text must say WHY, or a scanned page renders as a page that
  // happened to be blank — the failure this ADR is about, in the UI.
  assert.match(reader, /a scan/, 'an empty part renders as an empty page');
});
