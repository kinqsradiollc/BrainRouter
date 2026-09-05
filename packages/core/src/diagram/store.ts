/**
 * Workspace-scoped diagram store (ADR-056 D-A5 first half).
 *
 * Diagrams a workspace keeps live under `<workspaceRoot>/.brainrouter/diagrams/`
 * (the ADR-047/049 `.brainrouter/` convention): `<slug>.json` is the
 * specification, `<slug>.html` the delivered artifact, `<slug>.html.receipt.json`
 * its receipt. The slug is the only name a caller supplies, and it is
 * validated against a closed alphabet — a diagram tool can never be talked
 * into writing outside the directory.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isDiagramKind, type Diagram, type DiagramKind } from '@kinqs/brainrouter-types';
import { canonicalDiagramJson } from './render/checks.js';

export const DIAGRAM_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function diagramsDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.brainrouter', 'diagrams');
}

export function isDiagramSlug(value: unknown): value is string {
  return typeof value === 'string' && DIAGRAM_SLUG_RE.test(value);
}

/** A stable slug from a title: lowercase, runs of non-alphanumerics collapsed to one dash, ≤ 64 chars. */
export function slugifyDiagramTitle(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/g, '');
  return isDiagramSlug(slug) ? slug : 'diagram';
}

export interface DiagramPaths { dir: string; spec: string; html: string; receipt: string }

export function diagramPaths(workspaceRoot: string, slug: string): DiagramPaths {
  if (!isDiagramSlug(slug)) throw new Error(`Invalid diagram slug "${slug}": use lowercase letters, digits, and dashes.`);
  const dir = diagramsDir(workspaceRoot);
  const html = path.join(dir, `${slug}.html`);
  return { dir, spec: path.join(dir, `${slug}.json`), html, receipt: `${html}.receipt.json` };
}

/** Persist a validated document as pretty canonical JSON; returns the spec path. */
export function writeDiagramSpec(workspaceRoot: string, slug: string, doc: Diagram): string {
  const p = diagramPaths(workspaceRoot, slug);
  fs.mkdirSync(p.dir, { recursive: true });
  fs.writeFileSync(p.spec, `${JSON.stringify(JSON.parse(canonicalDiagramJson(doc)), null, 2)}\n`, 'utf8');
  return p.spec;
}

/** The stored specification, or null when absent or unreadable. Untrusted: validate before use. */
export function readDiagramSpec(workspaceRoot: string, slug: string): unknown | null {
  if (!isDiagramSlug(slug)) return null;
  try {
    return JSON.parse(fs.readFileSync(diagramPaths(workspaceRoot, slug).spec, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

export interface DiagramListEntry { slug: string; title?: string; kind?: DiagramKind; hasHtml: boolean; hasReceipt: boolean }

/** Every stored diagram, by slug, with what the spec says about itself (without validating it). */
export function listDiagrams(workspaceRoot: string): DiagramListEntry[] {
  const dir = diagramsDir(workspaceRoot);
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out: DiagramListEntry[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json') || name.endsWith('.receipt.json')) continue;
    const slug = name.slice(0, -'.json'.length);
    if (!isDiagramSlug(slug)) continue;
    const spec = readDiagramSpec(workspaceRoot, slug) as { kind?: unknown; meta?: { title?: unknown } } | null;
    const entry: DiagramListEntry = {
      slug,
      hasHtml: fs.existsSync(path.join(dir, `${slug}.html`)),
      hasReceipt: fs.existsSync(path.join(dir, `${slug}.html.receipt.json`)),
    };
    if (spec && isDiagramKind(spec.kind)) entry.kind = spec.kind;
    if (typeof spec?.meta?.title === 'string') entry.title = spec.meta.title;
    out.push(entry);
  }
  return out;
}
