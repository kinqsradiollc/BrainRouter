/**
 * ADR-030 D4 — the thread the structured engine runs on, so that it can be stopped.
 *
 * D4 asks for "a byte cap, a page cap, a time budget, and a memory bound, and it
 * runs where a crash is contained". The first three were enforced in-process.
 * The last two could not be, and `bounds.ts` said so: **the engine call is
 * synchronous and cannot be interrupted**, so once `processPdf` was entered
 * nothing else in the process ran until it returned. Measured, a 522 KB
 * decompression bomb reached 1.9 GB resident and held the whole process for the
 * duration; hosted, that is one upload stopping every other request.
 *
 * This is the second thread `bounds.ts` names. Four things it buys, and it is
 * worth being exact about which are guarantees and which are bounds:
 *
 *  1. **Preemption.** `worker.terminate()` interrupts a running WebAssembly
 *     instance — V8 checks for termination at loop back-edges — so the time
 *     budget is now enforced DURING the call rather than only between calls.
 *  2. **Containment.** An abort inside the engine kills the worker and arrives
 *     here as an `error`/`exit` event. The host process keeps running and the
 *     attachment loses its structure, not its existence.
 *  3. **A JS heap cap**, from `resourceLimits`. This bounds the strings the glue
 *     builds — the extracted Markdown of a document engineered to be enormous.
 *  4. **A memory bound**, by watching resident size and terminating. It is a
 *     watchdog rather than an allocator limit, and that is not a shortcut:
 *     `resourceLimits` caps a worker's V8 HEAP, and WebAssembly linear memory is
 *     not on it — the bomb's 1.9 GB is `memory.grow` inside the module, which no
 *     Node option can refuse. What CAN be done is notice and stop, and because
 *     the growth belongs to a thread we own, terminating it returns the memory.
 *
 * **The worker is long-lived and its source is inline.** Long-lived because the
 * 4.6 MB binary is compiled once per process, as it was before this file
 * existed — a fresh worker per attachment would trade an unbounded parse for a
 * slow one. Inline (`eval: true`) because a worker FILE would have to be
 * resolved out of a packaged application archive on the desktop, out of the
 * CLI's bundle, and out of the server image, and the first packaging change that
 * missed it would degrade every document to the baseline with nothing failing.
 * The source below has no imports of its own: the parent resolves the engine's
 * paths and hands them over.
 *
 * A job that is terminated takes the worker with it. That is deliberate: a
 * thread interrupted mid-`memory.grow` is not a thread to hand the next
 * document to.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { PdfLimit } from '../format/pdf/index.js';

const WASM_PACKAGE = '@firecrawl/pdf-inspector-wasm';
const WASM_BINARY = `${WASM_PACKAGE}/pdf_inspector_wasm_bg.wasm`;

/** How often the memory watchdog looks. Cheap: `memoryUsage.rss()` is a syscall. */
const MEMORY_POLL_MS = 100;

/**
 * How long a terminated worker is given to die before we stop waiting on it.
 *
 * `terminate()` resolves when the thread is gone, and the answer to the caller
 * must not depend on that: an attachment upload cannot hang because a hostile
 * document made a thread slow to unwind.
 */
const TERMINATE_GRACE_MS = 2_000;

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

export interface StructuredRunOptions {
  /** Absolute `Date.now()` the whole seam must be finished by. */
  deadline: number;
  maxBytes: number;
  maxPages: number;
  canaryFraction: number;
  /**
   * Resident growth the parse may cause before it is stopped, in bytes.
   * Zero or below turns the watchdog off, which is a test seam and not a mode
   * anything ships in.
   */
  maxMemoryBytes: number;
}

export type StructuredOutcome =
  /** `pagesCapped` when the document has more pages than we let the engine read. */
  | { ok: true; result: StructuredResult; pagesCapped: boolean }
  | { ok: false; reason: string; limit?: PdfLimit };

/**
 * The worker's whole program, as a string.
 *
 * CommonJS because that is what `eval: true` evaluates, which is why the engine
 * is reached through a dynamic `import()` of an absolute file URL the parent
 * resolved. Nothing here reads a path, a package name, or the filesystem: give a
 * thread that runs an attacker's bytes as little to reach for as it can be given.
 *
 * The canary lives in here rather than in the parent because the decision it
 * makes is BETWEEN the two engine calls, and both of those are now on this side.
 * The rule is the one `bounds.ts` states, applied where it can still refuse.
 */
const WORKER_SOURCE = `
const { workerData, parentPort } = require('node:worker_threads');
const fs = require('node:fs');

let engine = null;
let loadError = null;

async function ready() {
  if (engine || loadError) return;
  try {
    const mod = await import(workerData.moduleUrl);
    await mod.default({ module_or_path: fs.readFileSync(workerData.wasmPath) });
    engine = { processPdf: mod.processPdf, classifyPdf: mod.classifyPdf };
  } catch (err) {
    loadError = err && err.message ? String(err.message) : String(err);
  }
}

function pageRange(n) {
  const pages = [];
  for (let i = 1; i <= n; i++) pages.push(i);
  return pages;
}

parentPort.on('message', async (job) => {
  await ready();
  if (!engine) {
    parentPort.postMessage({ id: job.id, ok: false, kind: 'load', message: loadError });
    return;
  }

  const bytes = Buffer.from(job.bytes);
  const canaryStart = Date.now();
  let pageCount;
  try {
    pageCount = engine.classifyPdf(bytes).pageCount;
  } catch (err) {
    parentPort.postMessage({ id: job.id, ok: false, kind: 'refused', message: err && err.message ? String(err.message) : String(err) });
    return;
  }
  const canaryMs = Date.now() - canaryStart;
  const remaining = job.deadline - Date.now();
  if (remaining <= 0 || canaryMs > remaining * job.canaryFraction) {
    parentPort.postMessage({ id: job.id, ok: false, kind: 'slow', canaryMs });
    return;
  }

  const options = { includePageMarkers: true };
  const capped = Number.isFinite(pageCount) && pageCount > job.maxPages;
  if (capped) options.pages = pageRange(job.maxPages);
  try {
    const result = engine.processPdf(bytes, options);
    parentPort.postMessage({
      id: job.id,
      ok: true,
      pagesCapped: capped,
      result: {
        markdown: result.markdown,
        pageCount: capped ? pageCount : result.pageCount,
        pagesNeedingOcr: result.pagesNeedingOcr,
        ocrReasonsByPage: result.ocrReasonsByPage,
      },
    });
  } catch (err) {
    parentPort.postMessage({ id: job.id, ok: false, kind: 'refused', message: err && err.message ? String(err.message) : String(err) });
  }
});
`;

interface WorkerHandle {
  worker: Worker;
  /** Set when this worker has been terminated and must not take another job. */
  dead: boolean;
}

let handle: WorkerHandle | null = null;
let spawnFailure: string | undefined;
/** One job at a time: the engine call is synchronous, so a second would queue anyway. */
let chain: Promise<unknown> = Promise.resolve();
let nextJobId = 1;

/**
 * The engine's two absolute paths, resolved in the PARENT.
 *
 * `createRequire(import.meta.url)` resolves against this file, which is the only
 * place that knows where the package sits — inside `app.asar.unpacked` on the
 * desktop, inside `node_modules` everywhere else. Resolving it in the worker
 * would mean resolving against a synthetic eval URL, which has no package scope.
 */
function enginePaths(): { moduleUrl: string; wasmPath: string } {
  const require = createRequire(import.meta.url);
  return {
    moduleUrl: pathToFileURL(require.resolve(WASM_PACKAGE)).href,
    wasmPath: require.resolve(WASM_BINARY),
  };
}

function spawn(maxMemoryBytes: number): WorkerHandle | null {
  try {
    const { moduleUrl, wasmPath } = enginePaths();
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { moduleUrl, wasmPath },
      // The JS heap only. See the header: linear memory is not on this budget,
      // which is what the watchdog is for. Sized from the same number so one
      // knob moves both.
      resourceLimits: {
        maxOldGenerationSizeMb: Math.max(64, Math.floor(maxMemoryBytes / (1024 * 1024))),
      },
    });
    // A worker with nothing to do must not hold a CLI process open. Re-`ref`ed
    // for the duration of each job and released again when it answers.
    worker.unref();
    const created: WorkerHandle = { worker, dead: false };
    // A worker that dies on its own — an abort inside the engine, an OOM in the
    // isolate — must not be handed the next document.
    worker.once('error', () => { created.dead = true; });
    worker.once('exit', () => { created.dead = true; });
    return created;
  } catch (err) {
    spawnFailure = `the document parser could not be started: ${describe(err)}`;
    return null;
  }
}

/** Stop the worker and forget it. The next parse gets a clean one. */
async function retire(reason: WorkerHandle | null): Promise<void> {
  const target = reason;
  if (!target) return;
  target.dead = true;
  if (handle === target) handle = null;
  await Promise.race([
    target.worker.terminate().catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, TERMINATE_GRACE_MS).unref?.()),
  ]);
}

/**
 * Test seam (rule: no module mocking in this workspace) — forget the worker so a
 * test can exercise the spawn path, or the failure path, twice.
 */
export async function _resetStructuredEngineForTests(): Promise<void> {
  const target = handle;
  handle = null;
  spawnFailure = undefined;
  chain = Promise.resolve();
  await retire(target);
}

/**
 * Run the structured parse inside its walls, or say why it did not run.
 *
 * Never throws. Every way this can go wrong — a hostile file, a spent budget, a
 * thread that had to be killed, a missing parser — is a degraded answer with a
 * reason, because this sits on an upload path.
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

  const run = chain.then(() => runOne(bytes, opts), () => runOne(bytes, opts));
  chain = run.catch(() => undefined);
  return run;
}

function runOne(bytes: Buffer, opts: StructuredRunOptions): Promise<StructuredOutcome> {
  if (Date.now() >= opts.deadline) {
    return Promise.resolve({ ok: false, limit: 'time', reason: 'the time budget was spent waiting for the document parser' });
  }
  if (!handle || handle.dead) handle = spawn(opts.maxMemoryBytes);
  const active = handle;
  if (!active) {
    return Promise.resolve({ ok: false, reason: spawnFailure ?? 'the document parser is unavailable' });
  }

  const id = nextJobId++;
  const startRss = process.memoryUsage.rss();

  return new Promise<StructuredOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: StructuredOutcome, kill: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearInterval(watchdog);
      active.worker.off('message', onMessage);
      active.worker.off('error', onError);
      active.worker.off('exit', onExit);
      active.worker.unref();
      if (kill) void retire(active);
      resolve(outcome);
    };

    const onMessage = (message: WorkerReply): void => {
      if (!message || message.id !== id) return;
      finish(translate(message), false);
    };
    // A worker that dies mid-parse is the containment case: the document loses
    // its structure and the process is still standing.
    const onError = (err: unknown): void => {
      finish({ ok: false, reason: `the document parser stopped: ${describe(err)}` }, true);
    };
    const onExit = (): void => {
      finish({ ok: false, reason: 'the document parser stopped before it answered' }, true);
    };

    const deadlineTimer = setTimeout(() => {
      finish({
        ok: false,
        limit: 'time',
        reason: 'the parse ran past its time budget and was stopped',
      }, true);
    }, Math.max(1, opts.deadline - Date.now()));

    const watchdog = opts.maxMemoryBytes > 0
      ? setInterval(() => {
        if (process.memoryUsage.rss() - startRss <= opts.maxMemoryBytes) return;
        finish({
          ok: false,
          limit: 'memory',
          reason: `the document needs more memory than the ${
            Math.floor(opts.maxMemoryBytes / (1024 * 1024))} MB the parser is allowed`,
        }, true);
      }, MEMORY_POLL_MS)
      : (setTimeout(() => undefined, 0) as unknown as NodeJS.Timeout);

    deadlineTimer.unref?.();
    watchdog.unref?.();

    active.worker.on('message', onMessage);
    active.worker.on('error', onError);
    active.worker.on('exit', onExit);
    active.worker.ref();
    active.worker.postMessage({
      id,
      // Transferred rather than copied: a 16 MB clone per attachment is real
      // cost for no benefit, and this buffer is not read again on this side.
      bytes: toTransferable(bytes),
      deadline: opts.deadline,
      maxPages: opts.maxPages,
      canaryFraction: opts.canaryFraction,
    });
  });
}

type WorkerReply =
  | { id: number; ok: true; pagesCapped: boolean; result: StructuredResult }
  | { id: number; ok: false; kind: 'load' | 'refused'; message: string }
  | { id: number; ok: false; kind: 'slow'; canaryMs: number };

function translate(message: WorkerReply): StructuredOutcome {
  if (message.ok) return { ok: true, pagesCapped: message.pagesCapped, result: message.result };
  if (message.kind === 'slow') {
    return {
      ok: false,
      limit: 'time',
      reason: `the document is too slow to parse inside the time budget (${message.canaryMs} ms to classify it)`,
    };
  }
  if (message.kind === 'load') {
    return { ok: false, reason: `the document parser could not be loaded: ${describe(message.message)}` };
  }
  return { ok: false, reason: `the document parser refused the file: ${describe(message.message)}` };
}

/** A copy the structured clone can move rather than duplicate. */
function toTransferable(bytes: Buffer): Uint8Array {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy;
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
