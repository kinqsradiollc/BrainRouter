// ADR-056 D-A5 — diagram tools. `diagram_validate` checks a typed diagram
// document and returns path-prefixed diagnostics; `diagram_render` validates,
// renders deterministically, runs the nine artifact checks, and — only when
// every check passes — delivers the HTML, its receipt, and the specification
// under the workspace's `.brainrouter/diagrams/<slug>` files. The slug is the
// only name the caller controls and it is validated against a closed alphabet,
// so the tool cannot be steered outside that directory. A failed render keeps a
// previous artifact untouched and says so.

import path from 'node:path';
import type { DiagramDiagnostic } from '@kinqs/brainrouter-types';
import { validateDiagram } from '../../../diagram/schema.js';
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
  diagram_validate: async ({ args }) => {
    const v = validateDiagram(parseDocument(args.document), args.quality === 'standard' ? { quality: 'standard' } : {});
    const head = v.ok
      ? `Valid ${v.kind} diagram — ${v.errorCount} errors, ${v.warningCount} warnings.`
      : `Invalid${v.kind ? ` ${v.kind}` : ''} diagram — ${v.errorCount} errors, ${v.warningCount} warnings. Fix every error (and, under showcase, every warning) before rendering.`;
    return v.diagnostics.length ? `${head}\n${formatDiagnostics(v.diagnostics)}` : head;
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
    const result = deliverDiagram(document, paths.html, { theme: themeOf(args.theme) });
    const rel = (p: string): string => path.relative(host.workspaceRoot, p) || p;
    if (!result.ok) {
      const failed = (result.receipt?.checks ?? []).filter((c) => !c.ok).map((c) => `- [check] ${c.id}${c.detail ? ` — ${c.detail}` : ''}`);
      return [
        `Not delivered${result.previousKept ? ` — the previous ${rel(paths.html)} was left untouched` : ''}.`,
        formatDiagnostics(result.diagnostics),
        ...failed,
      ].filter(Boolean).join('\n');
    }
    const v = validateDiagram(document);
    if (v.diagram) writeDiagramSpec(host.workspaceRoot, slug, v.diagram);
    const r = result.receipt!;
    const passed = r.checks.filter((c) => c.ok).length;
    return [
      `Delivered "${r.title}" (${r.kind}) as ${slug}.`,
      `- artifact: ${rel(paths.html)} · ${r.artifact.bytes} bytes · sha256 ${r.artifact.sha256}`,
      `- specification: ${rel(paths.spec)} · ${r.specification.bytes} bytes · sha256 ${r.specification.sha256}`,
      `- receipt: ${rel(paths.receipt)} · checks ${passed}/${r.checks.length} · evidence ${r.evidence} · renderer ${r.renderer.name}@${r.renderer.version}`,
      ...(result.diagnostics.length ? [formatDiagnostics(result.diagnostics)] : []),
      `Open it with /diagram open ${slug}; re-render with the same slug to replace it.`,
    ].join('\n');
  },
};
