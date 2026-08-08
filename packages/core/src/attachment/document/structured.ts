/**
 * ADR-030 D2 — the structured engine, loaded lazily and never trusted to be there.
 *
 * The parser is `@firecrawl/pdf-inspector-wasm` (MIT), taken as its WebAssembly
 * build rather than its native binding. That is Q1's answer and it is about our
 * own build matrix, not about taste: the native package ships no `darwin-x64`
 * prebuilt and our desktop ships macOS x64, so adopting it natively would mean
 * Intel Mac users silently got the baseline while everyone else got documents.
 * One `.wasm` covers every target we have.
 *
 * Three properties this module exists to guarantee:
 *
 *  1. **Lazy.** The binary is 4.6 MB. `await import()` rather than a top-level
 *     import means a process that never opens a PDF never pays for it, and the
 *     bytes are read from disk once, on first use.
 *  2. **Optional.** Every failure — module missing from the install, binary
 *     unreadable, instantiation refused, the parser rejecting the file — returns
 *     a REASON, never a throw. The failure is memoised too: a broken install
 *     must cost one attempt, not one per attachment.
 *  3. **Bounded.** See `bounds.ts` for why the deadline is checked between calls
 *     and the calls themselves are bounded by bytes and pages.
 *
 * Q2 pins where this runs: the Electron MAIN process, the CLI, or the hosted
 * backend — never a renderer or an edge bundle, both of which have JavaScript
 * budgets this binary dwarfs. Nothing here reaches the filesystem except to read
 * the binary out of the package that declares it, and nothing reaches the
 * network at all.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import type { PdfLimit } from '../format/pdf/index.js';

const WASM_PACKAGE = '@firecrawl/pdf-inspector-wasm';
const WASM_BINARY = `${WASM_PACKAGE}/pdf_inspector_wasm_bg.wasm`;

export interface StructuredOcrReason {
  /** 1-based page number. */
  page: number;
  reasons: string[];
}

/**
 * The subset of the parser's result we consume.
 *
 * Narrower than what it returns, and each omission is a decision:
 *
 *  - `title` is document-controlled content, and the notice it would land in is
 *    presented as our own words rather than as fenced data (`types.ts`).
 *  - `confidence` invites a threshold nobody can justify.
 *  - `pdfType`, the engine's own document-level verdict, is not used because
 *    ours is derived per page and incorporates the baseline's overrule
 *    (`classify.ts`) — taking both would mean reconciling two answers to the
 *    same question, and the reconciliation would be the bug.
 */
export interface StructuredResult {
  markdown?: string;
  pageCount: number;
  /** 1-based page numbers with no usable text layer. */
  pagesNeedingOcr: number[];
  ocrReasonsByPage: StructuredOcrReason[];
}

interface StructuredEngine {
  processPdf(data: Uint8Array, options?: {
    pages?: number[];
    includePageMarkers?: boolean;
  }): StructuredResult;
  classifyPdf(data: Uint8Array): { pageCount: number };
}

export interface StructuredRunOptions {
  /** Absolute `Date.now()` the whole seam must be finished by. */
  deadline: number;
  maxBytes: number;
  maxPages: number;
  canaryFraction: number;
}

export type StructuredOutcome =
  /** `pagesCapped` when the document has more pages than we let the engine read. */
  | { ok: true; result: StructuredResult; pagesCapped: boolean }
  | { ok: false; reason: string; limit?: PdfLimit };

let enginePromise: Promise<StructuredEngine | null> | undefined;
let loadFailure: string | undefined;

/**
 * Load the engine once per process, remembering failure as firmly as success.
 *
 * The promise is cached rather than the resolved value so two attachments
 * arriving together share one instantiation instead of racing to build two
 * 4.6 MB instances.
 */
async function loadStructuredEngine(): Promise<StructuredEngine | null> {
  enginePromise ??= loadOnce();
  return enginePromise;
}

async function loadOnce(): Promise<StructuredEngine | null> {
  try {
    const mod = await import(WASM_PACKAGE);
    // The published glue defaults to `fetch()` on a URL relative to itself,
    // which is a browser assumption: Node's fetch does not read `file:`. So the
    // bytes are handed over directly, which also keeps the one filesystem read
    // in a place a reader can see it.
    const binary = fs.readFileSync(createRequire(import.meta.url).resolve(WASM_BINARY));
    await mod.default({ module_or_path: binary });
    return { processPdf: mod.processPdf, classifyPdf: mod.classifyPdf };
  } catch (err) {
    loadFailure = `the document parser could not be loaded: ${describe(err)}`;
    return null;
  }
}

/**
 * Test seam (rule: no module mocking in this workspace) — forget the cached
 * engine so a test can exercise the load path, or the failure path, twice.
 */
export function _resetStructuredEngineForTests(): void {
  enginePromise = undefined;
  loadFailure = undefined;
}

/**
 * Run the structured parse inside its walls, or say why it did not run.
 *
 * Never throws. The parser signals a file it will not read by throwing — a
 * missing cross-reference table, an encrypted body, a file that is not a PDF at
 * all — and every one of those is a degraded answer here, not an error.
 */
export async function runStructured(
  bytes: Buffer,
  opts: StructuredRunOptions,
): Promise<StructuredOutcome> {
  if (bytes.length === 0) return { ok: false, reason: 'the file is empty' };
  if (bytes.length > opts.maxBytes) {
    return {
      ok: false,
      limit: 'bytes',
      reason: `the file is larger than the ${Math.floor(opts.maxBytes / (1024 * 1024))} MB `
        + 'the document parser accepts',
    };
  }
  if (Date.now() >= opts.deadline) {
    return { ok: false, limit: 'time', reason: 'the time budget was spent before the parse began' };
  }

  const engine = await loadStructuredEngine();
  if (!engine) return { ok: false, reason: loadFailure ?? 'the document parser is unavailable' };
  if (Date.now() >= opts.deadline) {
    return { ok: false, limit: 'time', reason: 'the time budget was spent loading the document parser' };
  }

  // The canary: the cheap pass walks the same object graph as the expensive one,
  // so its cost predicts the cost we would not be able to abandon. See bounds.ts.
  const canaryStart = Date.now();
  let pageCount: number;
  try {
    pageCount = engine.classifyPdf(bytes).pageCount;
  } catch (err) {
    return { ok: false, reason: `the document parser refused the file: ${describe(err)}` };
  }
  const canaryMs = Date.now() - canaryStart;
  const remaining = opts.deadline - Date.now();
  if (remaining <= 0 || canaryMs > remaining * opts.canaryFraction) {
    return {
      ok: false,
      limit: 'time',
      reason: `the document is too slow to parse inside the time budget (${canaryMs} ms to classify it)`,
    };
  }

  const options: { pages?: number[]; includePageMarkers?: boolean } = { includePageMarkers: true };
  const capped = Number.isFinite(pageCount) && pageCount > opts.maxPages;
  if (capped) options.pages = pageRange(opts.maxPages);
  try {
    const result = engine.processPdf(bytes, options);
    // With an explicit page list the engine reports the pages it read, not the
    // pages the document has. The document's own count is the honest one — a
    // notice saying "200 pages" about a 4,000-page file is the silent wrong
    // answer this ADR exists to remove.
    return { ok: true, pagesCapped: capped, result: capped ? { ...result, pageCount } : result };
  } catch (err) {
    return { ok: false, reason: `the document parser refused the file: ${describe(err)}` };
  }
}

/** `[1, 2, … n]` — the explicit page list that bounds the one expensive call. */
function pageRange(n: number): number[] {
  const pages: number[] = [];
  for (let i = 1; i <= n; i++) pages.push(i);
  return pages;
}

/**
 * A parser error, reduced to something safe to put in a sentence.
 *
 * This is the one string in the notice that did not originate in this folder,
 * and the notice is presented to the model as OUR words rather than as fenced
 * document data (`types.ts`). An error message from a library that has just
 * parsed an attacker's file may quote bytes from it, so the reduction is an
 * ALLOWLIST rather than a blocklist: letters, digits, spaces and the punctuation
 * a diagnostic needs. Nothing that could open a tag, close a fence, or carry
 * Markdown survives, and the whole thing is capped.
 */
function describe(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  let out = '';
  for (let i = 0; i < raw.length && out.length < 160; i++) {
    const ch = raw[i];
    const code = raw.charCodeAt(i);
    const safe = (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a)
      || (code >= 0x61 && code <= 0x7a) || ch === ' ' || ch === '.' || ch === ','
      || ch === ':' || ch === ';' || ch === '-' || ch === '/';
    out += safe ? ch : ' ';
  }
  return collapseSpaces(out) || 'no reason given';
}

function collapseSpaces(value: string): string {
  let out = '';
  let space = false;
  for (const ch of value) {
    if (ch === ' ') {
      space = true;
      continue;
    }
    if (space && out.length > 0) out += ' ';
    space = false;
    out += ch;
  }
  return out;
}
