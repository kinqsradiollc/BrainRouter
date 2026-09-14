/**
 * Architecture delta (ADR-056 D-A4): two validated documents of the same kind
 * → exact facts, a Before · Delta · After artifact, and a bounded markdown
 * block a review can carry.
 *
 * Facts are computed on the canonical documents (sorted keys, no layout), so
 * a re-ordered file is not a change and a moved element is a moved element:
 *   - `added` / `removed` — an element or relationship id present on one side;
 *   - `rerouted`         — a relationship keeps its id but `from`/`to` changed;
 *   - `moved`            — an element's placement changed: a different
 *                          boundary, lane, or stage, or an authored column/row;
 *   - `changed`          — anything else about the same id (label, type,
 *                          description, sources, style, kind, wraps, …).
 * `meta` differences (title, subtitle, views) are reported as `changed` on
 * the `meta` subject. The receipt carries the SHA-256 of both canonical
 * specifications and never a timestamp, so an unchanged pair yields an
 * unchanged receipt. This is EVIDENCE, not a finding: no model reads it to
 * produce it, and nothing here gates a merge.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Diagram, DiagramKind } from '@kinqs/brainrouter-types';
import { diagramElementArrays } from '@kinqs/brainrouter-types';
import { findGitRoot, gitHeadSha } from '../git/workspaceGit.js';
import { validateDiagram } from './schema.js';
import { canonicalDiagramJson, sha256 } from './render/checks.js';
import { layoutDiagram } from './render/layout.js';
import { sceneToSvg, escapeXml } from './render/svg.js';
import { DIAGRAM_RENDERER_VERSION } from './render/checks.js';
import { DIAGRAM_TOKEN_CSS } from './render/html.js';
import { diagramsDir, isDiagramSlug, listDiagrams } from './store.js';

export type DeltaFactKind = 'added' | 'removed' | 'changed' | 'moved' | 'rerouted';

export interface DeltaFact {
  kind: DeltaFactKind;
  /** The element array the subject lives in (`components`, `connections`, …) or `meta`. */
  subject: string;
  id: string;
  label?: string;
  /** For `changed`/`moved`/`rerouted`: the fields that differ, with before/after values (canonical JSON). */
  fields?: Array<{ field: string; before?: string; after?: string }>;
}

export interface DiagramDeltaReceipt {
  receiptVersion: 1;
  kind: DiagramKind;
  title: string;
  base: { sha256: string; title: string };
  head: { sha256: string; title: string };
  identical: boolean;
  counts: Record<DeltaFactKind, number>;
  facts: DeltaFact[];
  comparator: { name: 'brainrouter-diagram-delta'; version: string };
}

type Rec = Record<string, unknown>;
const canon = (v: unknown): string => JSON.stringify(v, (_k, val) => (val && typeof val === 'object' && !Array.isArray(val) ? Object.fromEntries(Object.keys(val as Rec).sort().map((k) => [k, (val as Rec)[k]])) : val));

/** Placement-defining fields per kind: a change here is `moved`, not `changed`. */
const PLACEMENT_FIELDS = new Set(['column', 'row', 'lane', 'stage']);

/** Which boundary/group wraps each element id (architecture only). */
function wrappedBy(doc: Diagram): Map<string, string> {
  const out = new Map<string, string>();
  if (doc.kind === 'architecture') for (const b of doc.boundaries ?? []) for (const id of b.wraps) out.set(id, b.id);
  return out;
}

function elementFacts(name: string, base: Rec[], head: Rec[], baseWrap: Map<string, string>, headWrap: Map<string, string>, out: DeltaFact[]): void {
  const b = new Map(base.map((e) => [String(e.id), e]));
  const h = new Map(head.map((e) => [String(e.id), e]));
  const label = (e: Rec | undefined): string | undefined => (typeof e?.label === 'string' ? e.label : undefined);
  for (const [id, e] of b) if (!h.has(id)) out.push({ kind: 'removed', subject: name, id, ...(label(e) ? { label: label(e) } : {}) });
  for (const [id, e] of h) if (!b.has(id)) out.push({ kind: 'added', subject: name, id, ...(label(e) ? { label: label(e) } : {}) });
  for (const [id, he] of h) {
    const be = b.get(id);
    if (!be) continue;
    const fields = new Set([...Object.keys(be), ...Object.keys(he)]);
    const diffs: Array<{ field: string; before?: string; after?: string }> = [];
    for (const f of [...fields].sort()) {
      if (f === 'id' || f === 'evidence') continue; // evidence is a verification state, not a design fact
      const bv = be[f], hv = he[f];
      if (f === 'sources') {
        const strip = (v: unknown) => Array.isArray(v) ? v.map((s) => { const { revision: _r, ...rest } = (s as Rec); return rest; }) : v;
        if (canon(strip(bv)) === canon(strip(hv))) continue;
      } else if (canon(bv) === canon(hv)) continue;
      diffs.push({ field: f, ...(bv !== undefined ? { before: canon(bv) } : {}), ...(hv !== undefined ? { after: canon(hv) } : {}) });
    }
    const bw = baseWrap.get(id), hw = headWrap.get(id);
    if (bw !== hw) diffs.push({ field: 'boundary', ...(bw ? { before: canon(bw) } : {}), ...(hw ? { after: canon(hw) } : {}) });
    if (!diffs.length) continue;
    const isRelation = 'from' in he || 'from' in be;
    let kind: DeltaFactKind = 'changed';
    if (isRelation && diffs.some((d) => d.field === 'from' || d.field === 'to')) kind = 'rerouted';
    else if (!isRelation && diffs.every((d) => PLACEMENT_FIELDS.has(d.field) || d.field === 'boundary')) kind = 'moved';
    out.push({ kind, subject: name, id, ...(label(he) ? { label: label(he) } : {}), fields: diffs });
  }
}

/** Compare two validated documents of the same kind. Throws on a kind mismatch (that is not a delta, it is a different diagram). */
export function compareDiagrams(base: Diagram, head: Diagram): DiagramDeltaReceipt {
  if (base.kind !== head.kind) throw new Error(`Cannot compare a ${base.kind} diagram with a ${head.kind} diagram.`);
  const facts: DeltaFact[] = [];
  const baseWrap = wrappedBy(base), headWrap = wrappedBy(head);
  for (const name of diagramElementArrays(base.kind)) {
    const b = ((base as unknown as Rec)[name] as Rec[] | undefined) ?? [];
    const h = ((head as unknown as Rec)[name] as Rec[] | undefined) ?? [];
    if (name === 'activations') {
      // Activations have no id: treat the whole list as one canonical value.
      if (canon(b) !== canon(h)) facts.push({ kind: 'changed', subject: name, id: 'activations', fields: [{ field: 'activations', before: canon(b), after: canon(h) }] });
      continue;
    }
    elementFacts(name, b, h, baseWrap, headWrap, facts);
  }
  const metaDiffs: DeltaFact['fields'] = [];
  const bm = base.meta as unknown as Rec, hm = head.meta as unknown as Rec;
  for (const f of [...new Set([...Object.keys(bm), ...Object.keys(hm)])].sort()) {
    if (f === 'repository') continue; // where it was verified is not what it says
    if (canon(bm[f]) !== canon(hm[f])) metaDiffs.push({ field: f, ...(bm[f] !== undefined ? { before: canon(bm[f]) } : {}), ...(hm[f] !== undefined ? { after: canon(hm[f]) } : {}) });
  }
  if (metaDiffs.length) facts.push({ kind: 'changed', subject: 'meta', id: 'meta', fields: metaDiffs });
  const mainBase = (base as { mainPath?: string[] }).mainPath, mainHead = (head as { mainPath?: string[] }).mainPath;
  if (canon(mainBase) !== canon(mainHead)) facts.push({ kind: 'rerouted', subject: 'mainPath', id: 'mainPath', fields: [{ field: 'mainPath', ...(mainBase ? { before: canon(mainBase) } : {}), ...(mainHead ? { after: canon(mainHead) } : {}) }] });
  const order: DeltaFactKind[] = ['removed', 'added', 'rerouted', 'moved', 'changed'];
  facts.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.subject.localeCompare(b.subject) || a.id.localeCompare(b.id));
  const counts: Record<DeltaFactKind, number> = { added: 0, removed: 0, changed: 0, moved: 0, rerouted: 0 };
  for (const f of facts) counts[f.kind]++;
  return {
    receiptVersion: 1,
    kind: base.kind,
    title: head.meta.title,
    base: { sha256: sha256(canonicalDiagramJson(base)), title: base.meta.title },
    head: { sha256: sha256(canonicalDiagramJson(head)), title: head.meta.title },
    identical: facts.length === 0,
    counts,
    facts,
    comparator: { name: 'brainrouter-diagram-delta', version: DIAGRAM_RENDERER_VERSION },
  };
}

/** A bounded markdown block for a review prompt or a PR comment. Empty string when identical. */
export function diagramDeltaMarkdown(receipt: DiagramDeltaReceipt, opts: { maxFacts?: number; slug?: string } = {}): string {
  if (receipt.identical) return '';
  const max = opts.maxFacts ?? 40;
  const c = receipt.counts;
  const head = `### Architecture delta${opts.slug ? ` — \`${opts.slug}\`` : ''} (${receipt.kind}: ${receipt.title})`;
  const summary = `${c.added} added · ${c.removed} removed · ${c.rerouted} rerouted · ${c.moved} moved · ${c.changed} changed — deterministic comparison of the pinned diagram specifications (base ${receipt.base.sha256.slice(0, 12)} → head ${receipt.head.sha256.slice(0, 12)}); evidence, not a finding.`;
  const lines = receipt.facts.slice(0, max).map((f) => {
    const what = f.label ? `${f.id} ("${f.label}")` : f.id;
    const fields = f.fields?.map((d) => `${d.field}: ${d.before ?? '∅'} → ${d.after ?? '∅'}`).join('; ');
    return `- **${f.kind}** ${f.subject}/${what}${fields ? ` — ${fields}` : ''}`;
  });
  if (receipt.facts.length > max) lines.push(`- … ${receipt.facts.length - max} more`);
  return [head, summary, ...lines].join('\n');
}

const DELTA_CSS = `
.dd-panes{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;padding:12px}.dd-pane{border:1px solid var(--dg-border);border-radius:var(--dg-radius);background:var(--dg-panel);min-width:0;overflow:auto}.dd-pane h2{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--dg-muted);margin:0;padding:8px 12px;border-bottom:1px solid var(--dg-border)}
.dd-pane svg{width:100%;height:auto}.dd-facts{padding:12px 16px}.dd-facts table{border-collapse:collapse;width:100%;font-size:12px}.dd-facts th,.dd-facts td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--dg-border);vertical-align:top}.dd-facts code{font-family:var(--dg-mono);font-size:11px}
.dd-kind{display:inline-block;padding:1px 6px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:.04em}.dd-kind-added{background:var(--dg-backend);color:var(--dg-bg)}.dd-kind-removed{background:var(--dg-security);color:var(--dg-bg)}.dd-kind-changed{background:var(--dg-cloud);color:var(--dg-bg)}.dd-kind-moved{background:var(--dg-database);color:var(--dg-bg)}.dd-kind-rerouted{background:var(--dg-frontend);color:var(--dg-bg)}
.dg-delta-added .dg-shape{stroke:var(--dg-backend)!important;stroke-width:3.5}.dg-delta-changed .dg-shape{stroke:var(--dg-cloud)!important;stroke-width:3}.dg-delta-moved .dg-shape{stroke:var(--dg-database)!important;stroke-width:3;stroke-dasharray:6 3}.dg-delta-rerouted .dg-path{stroke:var(--dg-frontend)!important;stroke-width:3}.dg-delta-added .dg-path{stroke:var(--dg-backend)!important;stroke-width:3}.dg-delta-changed .dg-path{stroke:var(--dg-cloud)!important;stroke-width:2.5}
.dg-delta-removed .dg-shape{stroke:var(--dg-security)!important;stroke-dasharray:3 3;opacity:.7}.dg-delta-removed .dg-path{stroke:var(--dg-security)!important;stroke-dasharray:3 3;opacity:.7}.dg-delta-removed .dg-label{fill:var(--dg-security)}
@media (max-width:1100px){.dd-panes{grid-template-columns:1fr}}
`;

function annotate(svg: string, ids: Map<string, DeltaFactKind>): string {
  return svg.replace(/<g data-id="([^"]+)"([^>]*)class="([^"]*)"/g, (m, id: string, mid: string, cls: string) => {
    const kind = ids.get(id);
    return kind ? `<g data-id="${id}"${mid}class="${cls} dg-delta-${kind}"` : m;
  });
}

/** Before · Delta · After: one self-contained HTML. The Delta pane is the head layout with facts highlighted and removed elements ghosted from the base. */
export function renderDiagramDelta(base: Diagram, head: Diagram, receipt: DiagramDeltaReceipt, opts: { theme?: 'auto' | 'dark' | 'light' } = {}): string {
  const baseSvg = sceneToSvg(layoutDiagram(base));
  const headSvg = sceneToSvg(layoutDiagram(head));
  const headMarks = new Map<string, DeltaFactKind>();
  const baseMarks = new Map<string, DeltaFactKind>();
  for (const f of receipt.facts) {
    if (f.subject === 'meta' || f.subject === 'mainPath' || f.subject === 'activations') continue;
    if (f.kind === 'removed') baseMarks.set(f.id, 'removed'); else headMarks.set(f.id, f.kind);
  }
  const deltaSvg = annotate(headSvg, headMarks);
  const beforeSvg = annotate(baseSvg, baseMarks);
  const rows = receipt.facts.map((f) => `<tr><td><span class="dd-kind dd-kind-${f.kind}">${f.kind}</span></td><td><code>${escapeXml(f.subject)}/${escapeXml(f.id)}</code>${f.label ? ` ${escapeXml(f.label)}` : ''}</td><td>${(f.fields ?? []).map((d) => `<code>${escapeXml(d.field)}</code>: ${escapeXml(d.before ?? '∅')} → ${escapeXml(d.after ?? '∅')}`).join('<br>')}</td></tr>`).join('');
  return deltaHtml(head, receipt, opts.theme ?? head.meta.theme ?? 'auto', beforeSvg, deltaSvg, headSvg, rows);
}

/** The delta page: the viewer's token block (same source) plus the three-pane chrome; no script. */
function deltaHtml(head: Diagram, receipt: DiagramDeltaReceipt, theme: string, beforeSvg: string, deltaSvg: string, afterSvg: string, rows: string): string {
  const tokenCss = DIAGRAM_TOKEN_CSS;
  return `<!doctype html>
<html lang="en" data-theme="${escapeXml(theme)}" data-diagram-kind="${head.kind}" data-renderer="brainrouter-diagram-delta/${escapeXml(receipt.comparator.version)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;">
<title>${escapeXml(receipt.title)} — delta</title>
<style>${tokenCss}${DELTA_CSS}</style>
</head>
<body>
<header class="dg-bar"><h1 class="dg-title">${escapeXml(receipt.title)}</h1><p class="dg-subtitle">Before · Delta · After — ${receipt.counts.added} added, ${receipt.counts.removed} removed, ${receipt.counts.rerouted} rerouted, ${receipt.counts.moved} moved, ${receipt.counts.changed} changed</p></header>
<main class="dd-panes">
<section class="dd-pane"><h2>Before · ${escapeXml(receipt.base.sha256.slice(0, 12))}</h2>${beforeSvg}</section>
<section class="dd-pane"><h2>Delta</h2>${deltaSvg}</section>
<section class="dd-pane"><h2>After · ${escapeXml(receipt.head.sha256.slice(0, 12))}</h2>${afterSvg}</section>
</main>
<section class="dd-facts"><table><thead><tr><th>Fact</th><th>Subject</th><th>Fields</th></tr></thead><tbody>${rows || '<tr><td colspan="3">Identical.</td></tr>'}</tbody></table></section>
</body>
</html>
`;
}

/** The pinned specification for a slug as committed at `revision`, or null when absent/unparseable. Untrusted: validate before use. */
export function readDiagramSpecAtRevision(workspaceRoot: string, revision: string, slug: string): unknown | null {
  if (!isDiagramSlug(slug)) return null;
  const gitRoot = findGitRoot(workspaceRoot);
  if (!gitRoot) return null;
  const real = (p: string): string => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const prefix = path.relative(real(gitRoot), real(workspaceRoot)).split(path.sep).filter((s) => s && s !== '.').join('/');
  const rel = `${prefix ? `${prefix}/` : ''}.brainrouter/diagrams/${slug}.json`;
  const r = spawnSync('git', ['-C', gitRoot, 'show', `${revision}:${rel}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout) as unknown; } catch { return null; }
}

export interface DiagramReviewDelta { slug: string; receipt: DiagramDeltaReceipt; markdown: string }

/**
 * Every pinned diagram whose working-tree specification differs from the one
 * committed at `baseRevision` (HEAD by default), compared and rendered as
 * markdown — the block a local review prepends beside the Atlas blast radius.
 * Deterministic and model-free; empty when nothing changed or nothing is pinned.
 */
export function diagramReviewDeltas(workspaceRoot: string, opts: { baseRevision?: string; maxFacts?: number } = {}): DiagramReviewDelta[] {
  const out: DiagramReviewDelta[] = [];
  const gitRoot = findGitRoot(workspaceRoot);
  if (!gitRoot) return out;
  const base = opts.baseRevision ?? gitHeadSha(gitRoot);
  if (!base) return out;
  for (const entry of listDiagrams(workspaceRoot)) {
    let headRaw: unknown;
    try { headRaw = JSON.parse(fs.readFileSync(path.join(diagramsDir(workspaceRoot), `${entry.slug}.json`), 'utf8')) as unknown; } catch { continue; }
    const baseRaw = readDiagramSpecAtRevision(workspaceRoot, base, entry.slug);
    if (!baseRaw) continue;
    const bv = validateDiagram(baseRaw, { quality: 'standard' }), hv = validateDiagram(headRaw, { quality: 'standard' });
    if (!bv.diagram || !hv.diagram || bv.diagram.kind !== hv.diagram.kind) continue;
    const receipt = compareDiagrams(bv.diagram, hv.diagram);
    if (receipt.identical) continue;
    out.push({ slug: entry.slug, receipt, markdown: diagramDeltaMarkdown(receipt, { slug: entry.slug, ...(opts.maxFacts ? { maxFacts: opts.maxFacts } : {}) }) });
  }
  return out;
}

/** One combined block for a review prompt, or '' when there is nothing to say. */
export function buildDiagramDeltaContext(workspaceRoot: string, opts: { baseRevision?: string } = {}): string {
  return diagramReviewDeltas(workspaceRoot, { ...opts, maxFacts: 25 }).map((d) => d.markdown).join('\n\n');
}
