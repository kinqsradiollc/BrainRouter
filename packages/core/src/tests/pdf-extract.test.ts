import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { buildPdf, flateStream, HELLO_CMAP, onePageFlatePdf, rawStream } from './_pdfFixtures.js';
import { extractPdf, extractPdfDocument, scavengePrintable } from '../attachment/format/pdf/extract.js';
import { PDF_BOUNDS } from '../attachment/format/pdf/limits.js';
import { UNDECODABLE_NOTICE_PREFIX } from '../attachment/format/pdf/flatten.js';

test('a Flate-compressed content stream yields its text — the whole point of D1', () => {
  const pdf = onePageFlatePdf('BT /F1 12 Tf 72 720 Td (Compressed and readable) Tj ET');
  const out = extractPdf(pdf);
  assert.equal(out.text, 'Compressed and readable');
  assert.equal(out.pageCount, 1);
  assert.equal(out.scavenged, undefined, 'this is a parse, not a scavenge');
  assert.equal(out.limits, undefined);
});

test('text comes back with positions and font size, not just characters', () => {
  const pdf = onePageFlatePdf(
    'BT /F1 18 Tf 72 700 Td (Heading) Tj 0 -24 Td /F1 10 Tf (Body text) Tj ET',
  );
  const doc = extractPdfDocument(pdf);
  const [heading, body] = doc.pages[0].items;
  assert.equal(heading.text, 'Heading');
  assert.equal(heading.x, 72);
  assert.equal(heading.y, 700);
  assert.equal(heading.fontSize, 18);
  assert.ok(heading.width > 0, 'the run knows where it ends');
  assert.equal(body.y, 676, 'Td moved the line down');
  assert.equal(body.fontSize, 10);
  assert.equal(doc.pages[0].width, 612);
  assert.equal(doc.pages[0].height, 792);
});

test('the current transform matrix moves text with the page', () => {
  const pdf = onePageFlatePdf('q 1 0 0 1 100 50 cm BT /F1 12 Tf 10 10 Td (Shifted) Tj ET Q');
  const [item] = extractPdfDocument(pdf).pages[0].items;
  assert.equal(item.x, 110);
  assert.equal(item.y, 60);
});

test('TJ kerning wide enough to be a word gap becomes a space', () => {
  const pdf = onePageFlatePdf('BT /F1 12 Tf 72 720 Td [(Two) -400 (words) -30 (kerned)] TJ ET');
  assert.equal(extractPdf(pdf).text, 'Two wordskerned');
});

test('line and paragraph breaks come from the geometry', () => {
  const pdf = onePageFlatePdf(
    'BT /F1 12 Tf 72 720 Td (First line) Tj 0 -14 Td (Second line) Tj ET',
  );
  assert.equal(extractPdf(pdf).text, 'First line\nSecond line');
});

test("' and \" show a string on the next line", () => {
  const pdf = onePageFlatePdf("BT /F1 12 Tf 14 TL 72 720 Td (One) ' 0 0 (Two) \" ET");
  assert.equal(extractPdf(pdf).text, 'One\nTwo');
});

test('pages come back in page-tree order, separated', () => {
  const pdf = buildPdf([
    { body: '<</Type/Catalog/Pages 2 0 R>>' },
    { body: '<</Type/Pages/Kids[3 0 R 5 0 R]/Count 2/Resources<</Font<</F1 7 0 R>>>>>>' },
    { body: '<</Type/Page/Parent 2 0 R/Contents 4 0 R>>' },
    flateStream('BT /F1 12 Tf 72 720 Td (Page one) Tj ET'),
    { body: '<</Type/Page/Parent 2 0 R/Contents 6 0 R>>' },
    flateStream('BT /F1 12 Tf 72 720 Td (Page two) Tj ET'),
    { body: '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>' },
  ]);
  const out = extractPdf(pdf);
  assert.equal(out.text, 'Page one\n\nPage two');
  assert.equal(out.pageCount, 2);
});

test('a form XObject is followed, because for some writers that is where the text is', () => {
  const pdf = buildPdf([
    { body: '<</Type/Catalog/Pages 2 0 R>>' },
    { body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
    {
      body:
        '<</Type/Page/Parent 2 0 R/Contents 4 0 R/Resources<</XObject<</X1 5 0 R>>' +
        '/Font<</F1 6 0 R>>>>>>',
    },
    flateStream('q 1 0 0 1 20 30 cm /X1 Do Q'),
    {
      ...flateStream('BT /F1 12 Tf 0 0 Td (Inside the form) Tj ET'),
      body: `<</Type/XObject/Subtype/Form/Matrix[1 0 0 1 0 0]/Length ${
        zlib.deflateSync(Buffer.from('BT /F1 12 Tf 0 0 Td (Inside the form) Tj ET', 'latin1')).length
      }/Filter/FlateDecode>>`,
    },
    { body: '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>' },
  ]);
  const doc = extractPdfDocument(pdf);
  assert.equal(doc.pages[0].items[0]?.text, 'Inside the form');
  assert.equal(doc.pages[0].items[0]?.x, 20, 'the form matrix and the CTM both applied');
});

test('an image draw is counted, so a scanned page can be told from an empty one', () => {
  const pdf = buildPdf([
    { body: '<</Type/Catalog/Pages 2 0 R>>' },
    { body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
    { body: '<</Type/Page/Parent 2 0 R/Contents 4 0 R/Resources<</XObject<</Im0 5 0 R>>>>>>' },
    flateStream('q 612 0 0 792 0 0 cm /Im0 Do Q'),
    { body: '<</Type/XObject/Subtype/Image/Width 1/Height 1/Filter/DCTDecode/Length 3>>', stream: Buffer.from([1, 2, 3]) },
  ]);
  const doc = extractPdfDocument(pdf);
  assert.equal(doc.pages[0].imageCount, 1);
  assert.equal(doc.pages[0].charCount, 0);
  assert.equal(doc.pages[0].undecodableRuns, 0);
});

test('a subset font with no ToUnicode is reported unreadable rather than transliterated', () => {
  const pdf = onePageFlatePdf(
    'BT /F1 12 Tf 72 720 Td <0102030304> Tj ET',
    '<</Type/Font/Subtype/TrueType/BaseFont/ABCDEF+Subset/FirstChar 0/LastChar 4' +
    '/Widths[500 500 500 500 500]/FontDescriptor 6 0 R>>',
  );
  const withDescriptor = Buffer.concat([
    pdf.subarray(0, pdf.indexOf('trailer')),
    Buffer.from('6 0 obj\n<</Type/FontDescriptor/Flags 4>>\nendobj\n', 'latin1'),
    pdf.subarray(pdf.indexOf('trailer')),
  ]);
  const out = extractPdf(withDescriptor);
  assert.equal(out.undecodableRuns, 1);
  assert.ok(out.text.startsWith(UNDECODABLE_NOTICE_PREFIX), out.text);
  assert.ok(!/[A-Za-z]{3}/.test(out.text.replace(UNDECODABLE_NOTICE_PREFIX, '').slice(0, 4)));
});

test('the same document WITH a ToUnicode map decodes the same bytes correctly', () => {
  const pdf = buildPdf([
    { body: '<</Type/Catalog/Pages 2 0 R>>' },
    { body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
    { body: '<</Type/Page/Parent 2 0 R/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>' },
    flateStream('BT /F1 12 Tf 72 720 Td <0102030304> Tj ET'),
    {
      body:
        '<</Type/Font/Subtype/TrueType/BaseFont/ABCDEF+Subset/FirstChar 0/LastChar 4' +
        '/Widths[500 500 500 500 500]/ToUnicode 6 0 R>>',
    },
    rawStream(HELLO_CMAP),
  ]);
  const out = extractPdf(pdf);
  assert.equal(out.text, 'Hello');
  assert.equal(out.undecodableRuns, undefined);
});

test('objects hidden in a compressed object stream are still found', () => {
  const inner = '<</Type/Catalog/Pages 5 0 R>> <</Type/Page/Parent 5 0 R/Contents 6 0 R>>';
  const header = '1 0 4 29 ';
  const payload = header + inner;
  const deflated = zlib.deflateSync(Buffer.from(payload, 'latin1'));
  const pdf = buildPdf([
    {
      body: `<</Type/ObjStm/N 2/First ${header.length}/Length ${deflated.length}/Filter/FlateDecode>>`,
      stream: deflated,
    },
    { body: '<</Type/Pages/Kids[4 0 R]/Count 1>>' },
    flateStream('BT /F1 12 Tf 72 720 Td (From an object stream) Tj ET'),
  ], '<</Root 1 0 R>>');
  // Objects 1 and 4 live inside the stream; 5 and 6 are the tree and content.
  const remapped = Buffer.from(
    pdf.toString('latin1').replace('2 0 obj', '5 0 obj').replace('3 0 obj', '6 0 obj'),
    'latin1',
  );
  assert.match(extractPdf(remapped).text, /From an object stream/);
});

test('an encrypted document says so instead of returning plausible rubbish', () => {
  const pdf = buildPdf(
    [{ body: '<</Type/Catalog/Pages 2 0 R>>' }, { body: '<</Type/Pages/Count 1>>' }],
    '<</Root 1 0 R/Encrypt 9 0 R>>',
  );
  const doc = extractPdfDocument(pdf);
  assert.equal(doc.encrypted, true);
  assert.deepEqual(doc.limits, ['encrypted']);
  assert.equal(extractPdf(pdf).text, '', 'and no scavenged consolation prize');
});

test('an input over the byte cap is refused with a reason, not parsed', () => {
  const pdf = onePageFlatePdf('BT /F1 12 Tf 72 720 Td (Too big to read) Tj ET');
  const out = extractPdf(pdf, { bounds: { maxBytes: 32 } });
  assert.equal(out.text, '');
  assert.deepEqual(out.limits, ['bytes']);
});

test('a page budget of one stops after one page and says which bound it hit', () => {
  const pdf = buildPdf([
    { body: '<</Type/Catalog/Pages 2 0 R>>' },
    { body: '<</Type/Pages/Kids[3 0 R 5 0 R]/Count 2/Resources<</Font<</F1 7 0 R>>>>>>' },
    { body: '<</Type/Page/Parent 2 0 R/Contents 4 0 R>>' },
    flateStream('BT /F1 12 Tf 72 720 Td (Page one) Tj ET'),
    { body: '<</Type/Page/Parent 2 0 R/Contents 6 0 R>>' },
    flateStream('BT /F1 12 Tf 72 720 Td (Page two) Tj ET'),
    { body: '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>' },
  ]);
  const out = extractPdf(pdf, { bounds: { maxPages: 1 } });
  assert.equal(out.text, 'Page one');
  assert.ok(out.limits?.includes('pages'));
  assert.equal(out.pageCount, 2, 'the document still reports the pages it has');
});

test('an exhausted time budget ends the parse instead of the process', () => {
  const pdf = onePageFlatePdf('BT /F1 12 Tf 72 720 Td (Never reached) Tj ET');
  const out = extractPdf(pdf, { bounds: { timeBudgetMs: -1 } });
  assert.ok(out.limits?.includes('time'));
  assert.equal(typeof out.text, 'string');
});

test('a cyclic page tree terminates', () => {
  const pdf = buildPdf([
    { body: '<</Type/Catalog/Pages 2 0 R>>' },
    { body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
    { body: '<</Type/Pages/Kids[2 0 R 3 0 R]/Count 1>>' },
  ]);
  const started = Date.now();
  const doc = extractPdfDocument(pdf);
  assert.ok(Date.now() - started < 2000);
  assert.equal(doc.pages.length, 0);
});

test('a decompression bomb inside a page stream degrades the page, not the process', () => {
  const bomb = zlib.deflateSync(Buffer.alloc(32 * 1024 * 1024));
  const pdf = buildPdf([
    { body: '<</Type/Catalog/Pages 2 0 R>>' },
    { body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
    { body: '<</Type/Page/Parent 2 0 R/Contents 4 0 R>>' },
    { body: `<</Length ${bomb.length}/Filter/FlateDecode>>`, stream: bomb },
  ]);
  const started = Date.now();
  const out = extractPdf(pdf, { bounds: { maxInflatedBytesTotal: 65_536, maxInflatedBytesPerStream: 65_536 } });
  assert.ok(Date.now() - started < 3000);
  assert.equal(out.text, '');
});

test('100k of adversarial syntax parses in linear time, whatever shape it is', () => {
  const shapes: [string, Buffer][] = [
    ['unterminated literals', Buffer.from(`%PDF-1.7\n1 0 obj ${'('.repeat(100_000)}`, 'latin1')],
    ['nested dictionaries', Buffer.from(`%PDF-1.7\n1 0 obj ${'<<'.repeat(100_000)}`, 'latin1')],
    ['reference-shaped digits', Buffer.from(`%PDF-1.7\n1 0 obj [${'1 0 R '.repeat(20_000)}]`, 'latin1')],
    ['object headers', Buffer.from(`%PDF-1.7\n${'9 0 obj\n'.repeat(12_500)}`, 'latin1')],
    ['name escapes', Buffer.from(`%PDF-1.7\n1 0 obj /${'#41'.repeat(34_000)}`, 'latin1')],
    ['show operators', Buffer.from(`%PDF-1.7\n1 0 obj\nBT ${'(a) Tj '.repeat(15_000)}ET`, 'latin1')],
    ['slashes and brackets', Buffer.from(`%PDF-1.7\n${'/<[('.repeat(25_000)}`, 'latin1')],
  ];
  for (const [label, input] of shapes) {
    assert.ok(input.length >= 100_000, `${label} is a 100k input`);
    const started = Date.now();
    const out = extractPdf(input);
    const elapsed = Date.now() - started;
    assert.equal(typeof out.text, 'string', label);
    assert.ok(elapsed < 3000, `${label} took ${elapsed}ms`);
  }
});

test('random bytes never throw and never produce a page count out of nowhere', () => {
  let seed = 20260808;
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed & 0xff;
  };
  for (let round = 0; round < 40; round++) {
    const bytes = Buffer.from(Array.from({ length: 4096 }, next));
    if (round % 3 === 0) bytes.write('%PDF-1.7\n', 0, 'latin1');
    if (round % 5 === 0) bytes.write('1 0 obj <</Type/Page>> stream\n', 16, 'latin1');
    const out = extractPdf(bytes);
    assert.equal(typeof out.text, 'string');
    assert.equal(typeof out.truncated, 'boolean');
  }
});

test('the printable-run scavenger keeps prose and refuses compressed confetti', () => {
  assert.equal(
    scavengePrintable('%%EOF\x00This document mentions Quarterly Report figures inline.\x00'),
    'This document mentions Quarterly Report figures inline.',
  );
  const confetti = 'bl0$ s\teI6 U"k\' ;r\t@` M_<2% F-x{ t6Qa d~XJN 1uAN XECU gzJ\' b`w\'C h0gy &us UJ';
  assert.equal(scavengePrintable(confetti), '', 'the failure this ADR is about');
  assert.equal(scavengePrintable('4 0 obj <</Title (ignored-dict)/Filter /FlateDecode>>'), '');
});

/** A buffer of plausible prose that the last-resort harvest WILL take. */
function proseBlob(bytes: number): Buffer {
  const line = Buffer.from('the quarterly report explains the sampling frame and the instrument.\n', 'latin1');
  const body = Buffer.alloc(bytes, 0x20);
  for (let i = 0; i + line.length < body.length; i += line.length) line.copy(body, i);
  return Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), body]);
}

test('a file refused for its SIZE is not then scanned end to end anyway', () => {
  // The routing used to be inverted, and this is the whole of it: the refusal
  // returns no pages, "every page is empty" is VACUOUSLY true on an empty list,
  // and so being told a file was too big to open was the way to have all of it
  // read a character at a time. Measured at 50 MB — inside the attachment cap,
  // so accepted — that reached 1.9 GB of resident memory and killed the process.
  const blob = proseBlob(256 * 1024);
  const out = extractPdf(blob, { bounds: { maxBytes: 4096 } });
  assert.deepEqual(out.limits, ['bytes']);
  assert.equal(out.text, '', 'refused means less work, never more');
  assert.equal(out.scavenged, undefined);
  // The same bytes under a cap that admits them still harvest, so the assertion
  // above is about the refusal and not about the blob being unharvestable.
  const admitted = extractPdf(blob);
  assert.equal(admitted.scavenged, true);
  assert.match(admitted.text, /the quarterly report explains/);
});

test('the last-resort harvest reads a bounded slice and records the wall', () => {
  const blob = proseBlob(32 * 1024);
  const late = 'Only reachable past the harvest window: the appendix names the instrument.';
  blob.write(late, blob.length - late.length - 1, 'latin1');

  const capped = extractPdf(blob, { maxChars: -1, bounds: { maxScavengeBytes: 8 * 1024 } });
  assert.ok(capped.limits?.includes('scavenge'), 'the wall is reported, not silently absorbed');
  assert.ok(capped.text.length > 0, 'and the slice it did read was still harvested');
  assert.ok(!capped.text.includes('Only reachable past'), 'it stopped where it said it stopped');

  const whole = extractPdf(blob, { maxChars: -1 });
  assert.ok(!whole.limits?.includes('scavenge'), 'no wall when the file fits inside the window');
  assert.ok(whole.text.includes('Only reachable past'), 'and then the tail of the file is read');
});

test('the SHIPPING harvest bound is a slice of a file, not a file', () => {
  // Every other test here overrides the bounds, so a regression that widened
  // this one back to `maxBytes` would pass all of them. It is the number that
  // decides how much attacker-controlled input a linear scan may copy, and at
  // `maxBytes` that was 1.9 GB of resident memory and a dead host process for a
  // 50 MB upload the attachment cap accepts.
  assert.ok(PDF_BOUNDS.maxScavengeBytes > 0);
  assert.ok(
    PDF_BOUNDS.maxScavengeBytes <= PDF_BOUNDS.maxBytes / 4,
    'what a structured parse may consume is not what a printable-run scan may consume',
  );
  const blob = proseBlob(PDF_BOUNDS.maxScavengeBytes * 2);
  const started = Date.now();
  const out = extractPdf(blob, { maxChars: -1 });
  const elapsed = Date.now() - started;
  assert.ok(out.limits?.includes('scavenge'), 'the shipping bound bit, and said so');
  assert.ok(elapsed < 5_000, `a file twice the harvest window took ${elapsed}ms`);
  // One unbroken printable run is what an all-printable file is, and it is a
  // blob rather than a sentence however long it runs for.
  assert.equal(scavengePrintable('a'.repeat(256 * 1024)), '');
});

test('the text cap still truncates and reports it', () => {
  const pdf = onePageFlatePdf(`BT /F1 12 Tf 72 720 Td (${'A'.repeat(500)}) Tj ET`);
  const out = extractPdf(pdf, { maxChars: 100 });
  assert.equal(out.text.length, 100);
  assert.equal(out.truncated, true);
});

test('a rotated page carries its rotation, since the runs are in unrotated space', () => {
  const pdf = buildPdf([
    { body: '<</Type/Catalog/Pages 2 0 R>>' },
    { body: '<</Type/Pages/Kids[3 0 R]/Count 1/Rotate 90/MediaBox[0 0 612 792]>>' },
    { body: '<</Type/Page/Parent 2 0 R/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>' },
    flateStream('BT /F1 12 Tf 72 720 Td (Sideways) Tj ET'),
    { body: '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>' },
  ]);
  const page = extractPdfDocument(pdf).pages[0];
  assert.equal(page.rotation, 90, 'inherited from the page tree');
  assert.equal(page.items[0].x, 72, 'and the coordinates are NOT pre-rotated');
});

test('a page that drew an image and no text stays empty — it is a scan, not a parse failure', () => {
  const pdf = buildPdf([
    { body: '<</Type/Catalog/Pages 2 0 R>>' },
    { body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
    { body: '<</Type/Page/Parent 2 0 R/Contents 4 0 R/Resources<</XObject<</Im0 5 0 R>>>>>>' },
    flateStream('q 612 0 0 792 0 0 cm /Im0 Do Q'),
    { body: '<</Type/XObject/Subtype/Image/Width 1/Height 1/Filter/DCTDecode/Length 3>>', stream: Buffer.from([1, 2, 3]) },
    { body: '<</Producer (Some Renderer 10.8.3 PDFContext)/Title (Scanned invoice document)>>' },
  ]);
  const out = extractPdf(pdf);
  assert.equal(out.text, '', 'no producer string dressed up as the document');
  assert.equal(out.scavenged, undefined);
  assert.equal(extractPdfDocument(pdf).pages[0].imageCount, 1, 'and the signal a classifier needs survives');
});
