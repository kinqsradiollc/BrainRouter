/**
 * `design_fidelity` (ADR-056 D-B7): compare an approved comp with a screenshot
 * of the build, per region, and store the side-by-side and heatmap as
 * workspace artifacts under `.brainrouter/design/fidelity/<slug>/`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { decodePng, encodePng, isPng } from './png.js';
import { measureFidelity, heatmapImage, sideBySideImage, type FidelityOptions, type FidelityResult } from './measure.js';

export { decodePng, encodePng, isPng, type RgbaImage } from './png.js';
export { measureFidelity, type FidelityResult, type FidelityRegion, type FidelityVerdict, type FidelityOptions, FIDELITY_DEFAULTS } from './measure.js';

export const DESIGN_FIDELITY_DIR = path.join('.brainrouter', 'design', 'fidelity');
export const MAX_FIDELITY_IMAGE_BYTES = 8 * 1024 * 1024;

export interface FidelityArtifacts { report: string; sideBySide: string; heatmap: string }

export function fidelitySlug(comp: string, build: string): string {
  const base = `${path.basename(comp, path.extname(comp))}-vs-${path.basename(build, path.extname(build))}`;
  return base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'fidelity';
}

/** Read a workspace PNG, refusing paths outside the root and files over the bound. */
export function readWorkspacePng(workspaceRoot: string, relative: string): Buffer {
  const root = path.resolve(workspaceRoot);
  const abs = path.resolve(root, relative);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`${relative}: outside the workspace`);
  const size = fs.statSync(abs).size;
  if (size > MAX_FIDELITY_IMAGE_BYTES) throw new Error(`${relative}: ${Math.round(size / 1024)} kB is over the ${MAX_FIDELITY_IMAGE_BYTES / 1024 / 1024} MB bound`);
  const buf = fs.readFileSync(abs);
  if (!isPng(buf)) throw new Error(`${relative}: not a PNG`);
  return buf;
}

/** Measure two workspace PNGs and write the artifacts; returns the result and the workspace-relative paths. */
export function runDesignFidelity(workspaceRoot: string, comp: string, build: string, options: FidelityOptions & { slug?: string; now?: () => Date } = {}): { result: FidelityResult; artifacts: FidelityArtifacts } {
  const compImg = decodePng(readWorkspacePng(workspaceRoot, comp));
  const buildImg = decodePng(readWorkspacePng(workspaceRoot, build));
  const result = measureFidelity(compImg, buildImg, options);
  const slug = options.slug ?? fidelitySlug(comp, build);
  const stamp = (options.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(DESIGN_FIDELITY_DIR, slug);
  fs.mkdirSync(path.join(workspaceRoot, dir), { recursive: true });
  const artifacts: FidelityArtifacts = {
    report: path.join(dir, `${stamp}.json`),
    sideBySide: path.join(dir, `${stamp}-side-by-side.png`),
    heatmap: path.join(dir, `${stamp}-heatmap.png`),
  };
  fs.writeFileSync(path.join(workspaceRoot, artifacts.report), `${JSON.stringify({ compPath: comp, buildPath: build, ...result }, null, 2)}\n`);
  fs.writeFileSync(path.join(workspaceRoot, artifacts.sideBySide), encodePng(sideBySideImage(result, compImg, buildImg)));
  fs.writeFileSync(path.join(workspaceRoot, artifacts.heatmap), encodePng(heatmapImage(result, buildImg)));
  return { result, artifacts };
}

/** What the agent reads: a bounded Markdown report. */
export function fidelityReportMarkdown(result: FidelityResult, artifacts?: FidelityArtifacts): string {
  const lines = [
    `Fidelity ${result.score}/100 — ${result.verdict} (${result.counts.match} match · ${result.counts.drift} drift · ${result.counts.missing} missing · ${result.counts.contradicted} contradicted over ${result.grid.rows}×${result.grid.cols} regions; comp ${result.comp.width}×${result.comp.height}, build ${result.build.width}×${result.build.height}, measured at ${result.working.width}×${result.working.height}).`,
    `Section bands: comp ${result.bands.comp.length}, build ${result.bands.build.length}.`,
  ];
  const off = result.regions.filter((r) => r.verdict !== 'match');
  if (off.length) {
    lines.push('Regions that are not a match (row/col from the top-left):');
    for (const r of off.slice(0, 24)) lines.push(`- r${r.row + 1}c${r.col + 1} ${r.verdict} — structure ${r.ssim}, colour ${r.colour}, detail ${r.detail}${r.shift.dx || r.shift.dy ? `, best at shift ${r.shift.dx},${r.shift.dy}px` : ''}`);
    if (off.length > 24) lines.push(`- … ${off.length - 24} more in the report`);
  }
  if (artifacts) lines.push(`Artifacts: ${artifacts.sideBySide} (side by side), ${artifacts.heatmap} (heatmap), ${artifacts.report} (numbers).`);
  lines.push('This is a measurement, not a gate: read the regions, look at the heatmap, decide.');
  return lines.join('\n');
}
