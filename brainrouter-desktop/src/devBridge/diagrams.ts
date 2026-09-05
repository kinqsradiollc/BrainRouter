/**
 * ADR-056 D-A5 — devBridge fixtures for the Diagrams panel, so the surface
 * renders populated in a plain browser (rules 06 §4). The artifact is a
 * hand-written miniature of what the core renderer emits (same data hooks and
 * token names); the renderer bundle cannot import the Node-only renderer.
 */
import type { DiagramDeltaResult, DiagramListRow, DiagramReadResult } from '../lib/diagrams/types.js';

const MINI_HTML = (title: string, theme: 'dark' | 'light'): string => `<!doctype html>
<html lang="en" data-theme="${theme}" data-diagram-kind="architecture"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;">
<title>${title}</title>
<style>:root{--dg-bg:#0b1020;--dg-panel:#111a2e;--dg-ink:#eef2ff;--dg-muted:#94a3b8;--dg-edge:#64748b;--dg-frontend:#22d3ee;--dg-backend:#34d399;--dg-database:#a78bfa}
[data-theme="light"]{--dg-bg:#f8fafc;--dg-panel:#ffffff;--dg-ink:#0f172a;--dg-muted:#475569;--dg-edge:#64748b}
html,body{margin:0;background:var(--dg-bg);color:var(--dg-ink);font:13px system-ui,sans-serif}.dg-shape{fill:var(--dg-panel);stroke:var(--dg-edge);stroke-width:1.5}.dg-label{fill:var(--dg-ink);font-weight:600}.dg-path{fill:none;stroke:var(--dg-edge);stroke-width:1.5}
.dg-type-frontend .dg-shape{stroke:var(--dg-frontend)}.dg-type-backend .dg-shape{stroke:var(--dg-backend)}.dg-type-database .dg-shape{stroke:var(--dg-database)}</style></head>
<body><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 200" width="720" height="200" class="dg-svg" role="img" aria-label="diagram">
<g data-id="c1" data-from="web" data-to="api" class="dg-edge"><path d="M188 100 L292 100" class="dg-path"/></g>
<g data-id="c3" data-from="api" data-to="orders-db" class="dg-edge"><path d="M452 100 L556 100" class="dg-path"/></g>
<g data-id="web" data-type="frontend" class="dg-node dg-type-frontend"><rect x="48" y="72" width="140" height="56" rx="8" class="dg-shape"/><text x="118" y="100" class="dg-label" text-anchor="middle" dominant-baseline="middle">Web app</text></g>
<g data-id="api" data-type="backend" class="dg-node dg-type-backend"><rect x="292" y="72" width="160" height="56" rx="8" class="dg-shape"/><text x="372" y="100" class="dg-label" text-anchor="middle" dominant-baseline="middle">Orders API</text></g>
<g data-id="orders-db" data-type="database" class="dg-node dg-type-database"><rect x="556" y="72" width="140" height="56" rx="8" class="dg-shape"/><text x="626" y="100" class="dg-label" text-anchor="middle" dominant-baseline="middle">Orders DB</text></g>
</svg></body></html>`;

const CHECKS = ['schema', 'ids-unique', 'nodes-no-overlap', 'edge-clear-of-unrelated-nodes', 'labels-no-collision', 'viewport-bounded', 'legend-complete', 'html-self-contained', 'artifact-size'];

export function devDiagramList(): DiagramListRow[] {
  return [
    { slug: 'checkout-platform', title: 'Checkout platform', kind: 'architecture', hasHtml: true, hasReceipt: true, checksPassed: 9, checksTotal: 9, evidence: 'mixed' },
    { slug: 'create-order', title: 'Create order', kind: 'sequence', hasHtml: true, hasReceipt: true, checksPassed: 9, checksTotal: 9, evidence: 'authored' },
    { slug: 'job-lifecycle', title: 'Job lifecycle', kind: 'lifecycle', hasHtml: false, hasReceipt: false },
  ];
}

export function devDiagramRead(slug: string): DiagramReadResult | null {
  const row = devDiagramList().find((r) => r.slug === slug);
  if (!row) return null;
  if (!row.hasHtml) return { slug, html: null, receipt: null, kind: row.kind, title: row.title, sources: [] };
  return {
    slug,
    kind: row.kind,
    title: row.title,
    html: MINI_HTML(row.title ?? slug, 'dark'),
    receipt: {
      receiptVersion: 1, kind: row.kind ?? 'architecture', title: row.title ?? slug, ok: true,
      checks: CHECKS.map((id) => ({ id, ok: true })),
      specification: { sha256: 'a'.repeat(64), bytes: 1_812 }, artifact: { sha256: 'b'.repeat(64), bytes: 24_310, format: 'html' },
      renderer: { name: 'brainrouter-diagram', version: '1.0.0' }, evidence: row.evidence ?? 'authored',
    },
    sources: slug === 'checkout-platform'
      ? [{ id: 'api', label: 'Orders API', evidence: 'verified', sources: [{ path: 'packages/core/src/review/service.ts', lines: [1, 40], revision: 'c'.repeat(40) }] }, { id: 'web', label: 'Web app', sources: [{ path: 'brainrouter-desktop/src/App.tsx' }] }]
      : [],
  };
}

export function devDiagramDelta(slug: string): DiagramDeltaResult {
  if (slug !== 'checkout-platform') return { slug, base: 'HEAD', identical: true, counts: { added: 0, removed: 0, changed: 0, moved: 0, rerouted: 0 }, facts: [], html: null };
  return {
    slug, base: 'HEAD', identical: false,
    counts: { added: 1, removed: 0, changed: 1, moved: 0, rerouted: 0 },
    facts: [
      { kind: 'added', subject: 'components', id: 'cache', label: 'Cache' },
      { kind: 'changed', subject: 'connections', id: 'c1', label: 'HTTPS JSON', fields: [{ field: 'label', before: '"HTTPS JSON"', after: '"HTTPS JSON (v2)"' }] },
    ],
    html: MINI_HTML('Checkout platform — delta', 'dark'),
  };
}
