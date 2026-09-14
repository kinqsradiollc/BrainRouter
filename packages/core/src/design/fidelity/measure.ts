/**
 * Fidelity is measured, not asserted (ADR-056 D-B7).
 *
 * An approved comp and a screenshot of the build are compared per region:
 * structure (SSIM over blurred grayscale with a small translation search),
 * colour (palette match), detail (high-frequency energy), and section bands.
 * Each region gets a verdict — match | drift | missing | contradicted — and the
 * whole gets a score and a verdict. It is a measurement the model reads, never
 * a gate. Deterministic: same inputs, same numbers.
 */
import type { RgbaImage } from './png.js';

export type FidelityVerdict = 'match' | 'drift' | 'missing' | 'contradicted';

export interface FidelityRegion {
  row: number;
  col: number;
  /** Pixel box in the working (comp) frame. */
  box: { x: number; y: number; w: number; h: number };
  ssim: number;
  colour: number;
  detail: number;
  /** Translation (px, working frame) at which structure matched best. */
  shift: { dx: number; dy: number };
  verdict: FidelityVerdict;
}

export interface FidelityResult {
  version: 1;
  score: number;
  verdict: FidelityVerdict;
  working: { width: number; height: number };
  comp: { width: number; height: number };
  build: { width: number; height: number };
  grid: { rows: number; cols: number };
  regions: FidelityRegion[];
  bands: { comp: number[]; build: number[] };
  counts: Record<FidelityVerdict, number>;
}

export interface FidelityOptions { rows?: number; cols?: number; workingWidth?: number; search?: number }

export const FIDELITY_DEFAULTS = { rows: 6, cols: 4, workingWidth: 512, search: 4 } as const;

interface Gray { width: number; height: number; data: Float32Array }

/** Nearest-neighbour resample to `width`×`height`. */
export function resample(img: RgbaImage, width: number, height: number): RgbaImage {
  if (img.width === width && img.height === height) return img;
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(img.height - 1, Math.floor((y + 0.5) * img.height / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(img.width - 1, Math.floor((x + 0.5) * img.width / width));
      const s = (sy * img.width + sx) * 4, d = (y * width + x) * 4;
      out[d] = img.data[s]; out[d + 1] = img.data[s + 1]; out[d + 2] = img.data[s + 2]; out[d + 3] = img.data[s + 3];
    }
  }
  return { width, height, data: out };
}

function toGray(img: RgbaImage): Gray {
  const data = new Float32Array(img.width * img.height);
  for (let i = 0; i < data.length; i++) {
    const p = i * 4; const a = img.data[p + 3] / 255;
    // Alpha composited over white so a transparent screenshot region reads as paper, not black.
    const r = img.data[p] * a + 255 * (1 - a), g = img.data[p + 1] * a + 255 * (1 - a), b = img.data[p + 2] * a + 255 * (1 - a);
    data[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return { width: img.width, height: img.height, data };
}

function boxBlur(g: Gray, radius: number): Gray {
  const { width, height } = g; const tmp = new Float32Array(width * height); const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let s = 0, n = 0;
    for (let k = -radius; k <= radius; k++) { const xx = x + k; if (xx >= 0 && xx < width) { s += g.data[y * width + xx]; n++; } }
    tmp[y * width + x] = s / n;
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let s = 0, n = 0;
    for (let k = -radius; k <= radius; k++) { const yy = y + k; if (yy >= 0 && yy < height) { s += tmp[yy * width + x]; n++; } }
    out[y * width + x] = s / n;
  }
  return { width, height, data: out };
}

const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;

/** Mean SSIM over 8×8 windows (stride 4) of the box, with `b` sampled at an offset. */
function ssimBox(a: Gray, b: Gray, box: { x: number; y: number; w: number; h: number }, dx: number, dy: number): number {
  const win = 8, step = 4; let total = 0, n = 0;
  for (let wy = box.y; wy + win <= box.y + box.h; wy += step) for (let wx = box.x; wx + win <= box.x + box.w; wx += step) {
    let ma = 0, mb = 0; let count = 0;
    for (let y = 0; y < win; y++) for (let x = 0; x < win; x++) {
      const ax = wx + x, ay = wy + y, bx = ax + dx, by = ay + dy;
      if (bx < 0 || by < 0 || bx >= b.width || by >= b.height) continue;
      ma += a.data[ay * a.width + ax]; mb += b.data[by * b.width + bx]; count++;
    }
    if (count < win * win / 2) continue;
    ma /= count; mb /= count;
    let va = 0, vb = 0, cov = 0;
    for (let y = 0; y < win; y++) for (let x = 0; x < win; x++) {
      const ax = wx + x, ay = wy + y, bx = ax + dx, by = ay + dy;
      if (bx < 0 || by < 0 || bx >= b.width || by >= b.height) continue;
      const da = a.data[ay * a.width + ax] - ma, db = b.data[by * b.width + bx] - mb;
      va += da * da; vb += db * db; cov += da * db;
    }
    va /= count; vb /= count; cov /= count;
    total += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
    n++;
  }
  return n ? total / n : 1;
}

function palette(img: RgbaImage, box: { x: number; y: number; w: number; h: number }): Map<number, number> {
  const hist = new Map<number, number>(); let n = 0;
  for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) {
    const p = (y * img.width + x) * 4;
    const key = ((img.data[p] >> 4) << 8) | ((img.data[p + 1] >> 4) << 4) | (img.data[p + 2] >> 4);
    hist.set(key, (hist.get(key) ?? 0) + 1); n++;
  }
  for (const [k, v] of hist) hist.set(k, v / Math.max(1, n));
  return hist;
}

/** Bhattacharyya coefficient of two normalised colour histograms: 1 = same palette. */
function paletteMatch(a: Map<number, number>, b: Map<number, number>): number {
  let s = 0;
  for (const [k, pa] of a) { const pb = b.get(k); if (pb) s += Math.sqrt(pa * pb); }
  return Math.min(1, s);
}

function stats(g: Gray, blur: Gray, box: { x: number; y: number; w: number; h: number }): { std: number; energy: number } {
  let m = 0, n = 0;
  for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) { m += g.data[y * g.width + x]; n++; }
  m /= Math.max(1, n);
  let v = 0, e = 0;
  for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) {
    const i = y * g.width + x; const d = g.data[i] - m; v += d * d; e += Math.abs(g.data[i] - blur.data[i]);
  }
  return { std: Math.sqrt(v / Math.max(1, n)), energy: e / Math.max(1, n) };
}

/** Rows where the vertical gradient spikes: section boundaries, at least 12px apart. */
export function bandBoundaries(g: Gray): number[] {
  const rows = new Float32Array(g.height);
  for (let y = 1; y < g.height; y++) { let s = 0; for (let x = 0; x < g.width; x++) s += Math.abs(g.data[y * g.width + x] - g.data[(y - 1) * g.width + x]); rows[y] = s / g.width; }
  let mean = 0; for (let y = 1; y < g.height; y++) mean += rows[y]; mean /= Math.max(1, g.height - 1);
  let sd = 0; for (let y = 1; y < g.height; y++) sd += (rows[y] - mean) ** 2; sd = Math.sqrt(sd / Math.max(1, g.height - 1));
  const threshold = mean + 2 * sd; const out: number[] = [];
  for (let y = 1; y < g.height; y++) if (rows[y] > threshold && rows[y] > 4 && (out.length === 0 || y - out[out.length - 1] >= 12)) out.push(y);
  return out;
}

export function verdictFor(m: { ssim: number; colour: number; detail: number; missing: boolean }): FidelityVerdict {
  if (m.missing) return 'missing';
  if (m.colour < 0.45) return 'contradicted';
  if (m.ssim >= 0.9 && m.colour >= 0.7) return 'match';
  return 'drift';
}

/** Compare a comp against a build screenshot. Both RGBA; the build is resampled into the comp's frame. */
export function measureFidelity(compIn: RgbaImage, buildIn: RgbaImage, options: FidelityOptions = {}): FidelityResult {
  const rows = Math.max(1, Math.min(12, options.rows ?? FIDELITY_DEFAULTS.rows));
  const cols = Math.max(1, Math.min(12, options.cols ?? FIDELITY_DEFAULTS.cols));
  const search = Math.max(0, Math.min(8, options.search ?? FIDELITY_DEFAULTS.search));
  const targetW = Math.min(compIn.width, options.workingWidth ?? FIDELITY_DEFAULTS.workingWidth);
  const targetH = Math.max(1, Math.round(compIn.height * targetW / compIn.width));
  const comp = resample(compIn, targetW, targetH);
  const build = resample(buildIn, targetW, targetH);
  const gc = toGray(comp), gb = toGray(build);
  const bc = boxBlur(gc, 2), bb = boxBlur(gb, 2);
  const regions: FidelityRegion[] = [];
  const counts: Record<FidelityVerdict, number> = { match: 0, drift: 0, missing: 0, contradicted: 0 };
  let sum = 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const box = { x: Math.floor(c * targetW / cols), y: Math.floor(r * targetH / rows), w: Math.floor((c + 1) * targetW / cols) - Math.floor(c * targetW / cols), h: Math.floor((r + 1) * targetH / rows) - Math.floor(r * targetH / rows) };
    let best = -1, bdx = 0, bdy = 0;
    for (let dy = -search; dy <= search; dy += 2) for (let dx = -search; dx <= search; dx += 2) {
      const s = ssimBox(bc, bb, box, dx, dy);
      if (s > best) { best = s; bdx = dx; bdy = dy; }
    }
    const sc = stats(gc, bc, box), sb = stats(gb, bb, box);
    const detail = sc.energy === 0 && sb.energy === 0 ? 1 : Math.min(sc.energy, sb.energy) / Math.max(sc.energy, sb.energy);
    const colour = paletteMatch(palette(comp, box), palette(build, box));
    const missing = sc.std > 6 && sb.std < 2;
    const ssim = Math.max(0, Math.min(1, best));
    const verdict = verdictFor({ ssim, colour, detail, missing });
    counts[verdict]++;
    sum += 0.6 * ssim + 0.25 * colour + 0.15 * detail;
    regions.push({ row: r, col: c, box, ssim: round(ssim), colour: round(colour), detail: round(detail), shift: { dx: bdx, dy: bdy }, verdict });
  }
  const n = regions.length;
  const score = Math.round((sum / n) * 1000) / 10;
  const verdict: FidelityVerdict = counts.contradicted >= n * 0.4 ? 'contradicted' : counts.missing > 0 ? 'missing' : counts.drift + counts.contradicted > 0 ? 'drift' : 'match';
  return {
    version: 1, score, verdict,
    working: { width: targetW, height: targetH },
    comp: { width: compIn.width, height: compIn.height }, build: { width: buildIn.width, height: buildIn.height },
    grid: { rows, cols }, regions, bands: { comp: bandBoundaries(bc), build: bandBoundaries(bb) }, counts,
  };
}

const round = (v: number): number => Math.round(v * 1000) / 1000;

const TINT: Record<FidelityVerdict, [number, number, number]> = { match: [60, 180, 90], drift: [230, 190, 40], contradicted: [240, 120, 40], missing: [220, 60, 60] };

/** The build in the working frame with each region tinted by its verdict and the grid drawn. */
export function heatmapImage(result: FidelityResult, buildIn: RgbaImage): RgbaImage {
  const img = resample(buildIn, result.working.width, result.working.height);
  const out = new Uint8Array(img.data); const W = img.width;
  for (const region of result.regions) {
    const [tr, tg, tb] = TINT[region.verdict]; const alpha = region.verdict === 'match' ? 0.18 : 0.42;
    for (let y = region.box.y; y < region.box.y + region.box.h; y++) for (let x = region.box.x; x < region.box.x + region.box.w; x++) {
      const p = (y * W + x) * 4; const edge = x === region.box.x || y === region.box.y;
      out[p] = edge ? 255 : Math.round(out[p] * (1 - alpha) + tr * alpha);
      out[p + 1] = edge ? 255 : Math.round(out[p + 1] * (1 - alpha) + tg * alpha);
      out[p + 2] = edge ? 255 : Math.round(out[p + 2] * (1 - alpha) + tb * alpha);
      out[p + 3] = 255;
    }
  }
  return { width: img.width, height: img.height, data: out };
}

/** Comp on the left, build on the right, a dark gutter between, both in the working frame. */
export function sideBySideImage(result: FidelityResult, compIn: RgbaImage, buildIn: RgbaImage): RgbaImage {
  const w = result.working.width, h = result.working.height, gap = 8;
  const comp = resample(compIn, w, h), build = resample(buildIn, w, h);
  const W = w * 2 + gap; const out = new Uint8Array(W * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < W; x++) {
    const d = (y * W + x) * 4;
    if (x < w) { const s = (y * w + x) * 4; out[d] = comp.data[s]; out[d + 1] = comp.data[s + 1]; out[d + 2] = comp.data[s + 2]; out[d + 3] = 255; }
    else if (x >= w + gap) { const s = (y * w + (x - w - gap)) * 4; out[d] = build.data[s]; out[d + 1] = build.data[s + 1]; out[d + 2] = build.data[s + 2]; out[d + 3] = 255; }
    else { out[d] = 24; out[d + 1] = 24; out[d + 2] = 28; out[d + 3] = 255; }
  }
  return { width: W, height: h, data: out };
}
