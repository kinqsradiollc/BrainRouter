/**
 * ADR-030 D1 — the PDF object grammar: numbers, names, strings, arrays,
 * dictionaries, streams and indirect references.
 *
 * Everything above this file (fonts, page tree, content streams) is a reader of
 * these eight shapes, so the grammar lives in exactly one place and is the only
 * code that touches raw offsets.
 *
 * Two deliberate choices:
 *
 *  - **The source is a `latin1` string, the payloads are `Buffer`s.** latin1 is
 *    a byte-for-byte round trip, so a character index IS a byte offset and the
 *    scanner can use fast string search while stream bytes stay exact.
 *  - **Strings are bytes, not text.** A PDF string is a byte sequence whose
 *    meaning depends on a font's encoding; decoding it here — before the font
 *    is known — is precisely the mistake that produces plausible-looking wrong
 *    letters, so `str` carries a Buffer and `fonts.ts` decides what it says.
 *
 * Nothing here throws: a malformed construct returns `null` and the caller
 * keeps whatever it already had.
 */
import { noteLimit, outOfTime, type PdfBudget } from './limits.js';

export type PdfDict = Map<string, PdfObject>;

export type PdfObject =
  | { t: 'null' }
  | { t: 'bool'; v: boolean }
  | { t: 'num'; v: number }
  | { t: 'str'; v: Buffer }
  | { t: 'name'; v: string }
  | { t: 'array'; v: PdfObject[] }
  | { t: 'dict'; v: PdfDict }
  /** A stream's bytes are not sliced until someone asks — `dataStart` is where they begin. */
  | { t: 'stream'; v: PdfDict; dataStart: number }
  | { t: 'ref'; num: number; gen: number };

export const PDF_NULL: PdfObject = { t: 'null' };

/** Arrays this long are structure, not data; past it we stop collecting. */
const MAX_ARRAY_ITEMS = 65_536;
const MAX_DICT_ENTRIES = 4_096;

export function isWhite(code: number): boolean {
  return code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09 || code === 0x0c || code === 0x00;
}

export function isDelimiter(code: number): boolean {
  return (
    code === 0x28 || code === 0x29 || code === 0x3c || code === 0x3e || code === 0x5b ||
    code === 0x5d || code === 0x7b || code === 0x7d || code === 0x2f || code === 0x25
  );
}

/** Advance past whitespace and `%` comments. */
export function skipWhite(src: string, i: number, end: number): number {
  let p = i;
  while (p < end) {
    const c = src.charCodeAt(p);
    if (isWhite(c)) {
      p++;
      continue;
    }
    if (c === 0x25) {
      // Comment — runs to the end of the line.
      while (p < end && src.charCodeAt(p) !== 0x0a && src.charCodeAt(p) !== 0x0d) p++;
      continue;
    }
    return p;
  }
  return end;
}

/** Read a regular (non-delimiter, non-space) token such as an operator keyword. */
export function readToken(src: string, i: number, end: number): { token: string; end: number } {
  let p = i;
  while (p < end) {
    const c = src.charCodeAt(p);
    if (isWhite(c) || isDelimiter(c)) break;
    p++;
  }
  return { token: src.slice(i, p), end: p };
}

function readName(src: string, i: number, end: number): { obj: PdfObject; end: number } {
  // `i` points at '/'. Names use `#xx` for bytes that would otherwise be syntax.
  let p = i + 1;
  let out = '';
  while (p < end) {
    const c = src.charCodeAt(p);
    if (isWhite(c) || isDelimiter(c)) break;
    if (c === 0x23 && p + 2 < end) {
      const hex = src.slice(p + 1, p + 3);
      const code = Number.parseInt(hex, 16);
      if (Number.isFinite(code) && /^[0-9a-fA-F]{2}$/.test(hex)) {
        out += String.fromCharCode(code);
        p += 3;
        continue;
      }
    }
    out += src[p];
    p++;
  }
  return { obj: { t: 'name', v: out }, end: p };
}

/**
 * Read a `(...)` literal string into its bytes, resolving PDF escapes.
 * Balanced inner parens count, and an unterminated literal ends at `end`
 * rather than running the scanner off a cliff.
 */
export function readLiteralString(src: string, i: number, end: number): { bytes: Buffer; end: number } {
  const out: number[] = [];
  let depth = 1;
  let p = i + 1;
  while (p < end) {
    const ch = src[p];
    if (ch === '\\') {
      const next = src[p + 1];
      if (next === undefined) break;
      switch (next) {
        case 'n': out.push(0x0a); p += 2; break;
        case 'r': out.push(0x0d); p += 2; break;
        case 't': out.push(0x09); p += 2; break;
        case 'b': out.push(0x08); p += 2; break;
        case 'f': out.push(0x0c); p += 2; break;
        case '(': out.push(0x28); p += 2; break;
        case ')': out.push(0x29); p += 2; break;
        case '\\': out.push(0x5c); p += 2; break;
        case '\n': p += 2; break; // line continuation
        case '\r': p += (src[p + 2] === '\n' ? 3 : 2); break;
        default: {
          if (next >= '0' && next <= '7') {
            let oct = '';
            let q = p + 1;
            while (q < end && oct.length < 3 && src[q] >= '0' && src[q] <= '7') {
              oct += src[q];
              q++;
            }
            out.push(Number.parseInt(oct, 8) & 0xff);
            p = q;
          } else {
            // Unknown escape: the spec drops the backslash and keeps the byte.
            out.push(src.charCodeAt(p + 1) & 0xff);
            p += 2;
          }
          break;
        }
      }
      continue;
    }
    if (ch === '(') {
      depth++;
      out.push(0x28);
      p++;
      continue;
    }
    if (ch === ')') {
      depth--;
      if (depth === 0) return { bytes: Buffer.from(out), end: p + 1 };
      out.push(0x29);
      p++;
      continue;
    }
    out.push(src.charCodeAt(p) & 0xff);
    p++;
  }
  return { bytes: Buffer.from(out), end };
}

/** Read a `<...>` hex string. An odd trailing digit is padded with 0, per spec. */
export function readHexString(src: string, i: number, end: number): { bytes: Buffer; end: number } {
  const out: number[] = [];
  let p = i + 1;
  let hi = -1;
  while (p < end) {
    const ch = src[p];
    if (ch === '>') {
      p++;
      break;
    }
    const d = hexDigit(ch);
    if (d >= 0) {
      if (hi < 0) hi = d;
      else {
        out.push((hi << 4) | d);
        hi = -1;
      }
    }
    p++;
  }
  if (hi >= 0) out.push(hi << 4);
  return { bytes: Buffer.from(out), end: p };
}

function hexDigit(ch: string | undefined): number {
  if (ch === undefined) return -1;
  const c = ch.charCodeAt(0);
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  return -1;
}

function isNumberStart(ch: string): boolean {
  return (ch >= '0' && ch <= '9') || ch === '+' || ch === '-' || ch === '.';
}

/**
 * Parse one object at `i`.
 *
 * `allowStream` is false inside content streams and arrays: only a top-level
 * indirect object can be followed by the `stream` keyword, and honouring it
 * anywhere else lets a crafted array swallow the rest of the file.
 */
export function parseObjectAt(
  src: string,
  i: number,
  end: number,
  budget: PdfBudget,
  depth = 0,
  allowStream = false,
): { obj: PdfObject; end: number } | null {
  if (depth > budget.bounds.maxDepth) {
    noteLimit(budget, 'depth');
    return null;
  }
  const p = skipWhite(src, i, end);
  if (p >= end) return null;
  const ch = src[p];

  if (ch === '/') return readName(src, p, end);

  if (ch === '(') {
    const lit = readLiteralString(src, p, end);
    return { obj: { t: 'str', v: lit.bytes }, end: lit.end };
  }

  if (ch === '<') {
    if (src[p + 1] === '<') return parseDict(src, p, end, budget, depth, allowStream);
    const hex = readHexString(src, p, end);
    return { obj: { t: 'str', v: hex.bytes }, end: hex.end };
  }

  if (ch === '[') {
    const items: PdfObject[] = [];
    let q = p + 1;
    while (q < end) {
      q = skipWhite(src, q, end);
      if (src[q] === ']') return { obj: { t: 'array', v: items }, end: q + 1 };
      const item = parseObjectAt(src, q, end, budget, depth + 1, false);
      if (!item || item.end <= q) return { obj: { t: 'array', v: items }, end: q + 1 };
      if (items.length < MAX_ARRAY_ITEMS) items.push(item.obj);
      q = item.end;
    }
    return { obj: { t: 'array', v: items }, end };
  }

  if (ch === ']' || ch === '>' || ch === ')' || ch === '}' || ch === '{') {
    // Stray delimiter — consume it so the caller cannot spin on the same index.
    return { obj: PDF_NULL, end: p + 1 };
  }

  if (isNumberStart(ch)) {
    const tok = readToken(src, p, end);
    const value = Number.parseFloat(tok.token);
    const num: PdfObject = { t: 'num', v: Number.isFinite(value) ? value : 0 };
    // `<int> <int> R` is an indirect reference; anything else is just a number.
    if (Number.isInteger(value) && value >= 0 && !tok.token.includes('.')) {
      const genAt = skipWhite(src, tok.end, end);
      if (genAt < end && src[genAt] >= '0' && src[genAt] <= '9') {
        const genTok = readToken(src, genAt, end);
        const gen = Number.parseInt(genTok.token, 10);
        if (Number.isInteger(gen)) {
          const rAt = skipWhite(src, genTok.end, end);
          const after = src.charCodeAt(rAt + 1);
          if (src[rAt] === 'R' && (rAt + 1 >= end || isWhite(after) || isDelimiter(after))) {
            return { obj: { t: 'ref', num: value, gen }, end: rAt + 1 };
          }
        }
      }
    }
    return { obj: num, end: tok.end };
  }

  const tok = readToken(src, p, end);
  if (tok.token.length === 0) return { obj: PDF_NULL, end: p + 1 };
  if (tok.token === 'true') return { obj: { t: 'bool', v: true }, end: tok.end };
  if (tok.token === 'false') return { obj: { t: 'bool', v: false }, end: tok.end };
  if (tok.token === 'null') return { obj: PDF_NULL, end: tok.end };
  return null; // a keyword (operator, `obj`, `endobj`, …) — the caller decides
}

function parseDict(
  src: string,
  i: number,
  end: number,
  budget: PdfBudget,
  depth: number,
  allowStream: boolean,
): { obj: PdfObject; end: number } | null {
  const dict: PdfDict = new Map();
  let p = i + 2;
  while (p < end) {
    p = skipWhite(src, p, end);
    if (src[p] === '>' && src[p + 1] === '>') {
      p += 2;
      break;
    }
    if (src[p] !== '/') {
      // Not a key — skip a value-shaped token so a broken dict still terminates.
      const junk = parseObjectAt(src, p, end, budget, depth + 1, false);
      if (!junk || junk.end <= p) {
        const tok = readToken(src, p, end);
        p = tok.end > p ? tok.end : p + 1;
        continue;
      }
      p = junk.end;
      continue;
    }
    const key = readName(src, p, end);
    const value = parseObjectAt(src, key.end, end, budget, depth + 1, false);
    if (!value || value.end <= key.end) {
      // A key whose value is a bare keyword — skip the keyword and carry on.
      const skipTo = skipWhite(src, key.end, end);
      const tok = readToken(src, skipTo, end);
      p = tok.end > key.end ? tok.end : key.end + 1;
      continue;
    }
    if (dict.size < MAX_DICT_ENTRIES && key.obj.t === 'name') dict.set(key.obj.v, value.obj);
    p = value.end;
  }

  if (allowStream) {
    const after = skipWhite(src, p, end);
    if (src.startsWith('stream', after)) {
      let dataStart = after + 6;
      // The keyword is followed by CRLF or LF — never by CR alone, per spec, but
      // real writers emit CR alone anyway.
      if (src[dataStart] === '\r') dataStart++;
      if (src[dataStart] === '\n') dataStart++;
      return { obj: { t: 'stream', v: dict, dataStart }, end: dataStart };
    }
  }
  return { obj: { t: 'dict', v: dict }, end: p };
}

/** Number value of an object, or `undefined` when it is not a number. */
export function numberOf(obj: PdfObject | undefined): number | undefined {
  return obj && obj.t === 'num' && Number.isFinite(obj.v) ? obj.v : undefined;
}

/** Name value of an object, or `undefined`. */
export function nameOf(obj: PdfObject | undefined): string | undefined {
  return obj && obj.t === 'name' ? obj.v : undefined;
}

/** The dictionary of a `dict` or a `stream` object. */
export function dictOf(obj: PdfObject | undefined): PdfDict | undefined {
  if (!obj) return undefined;
  if (obj.t === 'dict' || obj.t === 'stream') return obj.v;
  return undefined;
}

/**
 * Scan a whole file for `<num> <gen> obj` headers.
 *
 * We reconstruct the object map by scanning rather than by reading the
 * cross-reference table, because a damaged or hostile xref is exactly the case
 * that must not stop us — and a scan is what a repair pass would do anyway. A
 * later definition of the same object number wins, which is how incremental
 * updates behave.
 */
export function scanIndirectObjects(src: string, budget: PdfBudget): Map<number, number> {
  const found = new Map<number, number>();
  // Bounded quantifiers only: this runs over attacker-controlled bytes and the
  // repo has already paid for one polynomial-backtracking alert.
  const re = /(\d{1,10})[\x00\t\r\n\f ]{1,8}(\d{1,5})[\x00\t\r\n\f ]{1,8}obj\b/g;
  let match: RegExpExecArray | null;
  let scanned = 0;
  while ((match = re.exec(src)) !== null) {
    const num = Number.parseInt(match[1], 10);
    if (Number.isInteger(num)) found.set(num, match.index + match[0].length);
    scanned++;
    if (scanned > budget.bounds.maxObjects) {
      noteLimit(budget, 'objects');
      break;
    }
    if ((scanned & 0x3ff) === 0 && outOfTime(budget)) break;
  }
  return found;
}
