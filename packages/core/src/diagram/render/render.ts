/**
 * Render and deliver (ADR-056 D-A2).
 *
 * `renderDiagram` turns an untrusted document into `{ html, svg, receipt }` —
 * validation first (a structurally invalid document renders nothing), then the
 * deterministic layout, SVG, HTML shell, and the nine checks. `deliverDiagram`
 * adds the on-disk contract: the HTML is written atomically (temp file +
 * rename) ONLY when every check passes, so a failed delivery never replaces a
 * previous trusted artifact, and the receipt is written beside it.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { DiagramDiagnostic, DiagramValidation } from '@kinqs/brainrouter-types';
import { validateDiagram } from '../schema.js';
import { layoutDiagram, type Scene } from './layout.js';
import { sceneToSvg } from './svg.js';
import { wrapHtml } from './html.js';
import { buildReceipt, runDiagramChecks, DIAGRAM_RENDERER_VERSION, type DiagramReceipt } from './checks.js';

export interface RenderOptions {
  theme?: 'auto' | 'dark' | 'light';
  quality?: 'standard' | 'showcase';
}

export interface RenderResult {
  ok: boolean;
  validation: DiagramValidation;
  /** Present when the document validated (even if a check failed — the caller decides what to keep). */
  html?: string;
  svg?: string;
  scene?: Scene;
  receipt?: DiagramReceipt;
}

export function renderDiagram(input: unknown, opts: RenderOptions = {}): RenderResult {
  const validation = validateDiagram(input, opts.quality ? { quality: opts.quality } : {});
  if (!validation.ok || !validation.diagram) return { ok: false, validation };
  const doc = validation.diagram;
  const scene = layoutDiagram(doc);
  const svg = sceneToSvg(scene);
  const theme = opts.theme ?? doc.meta.theme ?? 'auto';
  const html = wrapHtml(doc, scene, svg, { theme, rendererVersion: DIAGRAM_RENDERER_VERSION });
  const checks = runDiagramChecks(doc, scene, html, true);
  const receipt = buildReceipt(doc, html, checks);
  return { ok: receipt.ok, validation, html, svg, scene, receipt };
}

export interface DeliverOptions extends RenderOptions {
  /** Also write `<outPath>.receipt.json`. Default true. */
  writeReceipt?: boolean;
}

export interface DeliverResult {
  ok: boolean;
  outPath: string;
  receiptPath?: string;
  receipt?: DiagramReceipt;
  diagnostics: DiagramDiagnostic[];
  /** True when a previous artifact at `outPath` was left untouched by a failed delivery. */
  previousKept: boolean;
}

/** Atomic write: the target is replaced only after the full content is on disk. */
function writeAtomic(target: string, content: string): void {
  const tmp = `${target}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, target);
}

export function deliverDiagram(input: unknown, outPath: string, opts: DeliverOptions = {}): DeliverResult {
  const existed = fs.existsSync(outPath);
  const result = renderDiagram(input, opts);
  const diagnostics = [...result.validation.diagnostics];
  if (!result.ok || !result.html || !result.receipt) {
    for (const c of result.receipt?.checks ?? []) {
      if (!c.ok) diagnostics.push({ code: `diagram/check-${c.id}`, severity: 'error', path: '', message: `Artifact check "${c.id}" failed${c.detail ? `: ${c.detail}` : ''}.` });
    }
    return { ok: false, outPath, diagnostics, previousKept: existed, ...(result.receipt ? { receipt: result.receipt } : {}) };
  }
  writeAtomic(outPath, result.html);
  let receiptPath: string | undefined;
  if (opts.writeReceipt !== false) {
    receiptPath = `${outPath}.receipt.json`;
    writeAtomic(receiptPath, `${JSON.stringify(result.receipt, null, 2)}\n`);
  }
  return { ok: true, outPath, receipt: result.receipt, diagnostics, previousKept: false, ...(receiptPath ? { receiptPath } : {}) };
}
