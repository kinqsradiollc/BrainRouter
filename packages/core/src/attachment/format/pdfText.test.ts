import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPdf } from './pdfText.js';

/** A tiny, uncompressed PDF-ish document with one page and a Tj text show. */
const TINY_PDF =
  '%PDF-1.4\n' +
  '1 0 obj <</Type /Page /Parent 2 0 R>>\n' +
  'endobj\n' +
  '3 0 obj <</Length 44>>\n' +
  'stream\n' +
  'BT /F1 12 Tf 72 720 Td (Hello World) Tj ET\n' +
  'endstream endobj\n' +
  '2 0 obj <</Type /Pages /Kids [1 0 R] /Count 1>>\n' +
  'trailer <</Root 4 0 R>>\n' +
  '%%EOF\n';

test('extractPdf: pulls Tj text and counts one page', () => {
  const out = extractPdf(Buffer.from(TINY_PDF, 'latin1'));
  assert.match(out.text, /Hello World/);
  assert.equal(out.pageCount, 1);
  assert.equal(out.truncated, false);
});

test('extractPdf: does not count /Pages as a page object', () => {
  // Only `/Type /Pages` present (no per-page object) → fall back to /Count.
  const src =
    '%PDF-1.5\n2 0 obj <</Type /Pages /Kids [1 0 R 5 0 R] /Count 2>>\nendobj\n%%EOF';
  const out = extractPdf(Buffer.from(src, 'latin1'));
  assert.equal(out.pageCount, 2);
});

test('extractPdf: TJ array literals are extracted', () => {
  const src =
    '%PDF-1.4\n1 0 obj <</Type /Page>> endobj\n' +
    'BT [(Hel) -250 (lo) -120 (!)] TJ ET\n%%EOF';
  const out = extractPdf(Buffer.from(src, 'latin1'));
  assert.match(out.text, /Hel/);
  assert.match(out.text, /lo/);
});

test('extractPdf: unescapes \\( \\) \\\\ and octal escapes', () => {
  // Literal "(a\)b\\c) Tj" should unescape to a)b\c
  const src = '%PDF-1.4\n1 0 obj <</Type /Page>> endobj\nBT (a\\)b\\\\c) Tj ET\n%%EOF';
  const out = extractPdf(Buffer.from(src, 'latin1'));
  assert.match(out.text, /a\)b\\c/);
});

test('extractPdf: octal escape decodes to the right character', () => {
  // \101 is octal for 'A'.
  const src = '%PDF-1.4\n1 0 obj <</Type /Page>> endobj\nBT (X\\101Y) Tj ET\n%%EOF';
  const out = extractPdf(Buffer.from(src, 'latin1'));
  assert.match(out.text, /XAY/);
});

test('extractPdf: empty input → { text: "", truncated: false } without throwing', () => {
  const out = extractPdf(Buffer.alloc(0));
  assert.deepEqual(out, { text: '', truncated: false });
});

test('extractPdf: garbage input does not throw and yields no page count', () => {
  const out = extractPdf(Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x03]));
  assert.equal(typeof out.text, 'string');
  assert.equal(out.truncated, false);
  assert.equal(out.pageCount, undefined);
});

test('extractPdf: maxChars truncates and sets truncated=true', () => {
  const big =
    '%PDF-1.4\n1 0 obj <</Type /Page>> endobj\nBT (' +
    'A'.repeat(500) +
    ') Tj ET\n%%EOF';
  const out = extractPdf(Buffer.from(big, 'latin1'), { maxChars: 100 });
  assert.equal(out.text.length, 100);
  assert.equal(out.truncated, true);
});

test('extractPdf: text under the cap is not marked truncated', () => {
  const out = extractPdf(Buffer.from(TINY_PDF, 'latin1'), { maxChars: 20000 });
  assert.equal(out.truncated, false);
  assert.ok(out.text.length <= 20000);
});

test('extractPdf: falls back to printable runs when no Tj/TJ text exists', () => {
  // No text operators, but readable prose sits in an uncompressed region.
  const src =
    '%PDF-1.4\n1 0 obj <</Type /Page>> endobj\n' +
    '4 0 obj <</Title (ignored-dict)>>\n' +
    'This document mentions Quarterly Report figures inline.\n%%EOF';
  const out = extractPdf(Buffer.from(src, 'latin1'));
  assert.match(out.text, /Quarterly Report/);
});
