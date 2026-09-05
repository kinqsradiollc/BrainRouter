// ADR-056 D-A5 — diagram tools. `diagram_validate` checks a typed diagram
// document and returns path-prefixed diagnostics; `diagram_render` validates,
// renders deterministically, runs the nine artifact checks, and — only when
// every check passes — delivers the HTML, its receipt, and the specification
// under the workspace's `.brainrouter/diagrams/<slug>` files. The slug is the
// only name the caller controls and it is validated against a closed alphabet,
// so the tool cannot be steered outside that directory. A failed render keeps a
// previous artifact untouched and says so. Both verify repository evidence by
// default (diagram_validate on request), so a delivered artifact's receipt says
// what the repository confirmed; diagram_draft seeds an architecture document
// from the Atlas graph for the agent to curate.

import path from 'node:path';
import type { DiagramDiagnostic } from '@kinqs/brainrouter-types';
import { validateDiagram } from '../../../diagram/schema.js';
import { verifyDiagramEvidence } from '../../../diagram/evidence.js';
import { draftDiagramFromAtlas, type DraftOptions } from '../../../diagram/draft.js';
import { readAtlasGraph } from '../../../atlas/store/atlasStore.js';
import { deliverDiagram } from '../../../diagram/render/render.js';
import { diagramPaths, isDiagramSlug, slugifyDiagramTitle, writeDiagramSpec } from '../../../diagram/store.js';
import { getCliKnobs } from '../../../config/config.js';
import type { BuiltinToolHandler } from './registry.js';

const MAX_DIAGNOSTICS = 20;

function parseDocument(raw: unknown): unknown {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as unknown; } catch { return raw; }
  }
  return raw;
}

function formatDiagnostics(list: DiagramDiagnostic[]): string {
  const shown = list.slice(0, MAX_DIAGNOSTICS).map((d) =>
    `- [${d.severity}] ${d.path || '(document)'} — ${d.message}${d.supportedFixes?.length ? ` (fixes: ${d.supportedFixes.join(' · ')})` : ''}`);
  if (list.length > MAX_DIAGNOSTICS) shown.push(`- … ${list.length - MAX_DIAGNOSTICS} more`);
  return shown.join('\n');
}

function themeOf(raw: unknown): 'auto' | 'dark' | 'light' {
  if (raw === 'dark' || raw === 'light' || raw === 'auto') return raw;
  return getCliKnobs().diagram.theme;
}

export const diagramHandlers: Record<string, BuiltinToolHandler> = {
  diagram_validate: async ({ args, host }) => {
    const v = validateDiagram(parseDocument(args.document), args.quality === 'standard' ? { quality: 'standard' } : {});
    const head = v.ok
      ? `Valid ${v.kind} diagram — ${v.errorCount} errors, ${v.warningCount} warnings.`
      : `Invalid${v.kind ? ` ${v.kind}` : ''} diagram — ${v.errorCount} errors, ${v.warningCount} warnings. Fix every error (and, under showcase, every warning) before rendering.`;
    const lines = v.diagnostics.length ? [head, formatDiagnostics(v.diagnostics)] : [head];
    if (args.verify === true && v.ok && v.diagram) {
      const e = verifyDiagramEvidence(v.diagram, host.workspaceRoot);
      lines.push(`Evidence${e.revision ? ` at ${e.revision.slice(0, 12)}` : ''}: ${e.counts.verified} verified, ${e.counts.unverified} unverified, ${e.counts.unsourced} without sources.`);
      if (e.diagnostics.length) lines.push(formatDiagnostics(e.diagnostics));
    }
    return lines.join('\n');
  },

  diagram_draft: async ({ args, host }) => {
    const graph = readAtlasGraph(host.workspaceRoot);
    if (!graph) return 'No codebase map for this workspace — build one with /atlas (and /atlas enrich for named layer relationships), then draft again.';
    if (!graph.layers.length) return 'The codebase map has no layers yet — run /atlas enrich so the draft has components to work from.';
    const opts: DraftOptions = {};
    if (Array.isArray(args.layers)) opts.layers = args.layers.map((l: unknown) => String(l));
    if (typeof args.pathPrefix === 'string' && args.pathPrefix.trim()) opts.pathPrefix = args.pathPrefix.trim();
    if (typeof args.title === 'string' && args.title.trim()) opts.title = args.title.trim();
    if (typeof args.maxComponents === 'number') opts.maxComponents = Math.floor(args.maxComponents);
    const d = draftDiagramFromAtlas(graph, opts);
    return [
      `Draft architecture diagram from the codebase map (${d.diagram.components.length} components, ${d.diagram.connections.length} connections${d.omittedLayers.length ? `; omitted ${d.omittedLayers.length} layers` : ''}).`,
      ...d.notes.map((n) => `- ${n}`),
      'Document (curate it, then diagram_validate / diagram_render):',
      JSON.stringify(d.diagram, null, 2),
    ].join('\n');
  },

  diagram_render: async ({ args, host }) => {
    const document = parseDocument(args.document);
    const titled = document && typeof document === 'object' ? (document as { meta?: { title?: unknown } }).meta?.title : undefined;
    const slug = typeof args.slug === 'string' && args.slug.trim()
      ? args.slug.trim()
      : slugifyDiagramTitle(typeof titled === 'string' ? titled : 'diagram');
    if (!isDiagramSlug(slug)) {
      throw new Error(`diagram_render: slug "${slug}" is invalid — use lowercase letters, digits, and dashes (≤ 64 chars).`);
    }
    const paths = diagramPaths(host.workspaceRoot, slug);
    // Verify repository evidence before rendering so the receipt reports what the
    // repository confirmed; a verification warning never blocks delivery.
    const pre = validateDiagram(document);
    let toRender: unknown = document;
    let evidenceNote = '';
    if (pre.ok && pre.diagram && args.verify !== false) {
      const e = verifyDiagramEvidence(pre.diagram, host.workspaceRoot);
      toRender = e.diagram;
      evidenceNote = `- evidence${e.revision ? ` at ${e.revision.slice(0, 12)}` : ''}: ${e.counts.verified} verified, ${e.counts.unverified} unverified, ${e.counts.unsourced} without sources${e.diagnostics.length ? `\n${formatDiagnostics(e.diagnostics)}` : ''}`;
    }
    const result = deliverDiagram(toRender, paths.html, { theme: themeOf(args.theme) });
    const rel = (p: string): string => path.relative(host.workspaceRoot, p) || p;
    if (!result.ok) {
      const failed = (result.receipt?.checks ?? []).filter((c) => !c.ok).map((c) => `- [check] ${c.id}${c.detail ? ` — ${c.detail}` : ''}`);
      return [
        `Not delivered${result.previousKept ? ` — the previous ${rel(paths.html)} was left untouched` : ''}.`,
        formatDiagnostics(result.diagnostics),
        ...failed,
      ].filter(Boolean).join('\n');
    }
    const v = validateDiagram(toRender);
    if (v.diagram) writeDiagramSpec(host.workspaceRoot, slug, v.diagram);
    const r = result.receipt!;
    const passed = r.checks.filter((c) => c.ok).length;
    return [
      `Delivered "${r.title}" (${r.kind}) as ${slug}.`,
      `- artifact: ${rel(paths.html)} · ${r.artifact.bytes} bytes · sha256 ${r.artifact.sha256}`,
      `- specification: ${rel(paths.spec)} · ${r.specification.bytes} bytes · sha256 ${r.specification.sha256}`,
      `- receipt: ${rel(paths.receipt)} · checks ${passed}/${r.checks.length} · evidence ${r.evidence} · renderer ${r.renderer.name}@${r.renderer.version}`,
      ...(evidenceNote ? [evidenceNote] : []),
      ...(result.diagnostics.length ? [formatDiagnostics(result.diagnostics)] : []),
      `Open it with /diagram open ${slug}; re-render with the same slug to replace it.`,
    ].join('\n');
  },
};
