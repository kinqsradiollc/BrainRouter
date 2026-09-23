/**
 * Scene → inline SVG (ADR-056 D-A2). Pure string building, no DOM. Every
 * colour is a CSS variable (`var(--dg-*)`) so the same SVG renders in both
 * themes and the artifact checks can assert that no literal colour slipped in.
 * Elements carry `data-id` / `data-type` / `data-from` / `data-to` hooks the
 * viewer runtime (html.ts) uses for search, focus, and relationship tracing.
 */
import { METRICS, textWidth, type PlacedEdge, type PlacedNode, type Scene } from './layout.js';

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));

function nodeSvg(n: PlacedNode): string {
  const cls = `dg-node dg-type-${n.type}${n.variant ? ` dg-variant-${n.variant}` : ''}${n.primary ? ' dg-primary' : ''}${n.evidence ? ` dg-evidence-${n.evidence}` : ''}`;
  const attrs = `data-id="${escapeXml(n.id)}" data-type="${n.type}" class="${cls}" tabindex="0" role="button" aria-label="${escapeXml(n.label)}"`;
  const cx = n.x + n.w / 2;
  let shape: string;
  switch (n.shape) {
    case 'pill':
      shape = `<rect x="${fmt(n.x)}" y="${fmt(n.y)}" width="${fmt(n.w)}" height="${fmt(n.h)}" rx="${fmt(n.h / 2)}" class="dg-shape"/>`;
      break;
    case 'diamond': {
      const cy = n.y + n.h / 2;
      shape = `<polygon points="${fmt(cx)},${fmt(n.y - 8)} ${fmt(n.x + n.w + 8)},${fmt(cy)} ${fmt(cx)},${fmt(n.y + n.h + 8)} ${fmt(n.x - 8)},${fmt(cy)}" class="dg-shape"/>`;
      break;
    }
    case 'tool':
      shape = `<rect x="${fmt(n.x)}" y="${fmt(n.y)}" width="${fmt(n.w)}" height="${fmt(n.h)}" rx="6" class="dg-shape"/><rect x="${fmt(n.x)}" y="${fmt(n.y)}" width="10" height="${fmt(n.h)}" rx="3" class="dg-shape-tab"/>`;
      break;
    case 'lifeline':
      shape = `<line x1="${fmt(cx)}" y1="${fmt(n.y + METRICS.seqBoxH)}" x2="${fmt(cx)}" y2="${fmt(n.y + n.h)}" class="dg-lifeline"/>`
        + `<rect x="${fmt(n.x)}" y="${fmt(n.y)}" width="${fmt(n.w)}" height="${METRICS.seqBoxH}" rx="6" class="dg-shape"/>`;
      break;
    default:
      shape = `<rect x="${fmt(n.x)}" y="${fmt(n.y)}" width="${fmt(n.w)}" height="${fmt(n.h)}" rx="8" class="dg-shape"/>`;
  }
  const ty = n.shape === 'lifeline' ? n.y + METRICS.seqBoxH / 2 : n.y + n.h / 2;
  const label = `<text x="${fmt(cx)}" y="${fmt(ty)}" class="dg-label" text-anchor="middle" dominant-baseline="middle">${escapeXml(n.label)}</text>`;
  const beacon = n.evidence === 'verified' ? `<circle cx="${fmt(n.x + n.w - 10)}" cy="${fmt(n.y + 10)}" r="4" class="dg-beacon"><title>verified against the repository</title></circle>` : '';
  return `<g ${attrs}>${shape}${label}${beacon}</g>`;
}

function edgeSvg(e: PlacedEdge): string {
  const d = e.points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${fmt(x)} ${fmt(y)}`).join(' ');
  const marker = e.arrow === 'none' ? '' : e.arrow === 'open' ? ' marker-end="url(#dg-arrow-open)"' : ' marker-end="url(#dg-arrow)"';
  const start = e.arrow === 'both' ? ' marker-start="url(#dg-arrow-start)"' : '';
  const cls = `dg-edge dg-stroke-${e.stroke}${e.primary ? ' dg-primary' : ''}`;
  let label = '';
  if (e.label && e.labelAt) {
    const w = textWidth(e.label) + 12, h = 18;
    const [x, y] = e.labelAt;
    label = `<rect x="${fmt(x - w / 2)}" y="${fmt(y - h / 2)}" width="${fmt(w)}" height="${h}" rx="4" class="dg-edge-mask"/>`
      + `<text x="${fmt(x)}" y="${fmt(y)}" class="dg-edge-label" text-anchor="middle" dominant-baseline="middle">${escapeXml(e.label)}</text>`;
  }
  return `<g data-id="${escapeXml(e.id)}" data-from="${escapeXml(e.from)}" data-to="${escapeXml(e.to)}" class="${cls}"><path d="${d}" class="dg-path"${marker}${start}/>${label}</g>`;
}

/** The complete inline SVG for a scene. Deterministic: element order is scene order. */
export function sceneToSvg(scene: Scene): string {
  const defs = '<defs>'
    + '<marker id="dg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="dg-arrowhead"/></marker>'
    + '<marker id="dg-arrow-start" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M10 0L0 5L10 10z" class="dg-arrowhead"/></marker>'
    + '<marker id="dg-arrow-open" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0L10 5L0 10" class="dg-arrowhead-open"/></marker>'
    + '</defs>';
  const bands = scene.bands.map((b) => `<g class="dg-band dg-band-${b.axis}" data-id="${escapeXml(b.id)}"><rect x="${fmt(b.x)}" y="${fmt(b.y)}" width="${fmt(b.w)}" height="${fmt(b.h)}" class="dg-band-rect"/>`
    + (b.axis === 'row'
      ? `<text x="${fmt(b.x + 12)}" y="${fmt(b.y + b.h / 2)}" class="dg-band-label" dominant-baseline="middle">${escapeXml(b.label)}</text>`
      : `<text x="${fmt(b.x + b.w / 2)}" y="${fmt(b.y + 18)}" class="dg-band-label" text-anchor="middle">${escapeXml(b.label)}</text>`)
    + '</g>').join('');
  const groups = scene.groups.map((g) => `<g class="dg-group dg-group-${g.kind}" data-id="${escapeXml(g.id)}"><rect x="${fmt(g.x)}" y="${fmt(g.y)}" width="${fmt(g.w)}" height="${fmt(g.h)}" rx="12" class="dg-group-rect"/><text x="${fmt(g.x + 14)}" y="${fmt(g.y + 18)}" class="dg-group-label">${escapeXml(g.label)}</text></g>`).join('');
  const activations = (scene.activations ?? []).map((a) => `<rect x="${fmt(a.x)}" y="${fmt(a.y)}" width="12" height="${fmt(a.h)}" rx="2" class="dg-activation" data-participant="${escapeXml(a.participant)}"/>`).join('');
  const edges = scene.edges.map(edgeSvg).join('');
  const nodes = scene.nodes.map(nodeSvg).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${scene.width} ${scene.height}" width="${scene.width}" height="${scene.height}" class="dg-svg" role="img" aria-label="diagram">${defs}${bands}${groups}${activations}${edges}${nodes}</svg>`;
}
