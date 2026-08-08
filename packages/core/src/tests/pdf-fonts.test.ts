import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPdf, HELLO_CMAP, rawStream } from './_pdfFixtures.js';
import { getObject, loadDocument } from '../attachment/format/pdf/document.js';
import { buildFont, decodeString, type PdfFont } from '../attachment/format/pdf/fonts.js';
import { baseEncodingTable, glyphNameToChar, parseCMap } from '../attachment/format/pdf/encoding.js';
import { createBudget } from '../attachment/format/pdf/limits.js';
import { dictOf } from '../attachment/format/pdf/objects.js';
import type { ObjectSpec } from './_pdfFixtures.js';

/** Object 1 is the font; extras become objects 2, 3, … in order. */
function fontFrom(fontBody: string, extraObjects: ObjectSpec[] = []): PdfFont {
  const doc = loadDocument(buildPdf([{ body: fontBody }, ...extraObjects]), createBudget());
  const dict = dictOf(getObject(doc, 1));
  assert.ok(dict, 'font dictionary parsed');
  return buildFont(doc, dict, 'F1');
}

test('a ToUnicode CMap decodes bfchar and bfrange entries', () => {
  const cmap = parseCMap(HELLO_CMAP);
  assert.equal(cmap.map.get(0x01), 'H');
  assert.equal(cmap.map.get(0x02), 'e');
  assert.equal(cmap.map.get(0x03), 'l');
  assert.equal(cmap.map.get(0x04), 'o');
  assert.equal(cmap.map.get(0x10), 'A');
  assert.equal(cmap.map.get(0x12), 'C', 'the range runs consecutively');
  assert.ok(cmap.codeWidths.has(1));
});

test('a bfrange with an explicit destination array maps each code separately', () => {
  const cmap = parseCMap('1 beginbfrange\n<10> <12> [<0041> <0042> <0043>]\nendbfrange');
  assert.equal(cmap.map.get(0x10), 'A');
  assert.equal(cmap.map.get(0x11), 'B');
  assert.equal(cmap.map.get(0x12), 'C');
});

test('a ToUnicode destination outside the BMP survives as its surrogate pair', () => {
  const cmap = parseCMap('1 beginbfchar\n<01> <D83DDE00>\nendbfchar');
  assert.equal(cmap.map.get(0x01), '\u{1F600}');
});

test('a font with a ToUnicode CMap decodes its subset codes', () => {
  const font = fontFrom(
    '<</Type/Font/Subtype/TrueType/BaseFont/ABCDEF+Subset/FontDescriptor 3 0 R/ToUnicode 2 0 R>>',
    [rawStream(HELLO_CMAP), { body: '<</Type/FontDescriptor/Flags 4>>' }],
  );
  assert.equal(font.decodable, true);
  const run = decodeString(font, Buffer.from([1, 2, 3, 3, 4]));
  assert.equal(run.text, 'Hello');
  assert.equal(run.dropped, 0);
});

test('a symbolic subset font with no ToUnicode is undecodable, not transliterated', () => {
  const font = fontFrom(
    '<</Type/Font/Subtype/TrueType/BaseFont/ABCDEF+Subset/FirstChar 0/LastChar 4' +
    '/Widths[500 500 500 500 500]/FontDescriptor 2 0 R>>',
    [{ body: '<</Type/FontDescriptor/Flags 4>>' }],
  );
  assert.equal(font.decodable, false);
  const run = decodeString(font, Buffer.from([1, 2, 3, 3, 4]));
  assert.equal(run.text, '', 'no letters are invented');
  assert.equal(run.dropped, 5);
  assert.equal(run.width, 2500, 'widths still advance the pen');
});

test('a Type0 font is read two bytes at a time', () => {
  const font = fontFrom(
    '<</Type/Font/Subtype/Type0/BaseFont/ABCDEF+CID/Encoding/Identity-H' +
    '/DescendantFonts[3 0 R]/ToUnicode 2 0 R>>',
    [rawStream(HELLO_CMAP), { body: '<</Type/Font/Subtype/CIDFontType2/DW 1000/W[1 [600 700]]>>' }],
  );
  assert.equal(font.twoByte, true);
  const run = decodeString(font, Buffer.from([0, 1, 0, 2, 0, 3, 0, 3, 0, 4]));
  assert.equal(run.text, 'Hello');
  assert.equal(run.width, 600 + 700 + 1000 * 3, '/W pairs then /DW for the rest');
});

test('WinAnsiEncoding plus Differences decodes, and an unknown glyph name is dropped', () => {
  const font = fontFrom(
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding' +
    '<</BaseEncoding/WinAnsiEncoding/Differences[65 /bullet 66 /nosuchglyphname]>>>>',
  );
  assert.equal(font.decodable, true);
  const run = decodeString(font, Buffer.from('ABC', 'latin1'));
  assert.equal(run.text, '•C', 'A became the bullet, B had no establishable meaning');
  assert.equal(run.dropped, 1);
});

test('a non-symbolic font that declares nothing falls back to the specified StandardEncoding', () => {
  const font = fontFrom('<</Type/Font/Subtype/Type1/BaseFont/Times-Roman>>');
  assert.equal(font.decodable, true);
  assert.equal(decodeString(font, Buffer.from('Plain text', 'latin1')).text, 'Plain text');
});

test('base encoding tables disagree exactly where the specification says they do', () => {
  const win = baseEncodingTable('WinAnsiEncoding');
  const mac = baseEncodingTable('MacRomanEncoding');
  const std = baseEncodingTable('StandardEncoding');
  assert.equal(win.get(0x93), '“');
  assert.equal(win.get(0xe9), 'é');
  assert.equal(mac.get(0x8e), 'é');
  assert.equal(mac.get(0xd0), '–');
  assert.equal(std.get(0x27), '’', 'Standard reassigns the ASCII apostrophe');
  assert.equal(std.get(0xe9), 'Ø', 'and its high range is not Latin-1 at all');
  assert.equal(std.get(0xe4), undefined, 'unassigned codes stay unassigned');
  assert.equal(win.get(0x41), 'A');
});

test('glyph names resolve by table, by uniXXXX, and not at all when unknown', () => {
  assert.equal(glyphNameToChar('eacute'), 'é');
  assert.equal(glyphNameToChar('uni20AC'), '€');
  assert.equal(glyphNameToChar('a.sc'), 'a');
  assert.equal(glyphNameToChar('g42'), undefined);
});

test('a CMap with a two-byte codespace marks the font two-byte', () => {
  const cmap = parseCMap('1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange');
  assert.ok(cmap.codeWidths.has(2));
});
