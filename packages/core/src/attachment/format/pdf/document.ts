/**
 * ADR-030 D1 — the document: an object map, reference resolution, stream bytes,
 * and the page list in reading order.
 *
 * The map is built by SCANNING for `n g obj` headers rather than by trusting
 * the cross-reference table. That is the deliberate choice: a damaged xref is
 * the common shape of a broken file and a lying xref is the cheap shape of a
 * hostile one, and a scan is what a repair pass would do anyway. Objects hidden
 * inside `/Type /ObjStm` compressed object streams are expanded on top, because
 * every writer since PDF 1.5 puts page and font dictionaries there.
 *
 * Pages come from the catalog's page tree when it can be walked — that is the
 * only source that gives the real ORDER — and from object-number order only as
 * a fallback. Inheritable attributes (`/Resources`, `/MediaBox`, `/Rotate`) are
 * resolved down the tree, since a page dictionary is allowed to omit all three.
 */
import { applyFilters } from './filters.js';
import { noteLimit, outOfTime, spendObject, type PdfBudget } from './limits.js';
import {
  dictOf, nameOf, numberOf, parseObjectAt, scanIndirectObjects, skipWhite,
  type PdfDict, type PdfObject,
} from './objects.js';

export interface PdfPageNode {
  dict: PdfDict;
  resources?: PdfDict;
  /** `[llx, lly, urx, ury]` in user-space units, when declared. */
  mediaBox?: [number, number, number, number];
  rotate?: number;
}

export interface PdfDoc {
  src: string;
  buf: Buffer;
  budget: PdfBudget;
  /** Object number → offset of the object body (just past the `obj` keyword). */
  offsets: Map<number, number>;
  /** Objects already parsed, plus everything unpacked from object streams. */
  cache: Map<number, PdfObject>;
  /** True when `/Encrypt` is present: the streams are ciphertext, not content. */
  encrypted: boolean;
}

/** Build the object map for a buffer. Never throws; a hopeless file yields an empty map. */
export function loadDocument(buf: Buffer, budget: PdfBudget): PdfDoc {
  const src = buf.toString('latin1');
  const doc: PdfDoc = {
    src,
    buf,
    budget,
    offsets: scanIndirectObjects(src, budget),
    cache: new Map(),
    encrypted: false,
  };
  doc.encrypted = detectEncryption(doc);
  if (!doc.encrypted) expandObjectStreams(doc);
  return doc;
}

/**
 * `/Encrypt` in a trailer means every string and stream in the file is
 * ciphertext. We do not decrypt (even the empty-password case), so the honest
 * move is to stop and say so rather than hand back plausible garbage.
 */
function detectEncryption(doc: PdfDoc): boolean {
  // Guard against the string appearing inside a compressed stream by requiring
  // it to be followed by something reference-shaped.
  let at = doc.src.lastIndexOf('/Encrypt');
  while (at > 0) {
    const after = skipWhite(doc.src, at + 8, Math.min(doc.src.length, at + 40));
    const ch = doc.src[after];
    if ((ch >= '0' && ch <= '9') || ch === '<') return true;
    at = doc.src.lastIndexOf('/Encrypt', at - 1);
  }
  return false;
}

/** Parse (and cache) the object with this number. */
export function getObject(doc: PdfDoc, num: number): PdfObject | undefined {
  const cached = doc.cache.get(num);
  if (cached) return cached;
  const at = doc.offsets.get(num);
  if (at === undefined) return undefined;
  if (!spendObject(doc.budget)) return undefined;
  const parsed = parseObjectAt(doc.src, at, doc.src.length, doc.budget, 0, true);
  if (!parsed) return undefined;
  doc.cache.set(num, parsed.obj);
  return parsed.obj;
}

/** Follow indirect references to a direct object. Cycles end at the depth wall. */
export function resolve(doc: PdfDoc, obj: PdfObject | undefined): PdfObject | undefined {
  let current = obj;
  for (let hops = 0; hops < 32; hops++) {
    if (!current || current.t !== 'ref') return current;
    current = getObject(doc, current.num);
  }
  noteLimit(doc.budget, 'depth');
  return undefined;
}

/** Resolved lookup of one dictionary key. */
export function get(doc: PdfDoc, dict: PdfDict | undefined, key: string): PdfObject | undefined {
  if (!dict) return undefined;
  return resolve(doc, dict.get(key));
}

/**
 * The decoded bytes of a stream object.
 *
 * `/Length` is checked rather than trusted: when it does not land on
 * `endstream` we search for the real terminator, which is the single most
 * common corruption in files produced by hand-rolled writers.
 */
export function streamBytes(doc: PdfDoc, obj: PdfObject | undefined): Buffer | null {
  if (!obj || obj.t !== 'stream') return null;
  const start = obj.dataStart;
  let end = -1;
  const declared = numberOf(get(doc, obj.v, 'Length'));
  if (declared !== undefined && declared >= 0 && start + declared <= doc.src.length) {
    const after = skipWhite(doc.src, start + declared, Math.min(doc.src.length, start + declared + 4));
    if (doc.src.startsWith('endstream', after)) end = start + declared;
  }
  if (end < 0) {
    const found = doc.src.indexOf('endstream', start);
    if (found < 0) {
      noteLimit(doc.budget, 'malformed');
      return null;
    }
    end = found;
    // Trim the EOL the writer put before `endstream`.
    if (doc.src[end - 1] === '\n') end--;
    if (doc.src[end - 1] === '\r') end--;
  }
  const raw = doc.buf.subarray(start, Math.max(start, end));
  const out = applyFilters(raw, obj.v, (o) => resolve(doc, o), doc.budget);
  return out.data;
}

/**
 * Unpack `/Type /ObjStm` streams into the object cache.
 *
 * Located by searching for the type name and mapping the hit back to the object
 * that contains it, which avoids parsing every object in the file just to find
 * the handful that are containers.
 */
function expandObjectStreams(doc: PdfDoc): void {
  const starts = [...doc.offsets.entries()].sort((a, b) => a[1] - b[1]);
  if (starts.length === 0) return;
  let at = doc.src.indexOf('/ObjStm');
  let expanded = 0;
  while (at >= 0 && expanded < 4096) {
    if (outOfTime(doc.budget)) return;
    const owner = ownerOf(starts, at);
    if (owner !== undefined) {
      unpackObjectStream(doc, owner);
      expanded++;
    }
    at = doc.src.indexOf('/ObjStm', at + 7);
  }
}

/** The object whose body contains `index`, by binary search over sorted starts. */
function ownerOf(starts: [number, number][], index: number): number | undefined {
  let lo = 0;
  let hi = starts.length - 1;
  let best: number | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid][1] <= index) {
      best = starts[mid][0];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

function unpackObjectStream(doc: PdfDoc, num: number): void {
  const obj = getObject(doc, num);
  if (!obj || obj.t !== 'stream') return;
  if (nameOf(get(doc, obj.v, 'Type')) !== 'ObjStm') return;
  const count = numberOf(get(doc, obj.v, 'N')) ?? 0;
  const first = numberOf(get(doc, obj.v, 'First')) ?? 0;
  if (count <= 0 || first < 0) return;
  const data = streamBytes(doc, obj);
  if (!data) return;
  const text = data.toString('latin1');
  // The header is `N` pairs of <object number> <offset>, then the objects.
  let cursor = 0;
  const pairs: [number, number][] = [];
  for (let i = 0; i < count && i < doc.budget.bounds.maxObjects; i++) {
    const numAt = readInt(text, cursor);
    if (!numAt) break;
    const offAt = readInt(text, numAt.end);
    if (!offAt) break;
    pairs.push([numAt.value, offAt.value]);
    cursor = offAt.end;
  }
  for (const [objNum, offset] of pairs) {
    if (doc.cache.has(objNum) || doc.offsets.has(objNum)) continue; // a top-level definition wins
    const at = first + offset;
    if (at < 0 || at >= text.length) continue;
    if (!spendObject(doc.budget)) return;
    const parsed = parseObjectAt(text, at, text.length, doc.budget, 0, false);
    if (parsed) doc.cache.set(objNum, parsed.obj);
  }
}

function readInt(text: string, from: number): { value: number; end: number } | null {
  let i = from;
  while (i < text.length && (text[i] === ' ' || text[i] === '\n' || text[i] === '\r' || text[i] === '\t')) i++;
  const start = i;
  while (i < text.length && text[i] >= '0' && text[i] <= '9') i++;
  if (i === start) return null;
  const value = Number.parseInt(text.slice(start, i), 10);
  return Number.isFinite(value) ? { value, end: i } : null;
}

/**
 * The document's pages, in order.
 *
 * Walking the catalog is the only way to get real order; scanning for
 * `/Type /Page` gives object-number order, which is usually but not always the
 * same. So the scan is the fallback, not the primary.
 */
export function listPages(doc: PdfDoc): PdfPageNode[] {
  const root = findCatalog(doc);
  const pagesObj = root ? get(doc, root, 'Pages') : undefined;
  const pages: PdfPageNode[] = [];
  const seen = new Set<number>();
  if (pagesObj) walkPageTree(doc, dictOf(pagesObj), {}, pages, seen, 0);
  if (pages.length > 0) return pages;

  // Fallback: every object that calls itself a page, in object-number order.
  for (const num of [...doc.offsets.keys()].sort((a, b) => a - b)) {
    if (pages.length >= doc.budget.bounds.maxPages) break;
    const obj = getObject(doc, num);
    const dict = dictOf(obj);
    if (!dict || nameOf(get(doc, dict, 'Type')) !== 'Page') continue;
    pages.push(pageNode(doc, dict, {}));
  }
  for (const [num, obj] of doc.cache) {
    if (doc.offsets.has(num)) continue;
    if (pages.length >= doc.budget.bounds.maxPages) break;
    const dict = dictOf(obj);
    if (!dict || nameOf(get(doc, dict, 'Type')) !== 'Page') continue;
    pages.push(pageNode(doc, dict, {}));
  }
  return pages;
}

interface Inherited {
  resources?: PdfDict;
  mediaBox?: [number, number, number, number];
  rotate?: number;
}

function walkPageTree(
  doc: PdfDoc,
  node: PdfDict | undefined,
  inherited: Inherited,
  out: PdfPageNode[],
  seen: Set<number>,
  depth: number,
): void {
  if (!node || depth > doc.budget.bounds.maxDepth) return;
  if (out.length >= doc.budget.bounds.maxPages) {
    noteLimit(doc.budget, 'pages');
    return;
  }
  if (outOfTime(doc.budget)) return;

  const next: Inherited = {
    resources: dictOf(get(doc, node, 'Resources')) ?? inherited.resources,
    mediaBox: readBox(doc, node) ?? inherited.mediaBox,
    rotate: numberOf(get(doc, node, 'Rotate')) ?? inherited.rotate,
  };

  const type = nameOf(get(doc, node, 'Type'));
  const kids = get(doc, node, 'Kids');
  if (type === 'Page' || (!kids && node.has('Contents'))) {
    out.push(pageNode(doc, node, next));
    return;
  }
  if (kids?.t !== 'array') return;
  for (let i = 0; i < kids.v.length; i++) {
    const kid = kids.v[i];
    if (kid.t === 'ref') {
      if (seen.has(kid.num)) continue; // a cyclic page tree is a hostile page tree
      seen.add(kid.num);
    }
    walkPageTree(doc, dictOf(resolve(doc, kid)), next, out, seen, depth + 1);
    if (out.length >= doc.budget.bounds.maxPages) {
      // Only a bound we actually stopped short at is worth reporting; filling
      // the quota on the last kid left nothing unread.
      if (i < kids.v.length - 1) noteLimit(doc.budget, 'pages');
      return;
    }
  }
}

function pageNode(doc: PdfDoc, dict: PdfDict, inherited: Inherited): PdfPageNode {
  const node: PdfPageNode = { dict };
  const resources = dictOf(get(doc, dict, 'Resources')) ?? inherited.resources;
  const mediaBox = readBox(doc, dict) ?? inherited.mediaBox;
  const rotate = numberOf(get(doc, dict, 'Rotate')) ?? inherited.rotate;
  if (resources) node.resources = resources;
  if (mediaBox) node.mediaBox = mediaBox;
  if (rotate !== undefined) node.rotate = rotate;
  return node;
}

function readBox(doc: PdfDoc, dict: PdfDict): [number, number, number, number] | undefined {
  const box = get(doc, dict, 'MediaBox');
  if (box?.t !== 'array' || box.v.length < 4) return undefined;
  const nums = box.v.slice(0, 4).map((entry) => numberOf(resolve(doc, entry)));
  if (nums.some((n) => n === undefined)) return undefined;
  return [nums[0] as number, nums[1] as number, nums[2] as number, nums[3] as number];
}

function findCatalog(doc: PdfDoc): PdfDict | undefined {
  // The trailer names the catalog. Later trailers (incremental updates) win, so
  // we read them from the end of the file backwards. Both bounds matter on a
  // crafted file: a trailer dictionary is small, and a file with thousands of
  // the word "trailer" in it must not cost a full parse per occurrence.
  let at = doc.src.lastIndexOf('trailer');
  for (let tries = 0; at > 0 && tries < 32; tries++) {
    const end = Math.min(doc.src.length, at + 65_536);
    const parsed = parseObjectAt(doc.src, at + 7, end, doc.budget, 0, false);
    const dict = dictOf(parsed?.obj);
    const root = dictOf(get(doc, dict, 'Root'));
    if (root) return root;
    at = doc.src.lastIndexOf('trailer', at - 1);
  }
  // Cross-reference streams carry `/Root` on the stream dictionary instead.
  for (const num of [...doc.offsets.keys()].sort((a, b) => b - a)) {
    if (outOfTime(doc.budget)) break;
    const obj = getObject(doc, num);
    const dict = dictOf(obj);
    if (!dict || !dict.has('Root')) continue;
    const root = dictOf(get(doc, dict, 'Root'));
    if (root) return root;
  }
  // Last resort: the catalog object itself.
  for (const num of doc.offsets.keys()) {
    const dict = dictOf(getObject(doc, num));
    if (dict && nameOf(get(doc, dict, 'Type')) === 'Catalog') return dict;
  }
  return undefined;
}
