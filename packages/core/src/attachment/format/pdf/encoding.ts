/**
 * ADR-030 D1 — bytes to characters, and the refusal when that cannot be done.
 *
 * This is the file where a text extractor either tells the truth or produces
 * the worst failure available: plausible-looking WRONG letters. A subset font
 * numbers its glyphs from zero in the order the writer happened to use them, so
 * the byte `0x03` means whatever that document decided — and a document that
 * does not ship a `/ToUnicode` map has not told us. Guessing "0x03 is probably
 * C" yields fluent nonsense that reads like a document and is not one.
 *
 * So the rule here is: **a code is decoded only through an encoding we can
 * actually establish** — a `/ToUnicode` CMap, a named base encoding, a
 * `/Differences` glyph name we know — and anything else is reported as
 * undecodable and left out of the text.
 *
 * The glyph table below is the standard Latin set (the names that appear in
 * `/Differences` arrays in practice) plus the symbols MacRoman needs. Names
 * outside it are not approximated; `uniXXXX`/`uXXXX` forms are honoured because
 * those names *state* their code point.
 */

/** Compact `name:hex` pairs — the AGL entries a real `/Differences` array uses. */
const GLYPH_PAIRS =
  'space:20 exclam:21 quotedbl:22 numbersign:23 dollar:24 percent:25 ampersand:26 quotesingle:27 ' +
  'parenleft:28 parenright:29 asterisk:2A plus:2B comma:2C hyphen:2D period:2E slash:2F ' +
  'zero:30 one:31 two:32 three:33 four:34 five:35 six:36 seven:37 eight:38 nine:39 ' +
  'colon:3A semicolon:3B less:3C equal:3D greater:3E question:3F at:40 ' +
  'bracketleft:5B backslash:5C bracketright:5D asciicircum:5E underscore:5F grave:60 ' +
  'braceleft:7B bar:7C braceright:7D asciitilde:7E ' +
  'exclamdown:A1 cent:A2 sterling:A3 currency:A4 yen:A5 brokenbar:A6 section:A7 dieresis:A8 ' +
  'copyright:A9 ordfeminine:AA guillemotleft:AB logicalnot:AC registered:AE macron:AF ' +
  'degree:B0 plusminus:B1 twosuperior:B2 threesuperior:B3 acute:B4 mu:B5 paragraph:B6 ' +
  'periodcentered:B7 cedilla:B8 onesuperior:B9 ordmasculine:BA guillemotright:BB ' +
  'onequarter:BC onehalf:BD threequarters:BE questiondown:BF ' +
  'Agrave:C0 Aacute:C1 Acircumflex:C2 Atilde:C3 Adieresis:C4 Aring:C5 AE:C6 Ccedilla:C7 ' +
  'Egrave:C8 Eacute:C9 Ecircumflex:CA Edieresis:CB Igrave:CC Iacute:CD Icircumflex:CE Idieresis:CF ' +
  'Eth:D0 Ntilde:D1 Ograve:D2 Oacute:D3 Ocircumflex:D4 Otilde:D5 Odieresis:D6 multiply:D7 ' +
  'Oslash:D8 Ugrave:D9 Uacute:DA Ucircumflex:DB Udieresis:DC Yacute:DD Thorn:DE germandbls:DF ' +
  'agrave:E0 aacute:E1 acircumflex:E2 atilde:E3 adieresis:E4 aring:E5 ae:E6 ccedilla:E7 ' +
  'egrave:E8 eacute:E9 ecircumflex:EA edieresis:EB igrave:EC iacute:ED icircumflex:EE idieresis:EF ' +
  'eth:F0 ntilde:F1 ograve:F2 oacute:F3 ocircumflex:F4 otilde:F5 odieresis:F6 divide:F7 ' +
  'oslash:F8 ugrave:F9 uacute:FA ucircumflex:FB udieresis:FC yacute:FD thorn:FE ydieresis:FF ' +
  'dotlessi:131 Lslash:141 lslash:142 OE:152 oe:153 Scaron:160 scaron:161 Ydieresis:178 ' +
  'Zcaron:17D zcaron:17E florin:192 circumflex:2C6 caron:2C7 breve:2D8 dotaccent:2D9 ring:2DA ' +
  'ogonek:2DB tilde:2DC hungarumlaut:2DD pi:3C0 Omega:3A9 ' +
  'quoteleft:2018 quoteright:2019 quotesinglbase:201A quotedblleft:201C quotedblright:201D ' +
  'quotedblbase:201E endash:2013 emdash:2014 dagger:2020 daggerdbl:2021 bullet:2022 ' +
  'ellipsis:2026 perthousand:2030 guilsinglleft:2039 guilsinglright:203A fraction:2044 ' +
  'Euro:20AC trademark:2122 partialdiff:2202 Delta:2206 product:220F summation:2211 minus:2212 ' +
  'radical:221A infinity:221E integral:222B approxequal:2248 notequal:2260 lessequal:2264 ' +
  'greaterequal:2265 lozenge:25CA fi:FB01 fl:FB02';

const GLYPH_TO_CHAR: Map<string, string> = (() => {
  const map = new Map<string, string>();
  for (const pair of GLYPH_PAIRS.split(' ')) {
    const at = pair.indexOf(':');
    if (at <= 0) continue;
    map.set(pair.slice(0, at), String.fromCodePoint(Number.parseInt(pair.slice(at + 1), 16)));
  }
  // A-Z, a-z and the digits are their own glyph names.
  for (let c = 0x41; c <= 0x5a; c++) map.set(String.fromCharCode(c), String.fromCharCode(c));
  for (let c = 0x61; c <= 0x7a; c++) map.set(String.fromCharCode(c), String.fromCharCode(c));
  return map;
})();

/**
 * A glyph name to the character it names, or `undefined` when we do not know.
 * `undefined` is a real answer here — see the header.
 */
export function glyphNameToChar(name: string): string | undefined {
  const known = GLYPH_TO_CHAR.get(name);
  if (known) return known;
  // `uniXXXX` and `uXXXXXX` state their own code point.
  if (/^uni[0-9A-Fa-f]{4}$/.test(name)) {
    return String.fromCodePoint(Number.parseInt(name.slice(3), 16));
  }
  if (/^u[0-9A-Fa-f]{4,6}$/.test(name)) {
    const code = Number.parseInt(name.slice(1), 16);
    if (code <= 0x10ffff) return String.fromCodePoint(code);
  }
  // A name with a suffix (`a.sc`, `one.oldstyle`) still names its base glyph.
  const dot = name.indexOf('.');
  if (dot > 0) return GLYPH_TO_CHAR.get(name.slice(0, dot));
  return undefined;
}

/** The 0x80–0x9F block is the only place WinAnsi differs from Latin-1. */
const WIN_ANSI_HIGH = [
  'Euro', '', 'quotesinglbase', 'florin', 'quotedblbase', 'ellipsis', 'dagger', 'daggerdbl',
  'circumflex', 'perthousand', 'Scaron', 'guilsinglleft', 'OE', '', 'Zcaron', '',
  '', 'quoteleft', 'quoteright', 'quotedblleft', 'quotedblright', 'bullet', 'endash', 'emdash',
  'tilde', 'trademark', 'scaron', 'guilsinglright', 'oe', '', 'zcaron', 'Ydieresis',
];

/** MacRomanEncoding, 0x80–0xFF, by glyph name. Gaps stay undecodable on purpose. */
const MAC_ROMAN_HIGH = [
  'Adieresis', 'Aring', 'Ccedilla', 'Eacute', 'Ntilde', 'Odieresis', 'Udieresis', 'aacute',
  'agrave', 'acircumflex', 'adieresis', 'atilde', 'aring', 'ccedilla', 'eacute', 'egrave',
  'ecircumflex', 'edieresis', 'iacute', 'igrave', 'icircumflex', 'idieresis', 'ntilde', 'oacute',
  'ograve', 'ocircumflex', 'odieresis', 'otilde', 'uacute', 'ugrave', 'ucircumflex', 'udieresis',
  'dagger', 'degree', 'cent', 'sterling', 'section', 'bullet', 'paragraph', 'germandbls',
  'registered', 'copyright', 'trademark', 'acute', 'dieresis', 'notequal', 'AE', 'Oslash',
  'infinity', 'plusminus', 'lessequal', 'greaterequal', 'yen', 'mu', 'partialdiff', 'summation',
  'product', 'pi', 'integral', 'ordfeminine', 'ordmasculine', 'Omega', 'ae', 'oslash',
  'questiondown', 'exclamdown', 'logicalnot', 'radical', 'florin', 'approxequal', 'Delta',
  'guillemotleft', 'guillemotright', 'ellipsis', 'space', 'Agrave', 'Atilde', 'Otilde', 'OE', 'oe',
  'endash', 'emdash', 'quotedblleft', 'quotedblright', 'quoteleft', 'quoteright', 'divide',
  'lozenge', 'ydieresis', 'Ydieresis', 'fraction', 'currency', 'guilsinglleft', 'guilsinglright',
  'fi', 'fl',
  'daggerdbl', 'periodcentered', 'quotesinglbase', 'quotedblbase', 'perthousand', 'Acircumflex',
  'Ecircumflex', 'Aacute', 'Edieresis', 'Egrave', 'Iacute', 'Icircumflex', 'Idieresis', 'Igrave',
  'Oacute', 'Ocircumflex', '', 'Ograve', 'Uacute', 'Ucircumflex', 'Ugrave', 'dotlessi',
  'circumflex', 'tilde', 'macron', 'breve', 'dotaccent', 'ring', 'cedilla', 'hungarumlaut',
  'ogonek', 'caron',
];

/** StandardEncoding above 0x7E — sparse, and the gaps are genuinely unassigned. */
const STANDARD_HIGH: Record<number, string> = {
  0xa1: 'exclamdown', 0xa2: 'cent', 0xa3: 'sterling', 0xa4: 'fraction', 0xa5: 'yen',
  0xa6: 'florin', 0xa7: 'section', 0xa8: 'currency', 0xa9: 'quotesingle', 0xaa: 'quotedblleft',
  0xab: 'guillemotleft', 0xac: 'guilsinglleft', 0xad: 'guilsinglright', 0xae: 'fi', 0xaf: 'fl',
  0xb1: 'endash', 0xb2: 'dagger', 0xb3: 'daggerdbl', 0xb4: 'periodcentered', 0xb6: 'paragraph',
  0xb7: 'bullet', 0xb8: 'quotesinglbase', 0xb9: 'quotedblbase', 0xba: 'quotedblright',
  0xbb: 'guillemotright', 0xbc: 'ellipsis', 0xbd: 'perthousand', 0xbf: 'questiondown',
  0xc1: 'grave', 0xc2: 'acute', 0xc3: 'circumflex', 0xc4: 'tilde', 0xc5: 'macron', 0xc6: 'breve',
  0xc7: 'dotaccent', 0xc8: 'dieresis', 0xca: 'ring', 0xcb: 'cedilla', 0xcd: 'hungarumlaut',
  0xce: 'ogonek', 0xcf: 'caron', 0xd0: 'emdash', 0xe1: 'AE', 0xe3: 'ordfeminine', 0xe8: 'Lslash',
  0xe9: 'Oslash', 0xea: 'OE', 0xeb: 'ordmasculine', 0xf1: 'ae', 0xf5: 'dotlessi', 0xf8: 'lslash',
  0xf9: 'oslash', 0xfa: 'oe', 0xfb: 'germandbls',
};

export type BaseEncodingName = 'WinAnsiEncoding' | 'MacRomanEncoding' | 'StandardEncoding' | 'MacExpertEncoding';

/**
 * A base encoding as a code → character table. Codes with no assignment are
 * absent from the map rather than mapped to something plausible.
 */
export function baseEncodingTable(name: BaseEncodingName): Map<number, string> {
  const table = new Map<number, string>();
  if (name === 'MacExpertEncoding') return table; // old-style figures; no honest Latin mapping

  for (let code = 0x20; code <= 0x7e; code++) table.set(code, String.fromCharCode(code));
  if (name === 'StandardEncoding') {
    // Standard is the one that reassigns the ASCII quotes to typographic ones.
    table.set(0x27, '’');
    table.set(0x60, '‘');
    for (const [code, glyph] of Object.entries(STANDARD_HIGH)) {
      const ch = glyphNameToChar(glyph);
      if (ch) table.set(Number(code), ch);
    }
    return table;
  }
  if (name === 'WinAnsiEncoding') {
    for (let i = 0; i < WIN_ANSI_HIGH.length; i++) {
      const ch = WIN_ANSI_HIGH[i] ? glyphNameToChar(WIN_ANSI_HIGH[i]) : undefined;
      if (ch) table.set(0x80 + i, ch);
    }
    for (let code = 0xa0; code <= 0xff; code++) table.set(code, String.fromCharCode(code));
    return table;
  }
  for (let i = 0; i < MAC_ROMAN_HIGH.length; i++) {
    const ch = MAC_ROMAN_HIGH[i] ? glyphNameToChar(MAC_ROMAN_HIGH[i]) : undefined;
    if (ch) table.set(0x80 + i, ch);
  }
  return table;
}

export interface CMapData {
  /** Code → the string it stands for. */
  map: Map<number, string>;
  /** Byte widths seen in `begincodespacerange`; empty when the CMap declared none. */
  codeWidths: Set<number>;
}

/**
 * Parse a `/ToUnicode` CMap.
 *
 * Only the two constructs that carry text are read — `bfchar` (one code, one
 * destination) and `bfrange` (a code range mapped to a starting value or to an
 * explicit array). Destinations are UTF-16BE, which is what makes a surrogate
 * pair or a ligature expansion come out as the several characters it is.
 *
 * The scan is index-based rather than regex-based: this runs on
 * attacker-controlled bytes and a bounded hand-written scanner cannot backtrack.
 */
export function parseCMap(text: string, maxEntries = 65_536): CMapData {
  const map = new Map<number, string>();
  const codeWidths = new Set<number>();
  let entries = 0;

  let at = 0;
  while (at < text.length && entries < maxEntries) {
    const bfchar = text.indexOf('beginbfchar', at);
    const bfrange = text.indexOf('beginbfrange', at);
    const space = text.indexOf('begincodespacerange', at);
    const next = smallestNonNegative([bfchar, bfrange, space]);
    if (next < 0) break;

    if (next === space) {
      const end = text.indexOf('endcodespacerange', next);
      const body = text.slice(next + 19, end < 0 ? text.length : end);
      for (const token of hexTokens(body, 64)) codeWidths.add(Math.max(1, Math.ceil(token.digits / 2)));
      at = end < 0 ? text.length : end + 17;
      continue;
    }
    if (next === bfchar) {
      const end = text.indexOf('endbfchar', next);
      const body = text.slice(next + 11, end < 0 ? text.length : end);
      const tokens = [...hexTokens(body, maxEntries * 2)];
      for (let i = 0; i + 1 < tokens.length; i += 2) {
        map.set(tokens[i].value, utf16BeToString(tokens[i + 1].hex));
        if (++entries >= maxEntries) break;
      }
      at = end < 0 ? text.length : end + 9;
      continue;
    }
    const end = text.indexOf('endbfrange', next);
    const body = text.slice(next + 12, end < 0 ? text.length : end);
    entries += readBfRange(body, map, maxEntries - entries);
    at = end < 0 ? text.length : end + 10;
  }
  return { map, codeWidths };
}

function smallestNonNegative(values: number[]): number {
  let best = -1;
  for (const v of values) {
    if (v < 0) continue;
    if (best < 0 || v < best) best = v;
  }
  return best;
}

interface HexToken {
  hex: string;
  value: number;
  digits: number;
}

/** Yield `<hex>` tokens from a CMap body, bounded by count. */
function* hexTokens(body: string, limit: number): Generator<HexToken> {
  let i = 0;
  let count = 0;
  while (i < body.length && count < limit) {
    const open = body.indexOf('<', i);
    if (open < 0) return;
    const close = body.indexOf('>', open + 1);
    if (close < 0) return;
    const hex = body.slice(open + 1, close).replace(/[^0-9A-Fa-f]/g, '');
    i = close + 1;
    if (hex.length === 0 || hex.length > 512) continue;
    count++;
    yield { hex, value: Number.parseInt(hex.slice(0, 8), 16) || 0, digits: hex.length };
  }
}

/**
 * `bfrange` comes in two shapes: `<lo> <hi> <dst>` (consecutive destinations)
 * and `<lo> <hi> [<d1> <d2> …]` (an explicit list). Both are read line-wise so
 * a malformed entry costs one range, not the file.
 */
function readBfRange(body: string, map: Map<number, string>, budget: number): number {
  let added = 0;
  let i = 0;
  while (i < body.length && added < budget) {
    const loTok = nextHex(body, i);
    if (!loTok) break;
    const hiTok = nextHex(body, loTok.end);
    if (!hiTok) break;
    const arrayAt = body.indexOf('[', hiTok.end);
    const nextHexAt = body.indexOf('<', hiTok.end);
    const useArray = arrayAt >= 0 && (nextHexAt < 0 || arrayAt < nextHexAt);
    const lo = loTok.token.value;
    const hi = Math.min(hiTok.token.value, lo + 65_535);

    if (useArray) {
      const close = body.indexOf(']', arrayAt);
      const inner = body.slice(arrayAt + 1, close < 0 ? body.length : close);
      let code = lo;
      for (const token of hexTokens(inner, hi - lo + 1)) {
        map.set(code, utf16BeToString(token.hex));
        code++;
        if (++added >= budget) break;
      }
      i = close < 0 ? body.length : close + 1;
      continue;
    }

    const dst = nextHex(body, hiTok.end);
    if (!dst) break;
    const prefix = dst.token.hex.length > 4 ? dst.token.hex.slice(0, dst.token.hex.length - 4) : '';
    const tail = Number.parseInt(dst.token.hex.slice(-4), 16) || 0;
    for (let code = lo; code <= hi; code++) {
      const unit = (tail + (code - lo)) & 0xffff;
      map.set(code, utf16BeToString(prefix + unit.toString(16).padStart(4, '0')));
      if (++added >= budget) break;
    }
    i = dst.end;
  }
  return added;
}

function nextHex(body: string, from: number): { token: HexToken; end: number } | null {
  const open = body.indexOf('<', from);
  if (open < 0) return null;
  const close = body.indexOf('>', open + 1);
  if (close < 0) return null;
  const hex = body.slice(open + 1, close).replace(/[^0-9A-Fa-f]/g, '');
  if (hex.length === 0 || hex.length > 512) return null;
  return {
    token: { hex, value: Number.parseInt(hex.slice(0, 8), 16) || 0, digits: hex.length },
    end: close + 1,
  };
}

/** UTF-16BE hex digits to the string they encode, surrogate pairs included. */
export function utf16BeToString(hex: string): string {
  const clean = hex.length % 4 === 0 ? hex : hex.padStart(Math.ceil(hex.length / 4) * 4, '0');
  const units: number[] = [];
  for (let i = 0; i + 3 < clean.length; i += 4) {
    const unit = Number.parseInt(clean.slice(i, i + 4), 16);
    if (Number.isFinite(unit)) units.push(unit);
  }
  if (units.length === 0) return '';
  try {
    return String.fromCharCode(...units);
  } catch {
    return '';
  }
}
