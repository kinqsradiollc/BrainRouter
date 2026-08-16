/**
 * ADR-030 D1 — a font resource turned into two things the content walker needs:
 * a decoder for its byte codes, and the widths that say how far each glyph
 * moves the pen.
 *
 * The decoder is built from whichever evidence the document actually supplies,
 * in this order:
 *
 *  1. `/ToUnicode` — the document telling us what its codes mean. Authoritative,
 *     and the only source that works for a subset font whose codes start at 0.
 *  2. A named `/Encoding` (WinAnsi, MacRoman, Standard) plus any
 *     `/Differences`, for simple fonts.
 *  3. StandardEncoding, for a NON-symbolic simple font that declares nothing —
 *     that is the specified default, so it is established, not guessed.
 *
 * A font with none of those — the usual case being a symbolic subset with no
 * `/ToUnicode` — is marked `decodable: false`, and every run set in it is
 * reported as undecodable instead of being transliterated into confident
 * nonsense. Widths still work for those runs, so the text around them keeps its
 * geometry.
 */
import { get, resolve, streamBytes, type PdfDoc } from './document.js';
import { baseEncodingTable, glyphNameToChar, parseCMap, type BaseEncodingName } from './encoding.js';
import { dictOf, nameOf, numberOf, type PdfDict, type PdfObject } from './objects.js';

export interface PdfFont {
  /** The `/BaseFont` name when present, else the resource name. */
  name: string;
  /** True for Type0/CID fonts addressed with two-byte codes. */
  twoByte: boolean;
  decodable: boolean;
  toUnicode?: Map<number, string>;
  simple?: Map<number, string>;
  widths: Map<number, number>;
  /** Width used for codes the font does not list, in 1/1000 text-space units. */
  defaultWidth: number;
}

export interface DecodedRun {
  text: string;
  /** Sum of glyph widths, in 1/1000 text-space units, before spacing is applied. */
  width: number;
  /** Codes we could not decode and therefore did not write down. */
  dropped: number;
  /** Codes in the run, for word-spacing (which applies only to single-byte 32). */
  codes: number[];
}

/**
 * The font for a resource we could not resolve at all.
 *
 * It decodes through StandardEncoding, and the distinction that makes that
 * honest rather than a guess is absence of evidence versus evidence of a
 * private encoding: StandardEncoding is what the specification says a simple
 * font means when nothing says otherwise, and here nothing has. A font we CAN
 * read which declares itself symbolic with no `/ToUnicode` has told us its
 * codes are private — that one stays undecodable.
 */
export const UNKNOWN_FONT: PdfFont = {
  name: '',
  twoByte: false,
  decodable: true,
  simple: baseEncodingTable('StandardEncoding'),
  widths: new Map(),
  defaultWidth: 500,
};

export function buildFont(doc: PdfDoc, dict: PdfDict, resourceName: string): PdfFont {
  const subtype = nameOf(get(doc, dict, 'Subtype')) ?? '';
  const baseFont = nameOf(get(doc, dict, 'BaseFont')) ?? resourceName;
  const font: PdfFont = {
    name: baseFont,
    twoByte: false,
    decodable: false,
    widths: new Map(),
    defaultWidth: 500,
  };

  const toUnicodeStream = get(doc, dict, 'ToUnicode');
  if (toUnicodeStream?.t === 'stream') {
    const bytes = streamBytes(doc, toUnicodeStream);
    if (bytes) {
      const cmap = parseCMap(bytes.toString('latin1'));
      if (cmap.map.size > 0) {
        font.toUnicode = cmap.map;
        font.decodable = true;
      }
      if (cmap.codeWidths.has(2)) font.twoByte = true;
    }
  }

  if (subtype === 'Type0') {
    const encoding = get(doc, dict, 'Encoding');
    const encodingName = nameOf(encoding);
    // Identity-H/V and the predefined CMaps we do not carry are all two-byte;
    // a Type0 font is never decoded through a simple-font table.
    if (encodingName || encoding?.t === 'stream') font.twoByte = true;
    readCidWidths(doc, dict, font);
    return font;
  }

  readSimpleWidths(doc, dict, font);
  font.simple = simpleEncodingTable(doc, dict, baseFont);
  if (font.simple && font.simple.size > 0) font.decodable = true;
  return font;
}

/**
 * The code → character table for a simple font, or `undefined` when the
 * document has not established one.
 */
function simpleEncodingTable(doc: PdfDoc, dict: PdfDict, baseFont: string): Map<number, string> | undefined {
  const encoding = get(doc, dict, 'Encoding');
  const encodingName = nameOf(encoding);
  const encodingDict = dictOf(encoding);
  const baseName = encodingName ?? nameOf(get(doc, encodingDict, 'BaseEncoding'));

  let table: Map<number, string> | undefined;
  if (isBaseEncodingName(baseName)) table = baseEncodingTable(baseName);
  else if (!encodingDict) {
    // Nothing declared. The specified fallback is the font's built-in encoding,
    // which for a non-symbolic font is StandardEncoding — but for a SYMBOLIC one
    // it is private to the font file and we have not read the font file.
    if (isSymbolic(doc, dict) || /Symbol|Dingbat/i.test(baseFont)) return undefined;
    table = baseEncodingTable('StandardEncoding');
  } else {
    table = isSymbolic(doc, dict) ? new Map() : baseEncodingTable('StandardEncoding');
  }

  const differences = get(doc, encodingDict, 'Differences');
  if (differences?.t === 'array') {
    let code = 0;
    for (const entry of differences.v) {
      const resolved = resolve(doc, entry);
      if (resolved?.t === 'num') {
        code = Math.floor(resolved.v);
        continue;
      }
      if (resolved?.t !== 'name') continue;
      const ch = glyphNameToChar(resolved.v);
      // An unknown glyph name REMOVES the code rather than leaving whatever the
      // base encoding had there — the base is now known to be wrong for it.
      if (ch) table.set(code, ch);
      else table.delete(code);
      code++;
      if (code > 0xffff) break;
    }
  }
  return table.size > 0 ? table : undefined;
}

function isBaseEncodingName(name: string | undefined): name is BaseEncodingName {
  return (
    name === 'WinAnsiEncoding' || name === 'MacRomanEncoding' ||
    name === 'StandardEncoding' || name === 'MacExpertEncoding'
  );
}

function isSymbolic(doc: PdfDoc, dict: PdfDict): boolean {
  const descriptor = dictOf(get(doc, dict, 'FontDescriptor'));
  const flags = numberOf(get(doc, descriptor, 'Flags'));
  if (flags === undefined) return false;
  // Bit 3 (value 4) is Symbolic, bit 6 (value 32) is Nonsymbolic.
  return (flags & 4) !== 0 && (flags & 32) === 0;
}

function readSimpleWidths(doc: PdfDoc, dict: PdfDict, font: PdfFont): void {
  const descriptor = dictOf(get(doc, dict, 'FontDescriptor'));
  const missing = numberOf(get(doc, descriptor, 'MissingWidth'));
  if (missing !== undefined) font.defaultWidth = missing;
  const first = numberOf(get(doc, dict, 'FirstChar')) ?? 0;
  const widths = get(doc, dict, 'Widths');
  if (widths?.t !== 'array') return;
  for (let i = 0; i < widths.v.length && i < 65_536; i++) {
    const w = numberOf(resolve(doc, widths.v[i]));
    if (w !== undefined) font.widths.set(first + i, w);
  }
}

/**
 * CID widths: `/W` is `[c [w …] cFirst cLast w …]`, and `/DW` is the default.
 * We index by CODE, which equals the CID for Identity encodings — the only
 * mapping we can follow without the predefined CMap tables.
 */
function readCidWidths(doc: PdfDoc, dict: PdfDict, font: PdfFont): void {
  const descendants = get(doc, dict, 'DescendantFonts');
  const descendant = descendants?.t === 'array' ? dictOf(resolve(doc, descendants.v[0])) : undefined;
  if (!descendant) {
    font.defaultWidth = 1000;
    return;
  }
  font.defaultWidth = numberOf(get(doc, descendant, 'DW')) ?? 1000;
  const w = get(doc, descendant, 'W');
  if (w?.t !== 'array') return;
  const items = w.v;
  let i = 0;
  let assigned = 0;
  while (i < items.length && assigned < 65_536) {
    const first = numberOf(resolve(doc, items[i]));
    const second = resolve(doc, items[i + 1]);
    if (first === undefined || !second) break;
    if (second.t === 'array') {
      for (let k = 0; k < second.v.length && assigned < 65_536; k++) {
        const width = numberOf(resolve(doc, second.v[k]));
        if (width !== undefined) {
          font.widths.set(first + k, width);
          assigned++;
        }
      }
      i += 2;
      continue;
    }
    const last = numberOf(second);
    const width = numberOf(resolve(doc, items[i + 2]));
    if (last === undefined || width === undefined) break;
    const span = Math.min(last, first + 65_535);
    for (let code = first; code <= span && assigned < 65_536; code++) {
      font.widths.set(code, width);
      assigned++;
    }
    i += 3;
  }
}

/**
 * Decode a shown string.
 *
 * When the font is not decodable the text comes back empty with every code
 * counted as dropped — the caller turns that into an "undecodable run", which
 * is the report this ADR exists for. Widths are still summed so the pen ends up
 * in the right place for whatever follows.
 */
export function decodeString(font: PdfFont, bytes: Buffer): DecodedRun {
  const step = font.twoByte ? 2 : 1;
  let text = '';
  let width = 0;
  let dropped = 0;
  const codes: number[] = [];

  for (let i = 0; i + step - 1 < bytes.length; i += step) {
    const code = step === 2 ? (bytes[i] << 8) | bytes[i + 1] : bytes[i];
    codes.push(code);
    width += font.widths.get(code) ?? font.defaultWidth;
    if (!font.decodable) {
      dropped++;
      continue;
    }
    const mapped = font.toUnicode?.get(code) ?? font.simple?.get(code) ?? whitespaceControl(code);
    if (mapped === undefined || mapped.length === 0) {
      dropped++;
      continue;
    }
    text += mapped;
  }
  return { text, width, dropped, codes };
}

/**
 * Tab and the two line-break codes, when the encoding assigns them nothing.
 *
 * No Latin encoding gives them a glyph, so a writer that puts one inside a
 * shown string meant the whitespace — and unlike a letter, whitespace cannot be
 * the *wrong* character. That is what keeps this out of the guessing this file
 * otherwise refuses to do.
 */
function whitespaceControl(code: number): string | undefined {
  if (code === 0x09) return '\t';
  if (code === 0x0a || code === 0x0d) return '\n';
  return undefined;
}

/** Resolve a `/Font` resource entry, or `undefined` when the name is not one. */
export function fontFromResources(
  doc: PdfDoc,
  resources: PdfDict | undefined,
  name: string,
): { dict: PdfDict; cacheKey: string } | undefined {
  const fonts = dictOf(get(doc, resources, 'Font'));
  if (!fonts) return undefined;
  const raw: PdfObject | undefined = fonts.get(name);
  const dict = dictOf(resolve(doc, raw));
  if (!dict) return undefined;
  // Cache by object number when there is one: the same font is referenced from
  // every page, and rebuilding its CMap per page is the difference between
  // milliseconds and seconds on a long document.
  const cacheKey = raw?.t === 'ref' ? `obj:${raw.num}` : `name:${name}`;
  return { dict, cacheKey };
}
