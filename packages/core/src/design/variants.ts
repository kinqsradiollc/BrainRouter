/**
 * Live variants, the deterministic half (ADR-056 D-B5).
 *
 * The agent writes N variants of one element INTO THE SOURCE FILE inside a
 * `display: contents` wrapper carrying `data-brainrouter-variants`; the dev
 * server's HMR swaps them in; a person cycles and accepts one. Accept strips
 * the losers so the winner is real code in the diff; discard restores the file
 * byte-identical. This module owns the wrapper, the session record under
 * `.brainrouter/design/variants/`, accept, and discard — pure file work with
 * receipts, no model, no server. The desktop's picker/cycler and the CLI's
 * `--variants N` both hand off here.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DESIGN_VARIANTS_DIR = path.join('.brainrouter', 'design', 'variants');
export const VARIANT_LIMITS = { min: 1, max: 6, fileBytes: 2 * 1024 * 1024, variantChars: 20_000 } as const;

export type VariantFlavor = 'html' | 'jsx';

export interface VariantSession {
  version: 1;
  id: string;
  file: string;
  action: string;
  flavor: VariantFlavor;
  /** Character range of the original element in the original file. */
  start: number;
  end: number;
  /** Index 0 is the original; 1..n the alternatives. */
  variants: string[];
  /** The whole file before wrapping — what discard restores, byte for byte. */
  originalFile: string;
  createdAt: string;
}

export interface VariantReceipt { id: string; file: string; lines: [number, number]; count: number; flavor: VariantFlavor }

export function variantFlavor(file: string): VariantFlavor {
  return /\.(jsx|tsx|js|ts|mjs|cjs)$/i.test(file) ? 'jsx' : 'html';
}

function resolveInside(workspaceRoot: string, relative: string): string {
  const root = path.resolve(workspaceRoot);
  const abs = path.resolve(root, relative);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`${relative}: outside the workspace`);
  return abs;
}

function lineOf(content: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < offset && i < content.length; i++) if (content.charCodeAt(i) === 10) n++;
  return n;
}

function openerFor(flavor: VariantFlavor, id: string, action: string): string {
  return flavor === 'jsx'
    ? `<div style={{ display: 'contents' }} data-brainrouter-variants="${id}" data-brainrouter-action="${action}" data-brainrouter-active="0">`
    : `<div style="display:contents" data-brainrouter-variants="${id}" data-brainrouter-action="${action}" data-brainrouter-active="0">`;
}

function childFor(flavor: VariantFlavor, index: number, text: string): string {
  const style = flavor === 'jsx' ? `style={{ display: 'contents' }}` : 'style="display:contents"';
  return `<div ${style} data-brainrouter-variant="${index}"${index > 0 ? ' hidden' : ''}>${text}</div>`;
}

function closerFor(flavor: VariantFlavor, id: string): string {
  return flavor === 'jsx' ? `</div>{/* /brainrouter-variants:${id} */}` : `</div><!-- /brainrouter-variants:${id} -->`;
}

/** The wrapper's [start, end) in `content`, or null when the block is not there any more. */
export function findVariantBlock(content: string, id: string, flavor: VariantFlavor): { start: number; end: number } | null {
  const openMarker = `data-brainrouter-variants="${id}"`;
  const openAt = content.indexOf(openMarker);
  if (openAt < 0) return null;
  const start = content.lastIndexOf('<div', openAt);
  if (start < 0) return null;
  const closer = closerFor(flavor, id);
  const closeAt = content.indexOf(closer, openAt);
  if (closeAt < 0) return null;
  return { start, end: closeAt + closer.length };
}

function sessionPath(workspaceRoot: string, id: string): string {
  if (!/^[a-z0-9-]{4,80}$/.test(id)) throw new Error(`variant session id "${id}" is invalid`);
  return path.join(workspaceRoot, DESIGN_VARIANTS_DIR, `${id}.json`);
}

export function readVariantSession(workspaceRoot: string, id: string): VariantSession {
  const p = sessionPath(workspaceRoot, id);
  let raw: string;
  try { raw = fs.readFileSync(p, 'utf8'); } catch { throw new Error(`no variant session "${id}" (see design_variants list)`); }
  const s = JSON.parse(raw) as VariantSession;
  if (s.version !== 1 || !Array.isArray(s.variants)) throw new Error(`variant session "${id}" is unreadable`);
  return s;
}

export function listVariantSessions(workspaceRoot: string): Array<Pick<VariantSession, 'id' | 'file' | 'action' | 'createdAt'> & { count: number }> {
  const dir = path.join(workspaceRoot, DESIGN_VARIANTS_DIR);
  let names: string[];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort(); } catch { return []; }
  const out = [];
  for (const n of names) {
    try { const s = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as VariantSession; if (s.version === 1) out.push({ id: s.id, file: s.file, action: s.action, createdAt: s.createdAt, count: s.variants.length - 1 }); } catch { /* skip */ }
  }
  return out;
}

export interface WrapVariantsInput { file: string; start: number; end: number; variants: string[]; action: string; now?: () => Date; id?: string }

/** Wrap `[start, end)` of `file` with the original plus N variants; returns the session and a receipt. */
export function wrapVariants(workspaceRoot: string, input: WrapVariantsInput): { session: VariantSession; receipt: VariantReceipt } {
  const abs = resolveInside(workspaceRoot, input.file);
  const content = fs.readFileSync(abs, 'utf8');
  if (content.length > VARIANT_LIMITS.fileBytes) throw new Error(`${input.file}: over the ${VARIANT_LIMITS.fileBytes / 1024 / 1024} MB bound`);
  const variants = (input.variants ?? []).map((v) => String(v));
  if (variants.length < VARIANT_LIMITS.min || variants.length > VARIANT_LIMITS.max) throw new Error(`variants: give between ${VARIANT_LIMITS.min} and ${VARIANT_LIMITS.max}`);
  if (variants.some((v) => !v.trim() || v.length > VARIANT_LIMITS.variantChars)) throw new Error('every variant must be non-empty and under the size bound');
  const start = Math.trunc(input.start), end = Math.trunc(input.end);
  if (!(start >= 0 && end > start && end <= content.length)) throw new Error(`range ${start}..${end} is outside ${input.file} (${content.length} chars)`);
  if (/data-brainrouter-variants=/.test(content.slice(start, end))) throw new Error('the range already holds a variants wrapper — accept or discard it first');
  const action = String(input.action || 'variant').replace(/[^a-z0-9 _-]/gi, '').slice(0, 40) || 'variant';
  const flavor = variantFlavor(input.file);
  const now = (input.now ?? (() => new Date()))();
  const id = input.id ?? `${path.basename(input.file).replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-+|-+$/g, '').slice(0, 24)}-${now.toISOString().slice(0, 19).replace(/[-:T]/g, '')}-${crypto.randomBytes(2).toString('hex')}`;
  const original = content.slice(start, end);
  const all = [original, ...variants];
  const block = openerFor(flavor, id, action) + all.map((text, i) => childFor(flavor, i, text)).join('') + closerFor(flavor, id);
  const next = content.slice(0, start) + block + content.slice(end);
  const session: VariantSession = { version: 1, id, file: input.file, action, flavor, start, end, variants: all, originalFile: content, createdAt: now.toISOString() };
  fs.mkdirSync(path.join(workspaceRoot, DESIGN_VARIANTS_DIR), { recursive: true });
  fs.writeFileSync(sessionPath(workspaceRoot, id), `${JSON.stringify(session, null, 2)}\n`);
  fs.writeFileSync(abs, next);
  return { session, receipt: { id, file: input.file, lines: [lineOf(next, start), lineOf(next, start + block.length)], count: variants.length, flavor } };
}

/** Keep variant `index` (0 = the original), strip the wrapper and the losers, close the session. */
export function acceptVariant(workspaceRoot: string, id: string, index: number): { file: string; lines: [number, number]; chosen: number; text: string } {
  const session = readVariantSession(workspaceRoot, id);
  const chosen = Math.trunc(index);
  if (!(chosen >= 0 && chosen < session.variants.length)) throw new Error(`variant ${index} does not exist; the session has 0..${session.variants.length - 1}`);
  const abs = resolveInside(workspaceRoot, session.file);
  const content = fs.readFileSync(abs, 'utf8');
  const block = findVariantBlock(content, id, session.flavor);
  if (!block) throw new Error(`the variants wrapper "${id}" is no longer in ${session.file}; nothing to accept`);
  const text = session.variants[chosen];
  const next = content.slice(0, block.start) + text + content.slice(block.end);
  fs.writeFileSync(abs, next);
  fs.rmSync(sessionPath(workspaceRoot, id), { force: true });
  return { file: session.file, lines: [lineOf(next, block.start), lineOf(next, block.start + text.length)], chosen, text };
}

/** Put the file back exactly as it was before wrapping; refuses when the wrapper is gone (the file moved on). */
export function discardVariants(workspaceRoot: string, id: string): { file: string; restoredBytes: number } {
  const session = readVariantSession(workspaceRoot, id);
  const abs = resolveInside(workspaceRoot, session.file);
  const content = fs.readFileSync(abs, 'utf8');
  if (!findVariantBlock(content, id, session.flavor)) throw new Error(`the variants wrapper "${id}" is no longer in ${session.file}; refusing to overwrite later edits`);
  fs.writeFileSync(abs, session.originalFile);
  fs.rmSync(sessionPath(workspaceRoot, id), { force: true });
  return { file: session.file, restoredBytes: Buffer.byteLength(session.originalFile) };
}
