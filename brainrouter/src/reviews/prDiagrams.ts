/**
 * ADR-056 A7 — diagrams on the review surfaces: the dashboard shows a pull
 * request's `.brainrouter/diagrams/*` READ AT THE HEAD SHA in a sandboxed
 * viewer, and can hand out a 1200×630 share image for PR comments and chat.
 *
 * The share image is SVG: the diagram's own inline SVG placed on a card with
 * its title, kind, repository and receipt hash. No rasteriser runs on the
 * server; the card embeds the artifact the renderer already produced, so
 * what is shared is what was checked.
 */
import { listRepoDirAtRef, readRepoTextAtRef, type RepoContentsInput } from './repoContents.js';

export const PR_DIAGRAMS_DIR = '.brainrouter/diagrams';
export const PR_DIAGRAM_LIMITS = { diagrams: 12, htmlBytes: 1024 * 1024 } as const;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export interface PrDiagram {
  slug: string;
  title: string;
  kind: string;
  /** Receipt facts, when the receipt is there and parses. */
  receipt: { ok: boolean; artifactSha256: string; specificationSha256: string; rendererVersion: string } | null;
  /** The self-contained HTML artifact, for a sandboxed viewer. */
  html: string;
}

interface DiagramReceiptLike { ok?: boolean; title?: string; kind?: string; artifact?: { sha256?: string }; specification?: { sha256?: string }; renderer?: { version?: string } }

function attr(html: string, name: string): string | null {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(html.slice(0, 2_000));
  return m ? m[1] : null;
}

function titleOf(html: string): string | null {
  const m = /<title>([^<]*)<\/title>/.exec(html.slice(0, 4_000));
  return m ? m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim() : null;
}

/** List and read the diagrams a PR carries at its head; slugs that are not slugs are ignored. */
export async function listPrDiagrams(input: RepoContentsInput): Promise<PrDiagram[]> {
  const entries = await listRepoDirAtRef(input, PR_DIAGRAMS_DIR);
  const slugs = [...new Set(entries.filter((e) => e.type === 'file' && e.name.endsWith('.html')).map((e) => e.name.replace(/\.html$/, '')))].filter((s) => SLUG.test(s)).sort().slice(0, PR_DIAGRAM_LIMITS.diagrams);
  const out: PrDiagram[] = [];
  for (const slug of slugs) {
    const html = await readRepoTextAtRef(input, `${PR_DIAGRAMS_DIR}/${slug}.html`, PR_DIAGRAM_LIMITS.htmlBytes);
    if (!html || !/<svg[\s>]/i.test(html)) continue;
    let receipt: PrDiagram['receipt'] = null;
    const raw = await readRepoTextAtRef(input, `${PR_DIAGRAMS_DIR}/${slug}.receipt.json`, 256 * 1024);
    if (raw) {
      try {
        const r = JSON.parse(raw) as DiagramReceiptLike;
        receipt = { ok: r.ok === true, artifactSha256: String(r.artifact?.sha256 ?? ''), specificationSha256: String(r.specification?.sha256 ?? ''), rendererVersion: String(r.renderer?.version ?? '') };
      } catch { receipt = null; }
    }
    out.push({ slug, title: titleOf(html) ?? slug, kind: attr(html, 'data-diagram-kind') ?? 'diagram', receipt, html });
  }
  return out;
}

/** The first inline <svg>…</svg> of a rendered diagram, or null. */
export function extractDiagramSvg(html: string): string | null {
  const start = html.search(/<svg[\s>]/i);
  if (start < 0) return null;
  const end = html.indexOf('</svg>', start);
  return end < 0 ? null : html.slice(start, end + '</svg>'.length);
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface DiagramShareCardInput { title: string; kind: string; repo: string; number: number; svg: string; receiptSha256?: string | null }

/** A 1200×630 SVG card carrying the diagram's own SVG, its title, kind, repository and receipt hash. */
export function diagramShareCard(input: DiagramShareCardInput): string {
  const W = 1200, H = 630, PAD = 40, HEAD = 96;
  const boxW = W - PAD * 2, boxH = H - HEAD - PAD - 36;
  const vb = /viewBox="([^"]+)"/.exec(input.svg);
  const [vx, vy, vw, vh] = vb ? vb[1].split(/[\s,]+/).map(Number) : [0, 0, 1000, 600];
  const scale = Math.min(boxW / Math.max(1, vw), boxH / Math.max(1, vh));
  const dw = Math.round(vw * scale), dh = Math.round(vh * scale);
  const dx = PAD + Math.round((boxW - dw) / 2), dy = HEAD + Math.round((boxH - dh) / 2);
  // Rebuild the diagram's opening tag as a positioned, scaled nested viewport:
  // its own width/height/viewBox go, ours come first, every other attribute stays.
  const tagEnd = input.svg.indexOf('>');
  const openTag = input.svg.slice(0, tagEnd + 1);
  const rest = openTag.slice(4, -1).replace(/\s(?:width|height|viewBox|x|y|preserveAspectRatio)="[^"]*"/g, '');
  const inner = `<svg x="${dx}" y="${dy}" width="${dw}" height="${dh}" viewBox="${vx} ${vy} ${vw} ${vh}" preserveAspectRatio="xMidYMid meet"${rest}>` + input.svg.slice(tagEnd + 1);
  const title = esc(input.title.slice(0, 80));
  const meta = esc(`${input.kind} · ${input.repo}#${input.number}${input.receiptSha256 ? ` · receipt ${input.receiptSha256.slice(0, 12)}` : ''}`);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}">`,
    `<rect width="${W}" height="${H}" fill="#101114"/>`,
    `<rect x="${PAD}" y="${HEAD}" width="${boxW}" height="${boxH}" rx="12" fill="#17181c" stroke="#2a2c33"/>`,
    `<text x="${PAD}" y="52" fill="#f2f2f0" font-family="ui-sans-serif, -apple-system, Segoe UI, sans-serif" font-size="30" font-weight="600">${title}</text>`,
    `<text x="${PAD}" y="80" fill="#9a9ca6" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="15">${meta}</text>`,
    inner,
    `<text x="${W - PAD}" y="${H - 20}" text-anchor="end" fill="#6b6e78" font-family="ui-sans-serif, -apple-system, Segoe UI, sans-serif" font-size="13">BrainRouter · map with receipt</text>`,
    '</svg>',
  ].join('\n');
}
