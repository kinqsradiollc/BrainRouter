/**
 * Artifact checks and the delivery receipt (ADR-056 D-A2).
 *
 * Nine deterministic checks over the validated document, the laid-out scene,
 * and the final HTML. They are the "proof" half of a rendering: a document
 * that renders but fails a check is reported, never delivered over a previous
 * good artifact. The receipt records each check, the SHA-256 and byte count of
 * both the specification (canonical JSON of the document) and the artifact,
 * and the renderer version — and contains no timestamp, so the receipt for an
 * unchanged document is itself unchanged.
 *
 * Three claims stay separate on purpose: these checks are artifact evidence;
 * browser evidence (a real render at real viewports) and perceptual review are
 * other claims, made elsewhere, never implied by a passing receipt.
 */
import { createHash } from 'node:crypto';
import type { Diagram, DiagramKind } from '@kinqs/brainrouter-types';
import { textWidth, type Scene } from './layout.js';

export const DIAGRAM_RENDERER_VERSION = '1.0.0';
export const DIAGRAM_ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;
export const DIAGRAM_VIEWPORT_MAX = { width: 4096, height: 4096 } as const;

export const DIAGRAM_CHECK_IDS = [
  'schema',
  'ids-unique',
  'nodes-no-overlap',
  'edge-clear-of-unrelated-nodes',
  'labels-no-collision',
  'viewport-bounded',
  'legend-complete',
  'html-self-contained',
  'artifact-size',
] as const;
export type DiagramCheckId = (typeof DIAGRAM_CHECK_IDS)[number];

export interface DiagramCheck { id: DiagramCheckId; ok: boolean; detail?: string }

export interface DiagramReceipt {
  receiptVersion: 1;
  kind: DiagramKind;
  title: string;
  ok: boolean;
  checks: DiagramCheck[];
  specification: { sha256: string; bytes: number };
  artifact: { sha256: string; bytes: number; format: 'html' };
  renderer: { name: 'brainrouter-diagram'; version: string };
  evidence: 'verified' | 'authored' | 'mixed';
}

type Rect = { x: number; y: number; w: number; h: number };

const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Segment (axis-aligned) crosses the interior of a rect (not just touching its border). */
function segmentCrosses(p: [number, number], q: [number, number], r: Rect): boolean {
  const eps = 0.5;
  const inner = { x: r.x + eps, y: r.y + eps, w: r.w - 2 * eps, h: r.h - 2 * eps };
  if (inner.w <= 0 || inner.h <= 0) return false;
  const minX = Math.min(p[0], q[0]), maxX = Math.max(p[0], q[0]);
  const minY = Math.min(p[1], q[1]), maxY = Math.max(p[1], q[1]);
  return minX < inner.x + inner.w && maxX > inner.x && minY < inner.y + inner.h && maxY > inner.y;
}

/** Canonical JSON: sorted keys at every level, no whitespace — the specification bytes a receipt hashes. */
export function canonicalDiagramJson(doc: Diagram): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]))
    : v;
  return JSON.stringify(sort(doc));
}

export const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** Run the nine checks. `schema` is passed in by the caller that validated the document. */
export function runDiagramChecks(doc: Diagram, scene: Scene, html: string, schemaOk: boolean): DiagramCheck[] {
  const checks: DiagramCheck[] = [];
  checks.push({ id: 'schema', ok: schemaOk });

  const allIds = [...scene.nodes.map((n) => n.id), ...scene.edges.map((e) => e.id), ...scene.groups.map((g) => g.id), ...scene.bands.map((b) => b.id)];
  const dupes = allIds.filter((id, i) => allIds.indexOf(id) !== i);
  checks.push(dupes.length ? { id: 'ids-unique', ok: false, detail: `duplicate: ${[...new Set(dupes)].join(', ')}` } : { id: 'ids-unique', ok: true });

  const nodeRects = scene.nodes.map((n) => ({ id: n.id, r: n.shape === 'lifeline' ? { x: n.x, y: n.y, w: n.w, h: 44 } : n }));
  const overlapPairs: string[] = [];
  for (let i = 0; i < nodeRects.length; i++) for (let j = i + 1; j < nodeRects.length; j++) {
    if (overlaps(nodeRects[i].r, nodeRects[j].r)) overlapPairs.push(`${nodeRects[i].id}/${nodeRects[j].id}`);
  }
  checks.push(overlapPairs.length ? { id: 'nodes-no-overlap', ok: false, detail: overlapPairs.join(', ') } : { id: 'nodes-no-overlap', ok: true });

  const crossings: string[] = [];
  if (scene.kind !== 'sequence') {
    for (const e of scene.edges) {
      for (let i = 0; i + 1 < e.points.length; i++) {
        for (const { id, r } of nodeRects) {
          if (id === e.from || id === e.to) continue;
          if (segmentCrosses(e.points[i], e.points[i + 1], r)) crossings.push(`${e.id}→${id}`);
        }
      }
    }
  }
  checks.push(crossings.length ? { id: 'edge-clear-of-unrelated-nodes', ok: false, detail: [...new Set(crossings)].join(', ') } : { id: 'edge-clear-of-unrelated-nodes', ok: true });

  const labelRects = scene.edges.filter((e) => e.label && e.labelAt).map((e) => {
    const w = textWidth(e.label!) + 12;
    return { id: e.id, r: { x: e.labelAt![0] - w / 2, y: e.labelAt![1] - 9, w, h: 18 } };
  });
  const collisions: string[] = [];
  for (let i = 0; i < labelRects.length; i++) {
    for (let j = i + 1; j < labelRects.length; j++) if (overlaps(labelRects[i].r, labelRects[j].r)) collisions.push(`${labelRects[i].id}/${labelRects[j].id}`);
    for (const { id, r } of nodeRects) if (overlaps(labelRects[i].r, r)) collisions.push(`${labelRects[i].id}/${id}`);
  }
  checks.push(collisions.length ? { id: 'labels-no-collision', ok: false, detail: collisions.join(', ') } : { id: 'labels-no-collision', ok: true });

  const bounded = scene.width <= DIAGRAM_VIEWPORT_MAX.width && scene.height <= DIAGRAM_VIEWPORT_MAX.height && scene.width > 0 && scene.height > 0;
  checks.push(bounded ? { id: 'viewport-bounded', ok: true } : { id: 'viewport-bounded', ok: false, detail: `${scene.width}×${scene.height} exceeds ${DIAGRAM_VIEWPORT_MAX.width}×${DIAGRAM_VIEWPORT_MAX.height}` });

  const typesUsed = new Set(scene.nodes.map((n) => n.type));
  const legendKeys = new Set(scene.legend.map((l) => l.key));
  const missing = [...typesUsed].filter((t) => scene.legend.length && !legendKeys.has(t));
  checks.push(missing.length ? { id: 'legend-complete', ok: false, detail: `no legend entry for ${missing.join(', ')}` } : { id: 'legend-complete', ok: true });

  const external = /(?:src|href)\s*=\s*["']\s*(?:https?:)?\/\//i.test(html) || /@import\s+url\(/i.test(html) || /<script[^>]+src=/i.test(html) || /<link[^>]+rel=["']stylesheet/i.test(html);
  checks.push(external ? { id: 'html-self-contained', ok: false, detail: 'external resource reference found' } : { id: 'html-self-contained', ok: true });

  const bytes = Buffer.byteLength(html, 'utf8');
  checks.push(bytes <= DIAGRAM_ARTIFACT_MAX_BYTES ? { id: 'artifact-size', ok: true } : { id: 'artifact-size', ok: false, detail: `${bytes} bytes > ${DIAGRAM_ARTIFACT_MAX_BYTES}` });
  return checks;
}

export function buildReceipt(doc: Diagram, html: string, checks: DiagramCheck[]): DiagramReceipt {
  const spec = canonicalDiagramJson(doc);
  const elements: Array<{ evidence?: string }> = [];
  switch (doc.kind) {
    case 'architecture': elements.push(...doc.components, ...doc.connections); break;
    case 'workflow': elements.push(...doc.nodes, ...doc.edges); break;
    case 'sequence': elements.push(...doc.participants, ...doc.messages); break;
    case 'dataflow': elements.push(...doc.nodes, ...doc.flows); break;
    case 'lifecycle': elements.push(...doc.states, ...doc.transitions); break;
  }
  const verified = elements.filter((e) => e.evidence === 'verified').length;
  const evidence: DiagramReceipt['evidence'] = verified === 0 ? 'authored' : verified === elements.length ? 'verified' : 'mixed';
  return {
    receiptVersion: 1,
    kind: doc.kind,
    title: doc.meta.title,
    ok: checks.every((c) => c.ok),
    checks,
    specification: { sha256: sha256(spec), bytes: Buffer.byteLength(spec, 'utf8') },
    artifact: { sha256: sha256(html), bytes: Buffer.byteLength(html, 'utf8'), format: 'html' },
    renderer: { name: 'brainrouter-diagram', version: DIAGRAM_RENDERER_VERSION },
    evidence,
  };
}
