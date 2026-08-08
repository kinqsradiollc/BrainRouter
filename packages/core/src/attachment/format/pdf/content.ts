/**
 * ADR-030 D1 — the content stream walk: operators in, positioned runs out.
 *
 * A PDF does not store text, it stores instructions that put glyphs at
 * coordinates. So this file is an interpreter for the subset of those
 * instructions that move or show text — `BT`/`ET`, `Tf`, `Td`/`TD`/`Tm`/`T*`,
 * `TL`/`Tc`/`Tw`/`Tz`/`Ts`, `Tj`/`TJ`/`'`/`"` — plus the graphics state
 * (`q`/`Q`/`cm`) they sit inside, because a page that scales or rotates its
 * content puts the text somewhere else entirely.
 *
 * Two things it does beyond decoding:
 *
 *  - **Form XObjects are followed.** A `Do` that draws a form is a nested
 *    content stream, and for whole families of writers that is where all the
 *    text is. Bounded by depth and by a visit set, since forms can recurse.
 *  - **A kern is read as a space when it is wide enough.** `TJ` arrays are how
 *    most writers set inter-word gaps, so a parser that ignores the numbers
 *    returns everyrunjoinedlikethis.
 *
 * Inline images (`BI … ID … EI`) are skipped as binary rather than tokenised —
 * their payload is not object syntax and lexing it is how a parser gets lost.
 */
import { get, resolve, streamBytes, type PdfDoc, type PdfPageNode } from './document.js';
import { buildFont, decodeString, fontFromResources, UNKNOWN_FONT, type PdfFont } from './fonts.js';
import { noteLimit, outOfTime, type PdfBudget } from './limits.js';
import {
  dictOf, nameOf, numberOf, parseObjectAt, readToken, skipWhite,
  type PdfDict, type PdfObject,
} from './objects.js';
import type { PdfTextItem } from './types.js';

/** [a, b, c, d, e, f] — the PDF transformation matrix. */
type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

/**
 * A `TJ` adjustment wider than this (in 1/1000 em) is a word gap rather than
 * kerning. Kerning pairs live well under 100; writers that space words with
 * `TJ` use 200-plus.
 */
const WORD_GAP_THOUSANDTHS = 180;

/** Operand stacks are tiny in valid content; a huge one is a malformed stream. */
const MAX_OPERANDS = 32;

export interface PageWalkResult {
  items: PdfTextItem[];
  undecodableRuns: number;
  droppedGlyphs: number;
  imageCount: number;
  /**
   * Area of the LARGEST single image drawn, in user-space units².
   *
   * `imageCount` alone cannot tell a scan from a logo, and that gap is a silent
   * wrong answer one layer up: a scanned exhibit with a Bates stamp on it has
   * text and an image, exactly like a cover page with a wordmark on it, and only
   * the size of the picture separates them.
   *
   * The largest rather than the total, deliberately. A scan is ONE image the
   * size of the page, so the maximum identifies it exactly; a sum can be driven
   * to any number by a tiled background drawn a thousand times, which would turn
   * this into a signal an attacker sets.
   */
  maxImageArea: number;
}

interface TextState {
  font: PdfFont;
  fontName: string;
  size: number;
  charSpacing: number;
  wordSpacing: number;
  horizontal: number;
  leading: number;
  rise: number;
}

interface WalkContext {
  doc: PdfDoc;
  budget: PdfBudget;
  fontCache: Map<string, PdfFont>;
  out: PageWalkResult;
  visitedForms: Set<number>;
}

/**
 * Walk one page's content streams and return everything they showed.
 *
 * `overrideContent` exists for the repair passes, which have content to walk
 * but no page dictionary that points at it.
 */
export function walkPage(
  doc: PdfDoc,
  page: PdfPageNode,
  fontCache: Map<string, PdfFont>,
  overrideContent?: string,
): PageWalkResult {
  const out: PageWalkResult = {
    items: [], undecodableRuns: 0, droppedGlyphs: 0, imageCount: 0, maxImageArea: 0,
  };
  const content = overrideContent ?? pageContent(doc, page);
  if (!content) return out;
  const context: WalkContext = { doc, budget: doc.budget, fontCache, out, visitedForms: new Set() };
  runStream(context, content, page.resources, IDENTITY, 0);
  return out;
}

/** Concatenate `/Contents` — it is a stream or an array of them. */
function pageContent(doc: PdfDoc, page: PdfPageNode): string | null {
  const contents = get(doc, page.dict, 'Contents');
  if (!contents) return null;
  if (contents.t === 'stream') {
    const bytes = streamBytes(doc, contents);
    return bytes ? bytes.toString('latin1') : null;
  }
  if (contents.t !== 'array') return null;
  const parts: string[] = [];
  for (const entry of contents.v) {
    if (parts.length > 512) break;
    const bytes = streamBytes(doc, resolve(doc, entry));
    // A newline between parts: the split is allowed to fall mid-operator.
    if (bytes) parts.push(bytes.toString('latin1'));
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

function runStream(
  context: WalkContext,
  src: string,
  resources: PdfDict | undefined,
  baseMatrix: Matrix,
  depth: number,
): void {
  if (depth > 6) {
    noteLimit(context.budget, 'depth');
    return;
  }
  const { budget } = context;
  const ctmStack: Matrix[] = [];
  let ctm: Matrix = baseMatrix;
  let textMatrix: Matrix = IDENTITY;
  let lineMatrix: Matrix = IDENTITY;
  const state: TextState = {
    font: UNKNOWN_FONT,
    fontName: '',
    size: 0,
    charSpacing: 0,
    wordSpacing: 0,
    horizontal: 1,
    leading: 0,
    rise: 0,
  };
  const operands: PdfObject[] = [];
  let i = 0;
  let steps = 0;

  while (i < src.length) {
    if ((++steps & 0x3ff) === 0 && outOfTime(budget)) return;
    i = skipWhite(src, i, src.length);
    if (i >= src.length) break;
    const ch = src[i];

    if (ch === '/' || ch === '(' || ch === '<' || ch === '[' || ch === '+' || ch === '-' || ch === '.' ||
      (ch >= '0' && ch <= '9')) {
      const parsed = parseObjectAt(src, i, src.length, budget, 0, false);
      if (!parsed || parsed.end <= i) {
        i++;
        continue;
      }
      if (operands.length < MAX_OPERANDS) operands.push(parsed.obj);
      i = parsed.end;
      continue;
    }

    const tok = readToken(src, i, src.length);
    if (tok.token.length === 0) {
      i++;
      continue;
    }
    i = tok.end;
    const op = tok.token;

    switch (op) {
      case 'true': operands.push({ t: 'bool', v: true }); continue;
      case 'false': operands.push({ t: 'bool', v: false }); continue;
      case 'null': operands.push({ t: 'null' }); continue;
      case 'q':
        if (ctmStack.length < 64) ctmStack.push(ctm);
        break;
      case 'Q':
        ctm = ctmStack.pop() ?? ctm;
        break;
      case 'cm': {
        const m = matrixOperands(operands);
        if (m) ctm = multiply(m, ctm);
        break;
      }
      case 'BT':
        textMatrix = IDENTITY;
        lineMatrix = IDENTITY;
        break;
      case 'ET':
        break;
      case 'Tf': {
        const size = numberOf(operands[operands.length - 1]);
        const name = nameOf(operands[operands.length - 2]);
        if (size !== undefined) state.size = size;
        if (name !== undefined) {
          state.fontName = name;
          state.font = loadFont(context, resources, name);
        }
        break;
      }
      case 'TL': {
        const v = numberOf(operands[operands.length - 1]);
        if (v !== undefined) state.leading = v;
        break;
      }
      case 'Tc': {
        const v = numberOf(operands[operands.length - 1]);
        if (v !== undefined) state.charSpacing = v;
        break;
      }
      case 'Tw': {
        const v = numberOf(operands[operands.length - 1]);
        if (v !== undefined) state.wordSpacing = v;
        break;
      }
      case 'Tz': {
        const v = numberOf(operands[operands.length - 1]);
        if (v !== undefined) state.horizontal = v / 100;
        break;
      }
      case 'Ts': {
        const v = numberOf(operands[operands.length - 1]);
        if (v !== undefined) state.rise = v;
        break;
      }
      case 'Td': {
        const ty = numberOf(operands[operands.length - 1]) ?? 0;
        const tx = numberOf(operands[operands.length - 2]) ?? 0;
        lineMatrix = multiply([1, 0, 0, 1, tx, ty], lineMatrix);
        textMatrix = lineMatrix;
        break;
      }
      case 'TD': {
        const ty = numberOf(operands[operands.length - 1]) ?? 0;
        const tx = numberOf(operands[operands.length - 2]) ?? 0;
        state.leading = -ty;
        lineMatrix = multiply([1, 0, 0, 1, tx, ty], lineMatrix);
        textMatrix = lineMatrix;
        break;
      }
      case 'Tm': {
        const m = matrixOperands(operands);
        if (m) {
          lineMatrix = m;
          textMatrix = m;
        }
        break;
      }
      case 'T*':
        lineMatrix = multiply([1, 0, 0, 1, 0, -state.leading], lineMatrix);
        textMatrix = lineMatrix;
        break;
      case 'Tj': {
        const str = operands[operands.length - 1];
        if (str?.t === 'str') textMatrix = show(context, state, [str], textMatrix, ctm);
        break;
      }
      case 'TJ': {
        const arr = operands[operands.length - 1];
        if (arr?.t === 'array') textMatrix = show(context, state, arr.v, textMatrix, ctm);
        break;
      }
      case "'": {
        lineMatrix = multiply([1, 0, 0, 1, 0, -state.leading], lineMatrix);
        textMatrix = lineMatrix;
        const str = operands[operands.length - 1];
        if (str?.t === 'str') textMatrix = show(context, state, [str], textMatrix, ctm);
        break;
      }
      case '"': {
        const str = operands[operands.length - 1];
        const ac = numberOf(operands[operands.length - 2]);
        const aw = numberOf(operands[operands.length - 3]);
        if (aw !== undefined) state.wordSpacing = aw;
        if (ac !== undefined) state.charSpacing = ac;
        lineMatrix = multiply([1, 0, 0, 1, 0, -state.leading], lineMatrix);
        textMatrix = lineMatrix;
        if (str?.t === 'str') textMatrix = show(context, state, [str], textMatrix, ctm);
        break;
      }
      case 'Do': {
        const name = nameOf(operands[operands.length - 1]);
        if (name) drawXObject(context, resources, name, ctm, depth);
        break;
      }
      case 'BI': {
        i = skipInlineImage(src, i);
        break;
      }
      default:
        break;
    }
    operands.length = 0;
  }
}

function matrixOperands(operands: PdfObject[]): Matrix | null {
  if (operands.length < 6) return null;
  const values = operands.slice(-6).map((o) => numberOf(o));
  if (values.some((v) => v === undefined)) return null;
  return values as Matrix;
}

function loadFont(context: WalkContext, resources: PdfDict | undefined, name: string): PdfFont {
  const found = fontFromResources(context.doc, resources, name);
  if (!found) return UNKNOWN_FONT;
  const cached = context.fontCache.get(found.cacheKey);
  if (cached) return cached;
  const font = buildFont(context.doc, found.dict, name);
  context.fontCache.set(found.cacheKey, font);
  return font;
}

/**
 * Show a `Tj` string or a `TJ` array as ONE item, and return the advanced text
 * matrix.
 *
 * One item per show operation is the right grain: it is the unit the writer
 * chose, it is what the positioning operators bracket, and splitting it per
 * glyph would multiply the output by twenty for no extra information.
 */
function show(
  context: WalkContext,
  state: TextState,
  parts: PdfObject[],
  textMatrix: Matrix,
  ctm: Matrix,
): Matrix {
  const trm = multiply(textMatrix, ctm);
  const scale = Math.sqrt(Math.abs(trm[0] * trm[3] - trm[1] * trm[2])) || 1;
  const startX = trm[4];
  const startY = trm[5];

  let text = '';
  let dropped = 0;
  let codes = 0;
  let advance = 0; // text-space units, before the matrix scale
  let matrix = textMatrix;

  for (const part of parts) {
    if (part.t === 'num') {
      const adjust = -part.v / 1000;
      advance += adjust * state.size * state.horizontal;
      matrix = multiply([1, 0, 0, 1, adjust * state.size * state.horizontal, 0], matrix);
      if (-part.v >= WORD_GAP_THOUSANDTHS && text.length > 0 && !text.endsWith(' ')) text += ' ';
      continue;
    }
    if (part.t !== 'str') continue;
    const run = decodeString(state.font, part.v);
    text += run.text;
    dropped += run.dropped;
    codes += run.codes.length;
    let width = (run.width / 1000) * state.size;
    width += run.codes.length * state.charSpacing;
    if (!state.font.twoByte) {
      for (const code of run.codes) if (code === 32) width += state.wordSpacing;
    }
    width *= state.horizontal;
    advance += width;
    matrix = multiply([1, 0, 0, 1, width, 0], matrix);
  }

  if (codes === 0) return matrix;
  if (context.out.items.length >= context.budget.bounds.maxObjects) {
    // A page with a hundred thousand show operations is a generator gone wrong
    // or an attempt to make us allocate; either way the pen keeps moving and we
    // stop writing runs down.
    noteLimit(context.budget, 'objects');
    return matrix;
  }
  const undecodable = text.length === 0 && dropped > 0;
  if (undecodable) context.out.undecodableRuns++;
  else context.out.droppedGlyphs += dropped;
  if (text.length === 0 && !undecodable) return matrix;

  const item: PdfTextItem = {
    text,
    x: startX,
    y: startY + state.rise * scale,
    fontSize: Math.abs(state.size * scale),
    fontName: state.font.name || state.fontName,
    width: Math.abs(advance * scale),
  };
  if (undecodable) item.undecodable = true;
  context.out.items.push(item);
  return matrix;
}

/** `Do`: count an image, or descend into a form's own content stream. */
function drawXObject(
  context: WalkContext,
  resources: PdfDict | undefined,
  name: string,
  ctm: Matrix,
  depth: number,
): void {
  const { doc } = context;
  const xobjects = dictOf(get(doc, resources, 'XObject'));
  if (!xobjects) return;
  const raw = xobjects.get(name);
  const obj = resolve(doc, raw);
  if (!obj || obj.t !== 'stream') return;
  const subtype = nameOf(get(doc, obj.v, 'Subtype'));
  if (subtype === 'Image') {
    context.out.imageCount++;
    // An image is drawn by mapping the unit square through the CTM, so the
    // determinant IS the area it covers on the page — no need to look at the
    // image's own pixel dimensions, which say nothing about how big it was
    // printed. Non-finite is a malformed matrix and contributes nothing.
    const area = Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]);
    if (Number.isFinite(area) && area > context.out.maxImageArea) context.out.maxImageArea = area;
    return;
  }
  if (subtype !== 'Form') return;
  if (raw?.t === 'ref') {
    if (context.visitedForms.has(raw.num)) return; // a form that draws itself
    context.visitedForms.add(raw.num);
  }
  const bytes = streamBytes(doc, obj);
  if (!bytes) return;
  const formMatrix = readMatrix(doc, obj.v) ?? IDENTITY;
  const inner = dictOf(get(doc, obj.v, 'Resources')) ?? resources;
  runStream(context, bytes.toString('latin1'), inner, multiply(formMatrix, ctm), depth + 1);
  if (raw?.t === 'ref') context.visitedForms.delete(raw.num);
}

function readMatrix(doc: PdfDoc, dict: PdfDict): Matrix | null {
  const m = get(doc, dict, 'Matrix');
  if (m?.t !== 'array' || m.v.length < 6) return null;
  const values = m.v.slice(0, 6).map((entry) => numberOf(resolve(doc, entry)));
  if (values.some((v) => v === undefined)) return null;
  return values as Matrix;
}

/**
 * Skip an inline image. Its bytes are raw sample data that can contain anything
 * — including `(`, `<<` and the word `EI` — so we look for the terminator
 * preceded by whitespace and followed by a delimiter, which is what the format
 * guarantees.
 */
function skipInlineImage(src: string, from: number): number {
  const idAt = src.indexOf('ID', from);
  if (idAt < 0) return src.length;
  let i = idAt + 3; // `ID` plus the single whitespace byte that follows it
  while (i < src.length) {
    const at = src.indexOf('EI', i);
    if (at < 0) return src.length;
    const before = src.charCodeAt(at - 1);
    const after = at + 2 < src.length ? src.charCodeAt(at + 2) : 0x20;
    const whitespaceBefore = before === 0x20 || before === 0x0a || before === 0x0d || before === 0x09;
    const boundaryAfter = after === 0x20 || after === 0x0a || after === 0x0d || after === 0x09 ||
      after === 0x2f || after === 0x5b || after === 0x3c || after === 0x28;
    if (whitespaceBefore && boundaryAfter) return at + 2;
    i = at + 2;
  }
  return src.length;
}
