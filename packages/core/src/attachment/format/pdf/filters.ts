/**
 * ADR-030 D1 — stream filters, the thing this module was said to need a
 * dependency for.
 *
 * It never did. `node:zlib` is a Node builtin and `inflateSync` is FlateDecode,
 * which is what all but a rounding error of real content streams use. The one
 * sentence claiming otherwise is why attachments shipped scavenged binary for
 * a release; the fix is this file.
 *
 * Implemented: FlateDecode (with the PNG and TIFF `/DecodeParms` predictors),
 * LZWDecode, ASCIIHexDecode, ASCII85Decode, RunLengthDecode. Not implemented,
 * deliberately: the image codecs (DCT, JPX, CCITTFax, JBIG2) and `/Crypt` —
 * they do not carry text, and a page whose content decodes to an image is a
 * fact the classifier above wants to keep, not an error to swallow.
 *
 * Every decoder is bounded by the budget and returns `null` rather than
 * throwing, including on truncated input: `Z_SYNC_FLUSH` makes zlib hand back
 * the bytes it did manage on a stream that stops mid-block, which is common in
 * files whose `/Length` lies.
 */
import zlib from 'node:zlib';
import { inflateAllowance, noteLimit, spendInflate, type PdfBudget } from './limits.js';
import { dictOf, nameOf, numberOf, type PdfDict, type PdfObject } from './objects.js';

/** Filters that carry image data — a text extractor stops at them on purpose. */
const IMAGE_FILTERS = new Set(['DCTDecode', 'DCT', 'JPXDecode', 'CCITTFaxDecode', 'CCF', 'JBIG2Decode']);

export interface FilterResult {
  data: Buffer | null;
  /** True when the stream stopped at a filter we do not decode (an image codec). */
  image: boolean;
}

/**
 * Run a stream's `/Filter` chain over its raw bytes.
 *
 * `resolve` follows indirect references, because `/Filter` and `/DecodeParms`
 * are both allowed to be references and real writers use that.
 */
export function applyFilters(
  raw: Buffer,
  dict: PdfDict,
  resolve: (obj: PdfObject | undefined) => PdfObject | undefined,
  budget: PdfBudget,
): FilterResult {
  const filterObj = resolve(dict.get('Filter') ?? dict.get('F'));
  const parmsObj = resolve(dict.get('DecodeParms') ?? dict.get('DP'));

  const filters: string[] = [];
  if (filterObj?.t === 'name') filters.push(filterObj.v);
  else if (filterObj?.t === 'array') {
    for (const entry of filterObj.v) {
      const name = nameOf(resolve(entry));
      if (name) filters.push(name);
    }
  }

  const parms: (PdfDict | undefined)[] = [];
  if (parmsObj?.t === 'array') for (const entry of parmsObj.v) parms.push(dictOf(resolve(entry)));
  else parms.push(dictOf(parmsObj));

  let data: Buffer | null = raw;
  for (let i = 0; i < filters.length && data; i++) {
    const name = filters[i];
    if (IMAGE_FILTERS.has(name)) return { data: null, image: true };
    data = applyOne(name, data, parms[i], resolve, budget);
  }
  return { data, image: false };
}

function applyOne(
  name: string,
  data: Buffer,
  parms: PdfDict | undefined,
  resolve: (obj: PdfObject | undefined) => PdfObject | undefined,
  budget: PdfBudget,
): Buffer | null {
  switch (name) {
    case 'FlateDecode':
    case 'Fl':
      return predict(inflate(data, budget), parms, resolve, budget);
    case 'LZWDecode':
    case 'LZW':
      return predict(lzwDecode(data, parms, resolve, budget), parms, resolve, budget);
    case 'ASCIIHexDecode':
    case 'AHx':
      return asciiHexDecode(data);
    case 'ASCII85Decode':
    case 'A85':
      return ascii85Decode(data, budget);
    case 'RunLengthDecode':
    case 'RL':
      return runLengthDecode(data, budget);
    case 'Crypt':
      // Only the identity crypt filter is legal without /Encrypt, and an
      // encrypted document is refused earlier with a reason.
      return data;
    default:
      return null;
  }
}

/**
 * Inflate, with the cap enforced by zlib itself.
 *
 * `maxOutputLength` means a decompression bomb is refused *before* the memory
 * is allocated — checking the size afterwards would already have paid for it.
 */
function inflate(data: Buffer, budget: PdfBudget): Buffer | null {
  const allowance = inflateAllowance(budget);
  if (allowance <= 0) return null;
  const options: zlib.ZlibOptions = {
    finishFlush: zlib.constants.Z_SYNC_FLUSH,
    maxOutputLength: allowance,
  };
  let out: Buffer | null = null;
  try {
    out = zlib.inflateSync(data, options);
  } catch {
    // Some writers emit a raw deflate stream, or leave junk before the zlib
    // header. Both are recoverable; a bomb is not, and it fails again here.
    try {
      out = zlib.inflateRawSync(data, options);
    } catch {
      out = null;
    }
  }
  if (!out) {
    noteLimit(budget, 'malformed');
    return null;
  }
  if (out.length >= allowance) noteLimit(budget, 'inflated');
  spendInflate(budget, out.length);
  return out;
}

/**
 * Undo a `/Predictor`. PNG predictors (≥ 10) are per-row filters that reference
 * the row above; TIFF predictor 2 is a horizontal difference. Skipping this
 * step does not fail loudly — it produces subtly wrong bytes — so it is done
 * wherever `/DecodeParms` asks for it.
 */
function predict(
  data: Buffer | null,
  parms: PdfDict | undefined,
  resolve: (obj: PdfObject | undefined) => PdfObject | undefined,
  budget: PdfBudget,
): Buffer | null {
  if (!data || !parms) return data;
  const predictor = numberOf(resolve(parms.get('Predictor'))) ?? 1;
  if (predictor <= 1) return data;
  const colors = clampInt(numberOf(resolve(parms.get('Colors'))) ?? 1, 1, 32);
  const bpc = clampInt(numberOf(resolve(parms.get('BitsPerComponent'))) ?? 8, 1, 32);
  const columns = clampInt(numberOf(resolve(parms.get('Columns'))) ?? 1, 1, 1 << 20);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((colors * bpc * columns) / 8);

  if (predictor === 2) {
    if (bpc !== 8) return data; // sub-byte TIFF prediction is not worth guessing at
    const out = Buffer.from(data);
    for (let row = 0; row + rowLen <= out.length; row += rowLen) {
      for (let i = bpp; i < rowLen; i++) out[row + i] = (out[row + i] + out[row + i - bpp]) & 0xff;
    }
    return out;
  }

  // PNG: each row is prefixed with a filter-type byte.
  const rows = Math.floor(data.length / (rowLen + 1));
  if (rows <= 0) return data;
  const out = Buffer.alloc(rows * rowLen);
  let prev = Buffer.alloc(rowLen);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)];
    const src = data.subarray(r * (rowLen + 1) + 1, r * (rowLen + 1) + 1 + rowLen);
    const cur = out.subarray(r * rowLen, r * rowLen + rowLen);
    src.copy(cur);
    for (let i = 0; i < rowLen; i++) {
      const left = i >= bpp ? cur[i - bpp] : 0;
      const up = prev[i];
      const upLeft = i >= bpp ? prev[i - bpp] : 0;
      switch (type) {
        case 0: break;
        case 1: cur[i] = (cur[i] + left) & 0xff; break;
        case 2: cur[i] = (cur[i] + up) & 0xff; break;
        case 3: cur[i] = (cur[i] + ((left + up) >> 1)) & 0xff; break;
        case 4: cur[i] = (cur[i] + paeth(left, up, upLeft)) & 0xff; break;
        default: break; // unknown filter byte — leave the row as-is
      }
    }
    prev = cur;
  }
  if (rows * (rowLen + 1) < data.length) noteLimit(budget, 'malformed');
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function clampInt(value: number, lo: number, hi: number): number {
  const n = Math.floor(value);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function asciiHexDecode(data: Buffer): Buffer {
  const out: number[] = [];
  let hi = -1;
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    if (c === 0x3e) break; // '>' terminates
    let d = -1;
    if (c >= 0x30 && c <= 0x39) d = c - 0x30;
    else if (c >= 0x61 && c <= 0x66) d = c - 0x57;
    else if (c >= 0x41 && c <= 0x46) d = c - 0x37;
    else continue;
    if (hi < 0) hi = d;
    else {
      out.push((hi << 4) | d);
      hi = -1;
    }
  }
  if (hi >= 0) out.push(hi << 4);
  return Buffer.from(out);
}

function ascii85Decode(data: Buffer, budget: PdfBudget): Buffer | null {
  const allowance = inflateAllowance(budget);
  if (allowance <= 0) return null;
  const out: number[] = [];
  const group: number[] = [];
  let i = 0;
  if (data[0] === 0x3c && data[1] === 0x7e) i = 2; // optional '<~'
  for (; i < data.length; i++) {
    const c = data[i];
    if (c === 0x7e) break; // '~>' terminates
    if (c === 0x7a && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    if (c < 0x21 || c > 0x75) continue; // whitespace and junk
    group.push(c - 0x21);
    if (group.length === 5) {
      pushBase85(out, group, 4);
      group.length = 0;
    }
    if (out.length > allowance) {
      noteLimit(budget, 'inflated');
      return null;
    }
  }
  if (group.length > 1) {
    const n = group.length - 1;
    while (group.length < 5) group.push(84);
    pushBase85(out, group, n);
  }
  spendInflate(budget, out.length);
  return Buffer.from(out);
}

function pushBase85(out: number[], group: number[], take: number): void {
  let value = 0;
  for (let k = 0; k < 5; k++) value = value * 85 + group[k];
  const bytes = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
  for (let k = 0; k < take; k++) out.push(bytes[k]);
}

function runLengthDecode(data: Buffer, budget: PdfBudget): Buffer | null {
  const allowance = inflateAllowance(budget);
  if (allowance <= 0) return null;
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    const len = data[i];
    if (len === 128) break; // EOD
    if (len < 128) {
      for (let k = 0; k <= len && i + 1 + k < data.length; k++) out.push(data[i + 1 + k]);
      i += len + 2;
    } else {
      const byte = data[i + 1];
      if (byte === undefined) break;
      for (let k = 0; k < 257 - len; k++) out.push(byte);
      i += 2;
    }
    if (out.length > allowance) {
      noteLimit(budget, 'inflated');
      return null;
    }
  }
  spendInflate(budget, out.length);
  return Buffer.from(out);
}

/**
 * LZW as PDF uses it: variable code width 9–12 bits, MSB-first, with the
 * `/EarlyChange` quirk on by default. Kept because it is one small loop and
 * because the files that still use it (older scanners, some archives) are
 * exactly the ones nobody will re-export.
 */
function lzwDecode(
  data: Buffer,
  parms: PdfDict | undefined,
  resolve: (obj: PdfObject | undefined) => PdfObject | undefined,
  budget: PdfBudget,
): Buffer | null {
  const allowance = inflateAllowance(budget);
  if (allowance <= 0) return null;
  const earlyChange = parms ? (numberOf(resolve(parms.get('EarlyChange'))) ?? 1) : 1;
  const dict: (number[] | undefined)[] = new Array(4096);
  const reset = (): void => {
    for (let i = 0; i < 256; i++) dict[i] = [i];
    dict.length = 4096;
    for (let i = 256; i < 4096; i++) dict[i] = undefined;
  };
  reset();
  let next = 258;
  let width = 9;
  let prev: number[] | undefined;
  const out: number[] = [];
  let bitBuf = 0;
  let bitCount = 0;

  for (let i = 0; i <= data.length; i++) {
    if (i < data.length) {
      bitBuf = ((bitBuf << 8) | data[i]) >>> 0;
      bitCount += 8;
    } else if (bitCount < width) break;
    while (bitCount >= width) {
      const code = (bitBuf >>> (bitCount - width)) & ((1 << width) - 1);
      bitCount -= width;
      if (code === 256) {
        reset();
        next = 258;
        width = 9;
        prev = undefined;
        continue;
      }
      if (code === 257) return finishLzw(out, budget);
      let entry: number[] | undefined;
      if (code < next && dict[code]) entry = dict[code];
      else if (prev) entry = [...prev, prev[0]];
      if (!entry) return finishLzw(out, budget);
      for (const byte of entry) out.push(byte);
      if (out.length > allowance) {
        noteLimit(budget, 'inflated');
        return null;
      }
      if (prev && next < 4096) {
        dict[next] = [...prev, entry[0]];
        next++;
      }
      prev = entry;
      const limit = next + (earlyChange ? 1 : 0);
      if (limit >= 512 && width === 9) width = 10;
      else if (limit >= 1024 && width === 10) width = 11;
      else if (limit >= 2048 && width === 11) width = 12;
    }
  }
  return finishLzw(out, budget);
}

function finishLzw(out: number[], budget: PdfBudget): Buffer {
  spendInflate(budget, out.length);
  return Buffer.from(out);
}
