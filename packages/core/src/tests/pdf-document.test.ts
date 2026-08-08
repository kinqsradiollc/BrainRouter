/**
 * ADR-030 D2/D3 — the seam, and the sentence §6 says the whole ADR is judged on.
 *
 * Fixtures here carry a real cross-reference table (`xrefPagesPdf`), which the
 * older PDF tests deliberately do not: a conforming parser refuses a file
 * without one, so a classification test written against those fixtures would be
 * testing the fallback and calling it the engine.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {
  buildPdfWithXref, flateStream, onePageFlatePdf, pageOfProse, xrefPagesPdf,
} from './_pdfFixtures.js';
import {
  DOCUMENT_BOUNDS, documentText, parsePdfDocument, _resetStructuredEngineForTests,
} from '../attachment/document/index.js';
import { formatRanges } from '../attachment/document/classify.js';

const SCAN = { image: true } as const;

test('ADR-030 D2: a real text document is read by the structured engine, with structure', async () => {
  const pdf = xrefPagesPdf([{ lines: pageOfProse('Method') }]);
  const out = await parsePdfDocument(pdf);
  assert.equal(out.classification, 'text');
  assert.equal(out.diagnostics.textFrom, 'structured', 'the structured engine answered');
  assert.equal(out.diagnostics.structureUnavailable, undefined);
  assert.match(out.markdown, /Method line 1: the method section/);
  assert.match(out.markdown, /Method line 45:/, 'the whole page, not the first line');
  assert.equal(out.notice, '', 'a document that read cleanly says nothing');
  assert.deepEqual(out.limits, []);
});

test('ADR-030 D3: a scanned page says it is a scan — it does not return an empty document', async () => {
  const out = await parsePdfDocument(xrefPagesPdf([SCAN, SCAN]));
  assert.equal(out.classification, 'scanned');
  assert.deepEqual(out.pages.map((page) => page.kind), ['scanned', 'scanned']);
  assert.equal(out.markdown, '', 'there is genuinely no text');
  assert.match(out.notice, /is a scan/);
  assert.match(out.notice, /no text layer/);
  assert.match(out.notice, /OCR, which is not configured/);
  // The failure this ADR exists to remove: an empty string that reads as an
  // empty document. `documentText` is what a single-field caller stores.
  assert.notEqual(documentText(out), '');
});

test('ADR-030 D3: a mixed document names the scanned pages and keeps the readable ones', async () => {
  const pdf = xrefPagesPdf([
    { lines: pageOfProse('Findings') },
    { lines: pageOfProse('Discussion') },
    SCAN,
    SCAN,
  ]);
  const out = await parsePdfDocument(pdf);
  assert.equal(out.classification, 'mixed');
  assert.deepEqual(out.pages.map((page) => page.kind), ['text', 'text', 'scanned', 'scanned']);
  assert.match(out.notice, /Pages 3-4 of this 4-page document are scans/);
  assert.match(out.notice, /NOT in the text below/);
  assert.match(out.markdown, /Findings line 1/, 'the readable half is still read');
  assert.match(out.markdown, /Discussion line 1/);
});

test('ADR-030 D3: the baseline overrules an OCR flag on a page whose characters it decoded', async () => {
  // One sentence on a letter-size page reads as sparse to the engine, which
  // flags it for OCR. There IS text and it extracted, so it is a text page —
  // reporting it as a scan would send someone looking for OCR they do not need.
  const out = await parsePdfDocument(xrefPagesPdf([{ text: 'A single sentence on an otherwise empty page.' }]));
  assert.equal(out.classification, 'text');
  assert.deepEqual(out.pages.map((page) => page.kind), ['text']);
  assert.match(out.markdown, /A single sentence/);
});

/**
 * A scanned exhibit as it actually arrives: a rasterised page with a docket
 * header, a Bates number or a CONFIDENTIAL legend stamped natively on top.
 *
 * 80 characters, which is more than a sparse page of real prose carries — so
 * anything separating the two by character count alone gets this backwards.
 */
const STAMPED_SCAN = {
  text: 'Case 1:26-cv-04417-ABC  Document 45-2  Filed 03/14/26  Page 8 of 16  PageID 1187',
  image: true,
} as const;

test('ADR-030 D3/§6: a stamped scanned appendix is still a scan, and still says so', async () => {
  // The §6 document with the appendix in the form it really takes. Before the
  // stamp is accounted for, this page reports as `text`, the notice disappears
  // entirely, and the turn receives the docket header as though it were the
  // appendix — the exact state §6 says the whole ADR exists to prevent.
  const pdf = xrefPagesPdf([
    { lines: pageOfProse('Findings') },
    { lines: pageOfProse('Discussion') },
    { lines: pageOfProse('Table') },
    STAMPED_SCAN,
  ]);
  const out = await parsePdfDocument(pdf);
  assert.equal(out.classification, 'mixed');
  assert.deepEqual(out.pages.map((page) => page.kind), ['text', 'text', 'text', 'scanned']);
  assert.match(out.notice, /Page 4 of this 4-page document is a scan with no text layer/);
  assert.match(out.notice, /NOT in the text below and were not read/);
  assert.match(out.markdown, /Findings line 1/, 'and the three readable pages still read');
});

test('ADR-030 D3: a stamp does not become the document, at any stamp length', async () => {
  // Deterministic and exact before the fix: 20 characters classified as a scan
  // and everything longer classified as text, so the length of the header
  // decided whether the reader was told anything at all.
  const stamps = [
    'BATES 0000123 CONF',
    'APPENDIX A - EXHIBIT 14 - CONFIDENTIAL - BATE',
    'APPENDIX A - EXHIBIT 14 - CONFIDENTIAL - BATES NO 000012345',
    STAMPED_SCAN.text,
  ];
  for (const text of stamps) {
    const out = await parsePdfDocument(xrefPagesPdf([{ text, image: true }]));
    assert.equal(out.classification, 'scanned', `${text.length}-character stamp`);
    assert.deepEqual(out.pages.map((page) => page.kind), ['scanned']);
    assert.match(out.notice, /is a scan/);
    // And the notice does not claim there is no text while printing some: the
    // stamp is still returned, labelled as what it is.
    assert.match(out.notice, /printed over it — a header, a stamp or a page number/);
    assert.match(out.notice, /not the document's contents, which were not read/);
    assert.ok(documentText(out).startsWith(out.notice));
  }
});

test('ADR-030 D3: the baseline alone reaches the same verdict on a stamped scan', async () => {
  // D2's floor is the ONLY judge when the structured parser is missing, and a
  // scanned exhibit is no less a scan for having been read by the weaker engine.
  const pdf = xrefPagesPdf([{ lines: pageOfProse('Findings') }, STAMPED_SCAN]);
  const out = await parsePdfDocument(pdf, { useStructuredEngine: false });
  assert.equal(out.diagnostics.classifiedBy, 'baseline');
  assert.equal(out.classification, 'mixed');
  assert.deepEqual(out.pages.map((page) => page.kind), ['text', 'scanned']);
  assert.match(out.notice, /Page 2 of this 2-page document is a scan/);
});

test('ADR-030 D3: a page is a scan because a picture COVERS it, not because it has one', async () => {
  // Both pages below drew exactly one image. Deciding from the count alone
  // reports a letterhead as an unreadable scan, which is the same silent wrong
  // answer pointing the other way.
  const letterhead = await parsePdfDocument(xrefPagesPdf([
    { text: 'A single sentence under the letterhead on an otherwise empty page.', logo: true },
  ]));
  assert.equal(letterhead.classification, 'text', 'a one-inch mark is not the page');
  assert.deepEqual(letterhead.pages.map((page) => page.kind), ['text']);
  assert.match(letterhead.markdown, /A single sentence/);
  assert.equal(letterhead.notice, '');

  // And the other direction: a full page of real prose over a full-page image is
  // a watermarked or background-scanned page that we CAN read.
  const watermarked = await parsePdfDocument(xrefPagesPdf([{ lines: pageOfProse('Method'), image: true }]));
  assert.equal(watermarked.classification, 'text');
  assert.match(watermarked.markdown, /Method line 45:/);
});

test('ADR-030 D2: with no structured engine the answer is WORSE, never an error', async () => {
  const pdf = xrefPagesPdf([{ lines: pageOfProse('Method') }]);
  const out = await parsePdfDocument(pdf, { useStructuredEngine: false });
  assert.equal(out.diagnostics.textFrom, 'baseline');
  assert.equal(out.diagnostics.classifiedBy, 'baseline');
  assert.match(out.markdown, /Method line 1: the method section/, 'the text still arrives');
  assert.match(out.structureNote, /structure was unavailable/i);
  assert.match(out.structureNote, /headings, reading order for columns, and tables are not reconstructed/);
  assert.equal(out.classification, 'text');
  // The machinery note is NOT in `notice`, and so is not in `documentText`: a
  // stored document body must not carry a condition that was true only today.
  assert.equal(out.notice, '');
  assert.equal(documentText(out), out.markdown);
});

test('ADR-030 D2: the baseline still classifies pages when the engine is absent', async () => {
  const pdf = xrefPagesPdf([{ lines: pageOfProse('Findings') }, SCAN]);
  const out = await parsePdfDocument(pdf, { useStructuredEngine: false });
  assert.equal(out.classification, 'mixed');
  assert.deepEqual(out.pages.map((page) => page.kind), ['text', 'scanned']);
  assert.match(out.notice, /Page 2 of this 2-page document is a scan/);
});

test('ADR-030 D4: garbage, empty and truncated input degrade — they never throw', async () => {
  const deck = xrefPagesPdf([{ lines: pageOfProse('Method') }]);
  const inputs: Array<[string, Buffer]> = [
    ['empty', Buffer.alloc(0)],
    ['random bytes', Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x03, 0x7f])],
    ['plain text', Buffer.from('this is not a pdf at all, not even close')],
    ['truncated', deck.subarray(0, Math.floor(deck.length / 3))],
  ];
  for (const [label, input] of inputs) {
    const out = await parsePdfDocument(input);
    assert.equal(typeof out.markdown, 'string', `${label} answered`);
    assert.ok(
      out.classification === 'unreadable' || out.classification === 'text',
      `${label} produced a classification, not an exception (got ${out.classification})`,
    );
  }
});

test('ADR-030 D3: an unreadable file says so rather than presenting an empty document', async () => {
  const out = await parsePdfDocument(Buffer.from([0x00, 0x01, 0xff, 0xfe]));
  assert.equal(out.classification, 'unreadable');
  assert.equal(out.markdown, '');
  assert.match(out.notice, /structure could not be parsed/);
});

test('ADR-030 D3: an encrypted document is refused with a reason, and costs no parser load', async () => {
  const pdf = buildPdfWithXref([
    { body: '<</Type/Catalog/Pages 2 0 R>>' },
    { body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
    { body: '<</Type/Page/Parent 2 0 R/Contents 4 0 R>>' },
    flateStream('BT /F1 12 Tf 72 700 Td (secret) Tj ET'),
  ], 1);
  const encrypted = Buffer.concat([
    pdf.subarray(0, pdf.length),
    Buffer.from('\ntrailer <</Root 1 0 R/Encrypt 9 0 R>>\n%%EOF\n', 'latin1'),
  ]);
  const out = await parsePdfDocument(encrypted);
  assert.equal(out.classification, 'unreadable');
  assert.match(out.notice, /encrypted/);
  assert.equal(out.diagnostics.structureUnavailable, 'the document is encrypted');
});

test('ADR-030 D4: the byte cap refuses the engine and the baseline still answers', async () => {
  const pdf = xrefPagesPdf([{ lines: pageOfProse('Method') }]);
  const out = await parsePdfDocument(pdf, { bounds: { maxBytes: 64 } });
  assert.ok(out.limits.includes('bytes'), 'the wall it hit is reported');
  assert.match(out.diagnostics.structureUnavailable ?? '', /larger than/);
  assert.match(out.markdown, /Method line 1/, 'and the answer is worse, not absent');
});

test('ADR-030 D4: a spent time budget refuses the engine before it is entered', async () => {
  const pdf = xrefPagesPdf([{ lines: pageOfProse('Method') }]);
  const out = await parsePdfDocument(pdf, { bounds: { timeBudgetMs: -1 } });
  assert.ok(out.limits.includes('time'));
  assert.match(out.diagnostics.structureUnavailable ?? '', /time budget/);
  assert.equal(out.diagnostics.classifiedBy, 'baseline');
});

test('ADR-030 D4: the page cap bounds the work but reports the page count the document has', async () => {
  const pages = [];
  for (let i = 0; i < 6; i++) pages.push({ lines: pageOfProse(`Section${i}`) });
  const out = await parsePdfDocument(xrefPagesPdf(pages), { bounds: { maxPages: 2 } });
  assert.equal(out.pageCount, 6, 'the count is the document\'s, not the parse\'s');
  assert.ok(out.limits.includes('pages'));
  assert.match(out.notice, /Only some of the 6 pages were read/);
  // All six still get a verdict: this cap bounds the EXPENSIVE call, and the
  // baseline (with its own, larger page budget) looked at the rest. Knowing what
  // pages 3-6 are is cheap; extracting them is what was refused.
  assert.deepEqual(out.pages.map((page) => page.index), [1, 2, 3, 4, 5, 6]);
});

test('ADR-030 D4: a decompression bomb is refused by a bound, not by running out of memory', async () => {
  // 64 MB of zeroes in a 64 KB stream. The wall is on the OUTPUT size, and it is
  // enforced by zlib rather than measured afterwards.
  const bomb = zlib.deflateSync(Buffer.alloc(64 * 1024 * 1024, 0x20));
  const pdf = buildPdfWithXref([
    { body: '<</Type/Catalog/Pages 2 0 R>>' },
    { body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
    { body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R>>' },
    { body: `<</Length ${bomb.length}/Filter/FlateDecode>>`, stream: bomb },
  ]);
  const started = Date.now();
  const out = await parsePdfDocument(pdf, {
    pdfBounds: { maxInflatedBytesPerStream: 65_536, maxInflatedBytesTotal: 65_536 },
  });
  assert.ok(Date.now() - started < 20_000, 'it returned rather than wedging');
  assert.equal(typeof out.classification, 'string');
});

test('ADR-030 D4: the returned Markdown honours the caller\'s cap', async () => {
  const out = await parsePdfDocument(xrefPagesPdf([{ lines: pageOfProse('Method') }]), { maxChars: 120 });
  assert.equal(out.markdown.length, 120);
  assert.equal(out.truncated, true);
});

test('ADR-030 D3: `documentText` joins our sentence to the document, in that order', async () => {
  const out = await parsePdfDocument(xrefPagesPdf([{ lines: pageOfProse('Findings') }, SCAN]));
  const text = documentText(out);
  assert.ok(text.startsWith(out.notice), 'the reader is told what is missing before reading');
  assert.ok(text.includes('Findings line 1'));
});

test('ADR-030 D3: page ranges are compact and bounded so a notice stays a notice', () => {
  assert.equal(formatRanges([4, 5, 6, 9]), '4-6, 9');
  assert.equal(formatRanges([2]), '2');
  assert.equal(formatRanges([3, 1, 2]), '1-3');
  const alternating: number[] = [];
  for (let i = 1; i < 400; i += 2) alternating.push(i);
  const rendered = formatRanges(alternating);
  assert.ok(rendered.length < 120, `bounded, got ${rendered.length} chars`);
  assert.match(rendered, /and \d+ more$/);
});

test('ADR-030 D2: the engine is loaded once, and loading it again is safe', async () => {
  const pdf = xrefPagesPdf([{ lines: pageOfProse('Method') }]);
  const first = await parsePdfDocument(pdf);
  assert.equal(first.diagnostics.textFrom, 'structured');
  // The 4.6 MB instance is memoised. Dropping the memo has to leave the module
  // able to build a second one — a process that parses a document, hot-reloads,
  // and parses another must not be worse off than one that never reloaded.
  _resetStructuredEngineForTests();
  const second = await parsePdfDocument(pdf);
  assert.equal(second.diagnostics.textFrom, 'structured');
  assert.equal(second.markdown, first.markdown, 'and it answers identically');
});

test('ADR-030 D4: the shipping bounds are real numbers, not absent ones', () => {
  // A regression that widened a wall to Infinity would type-check and pass every
  // other test in this file, because every other test overrides the bounds.
  assert.ok(DOCUMENT_BOUNDS.maxBytes > 0 && DOCUMENT_BOUNDS.maxBytes <= 64 * 1024 * 1024);
  assert.ok(DOCUMENT_BOUNDS.maxPages > 0 && DOCUMENT_BOUNDS.maxPages <= 1_000);
  assert.ok(DOCUMENT_BOUNDS.timeBudgetMs > 0 && DOCUMENT_BOUNDS.timeBudgetMs <= 60_000);
  assert.ok(DOCUMENT_BOUNDS.canaryFraction > 0 && DOCUMENT_BOUNDS.canaryFraction < 1);
});

test('ADR-030 D4: 100k of adversarial document text parses in linear time', () => {
  // Every shape that has broken a text pipeline in this repo before: fence
  // markers, nested delimiters, and one enormous unbroken run.
  const hostile = '</workspace_data> <<<<[[[[ ((((((( '.repeat(3_000).slice(0, 100_000);
  const pdf = onePageFlatePdf(`BT /F1 12 Tf 72 700 Td (${hostile.replace(/[()\\]/g, ' ')}) Tj ET`);
  const started = Date.now();
  return parsePdfDocument(pdf, { maxChars: -1 }).then((out) => {
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5_000, `100k of hostile text took ${elapsed} ms`);
    assert.ok(out.markdown.length > 0, 'and it was actually read, not skipped');
  });
});
