/**
 * ADR-056 D-B7 — fidelity is measured, not asserted: a comp against itself
 * scores ≥ 99; a comp with one region erased marks that region `missing`; a
 * recoloured comp is `contradicted` overall; the PNG codec round-trips; the
 * tool writes a side-by-side and a heatmap under .brainrouter/design/fidelity/.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { decodePng, encodePng, isPng, measureFidelity, runDesignFidelity, fidelityReportMarkdown, DESIGN_FIDELITY_DIR, type RgbaImage } from '../design/index.js';
import { withTempWorkspaceAsync } from './_helpers.js';

/** A deterministic "page": paper, a dark header band, two coloured columns of blocks, text-like stripes. */
function comp(width = 320, height = 480): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  const put = (x: number, y: number, r: number, g: number, b: number) => { const p = (y * width + x) * 4; data[p] = r; data[p + 1] = g; data[p + 2] = b; data[p + 3] = 255; };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let [r, g, b] = [250, 250, 247];
    if (y < 56) [r, g, b] = [24, 28, 40];
    else if (y > 96 && y < 300 && x > 24 && x < 150 && ((y - 96) % 40) < 28) [r, g, b] = [220, 80, 60];
    else if (y > 96 && y < 300 && x > 170 && x < 296 && ((y - 96) % 40) < 28) [r, g, b] = [40, 120, 220];
    else if (y > 330 && y < 440 && x > 24 && x < 296 && ((y - 330) % 12) < 4 && ((x * 7 + y) % 23) > 4) [r, g, b] = [60, 60, 70];
    put(x, y, r, g, b);
  }
  return { width, height, data };
}

function erased(img: RgbaImage, box: { x: number; y: number; w: number; h: number }): RgbaImage {
  const data = new Uint8Array(img.data);
  for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) { const p = (y * img.width + x) * 4; data[p] = 250; data[p + 1] = 250; data[p + 2] = 247; }
  return { ...img, data };
}

function recoloured(img: RgbaImage): RgbaImage {
  const data = new Uint8Array(img.data);
  for (let i = 0; i < data.length; i += 4) { const r = data[i]; data[i] = data[i + 2]; data[i + 2] = r; data[i + 1] = 255 - data[i + 1]; }
  return { ...img, data };
}

test('B7 the PNG codec round-trips RGBA and reads grayscale/RGB/palette', () => {
  const img = comp(40, 30);
  const back = decodePng(encodePng(img));
  assert.equal(back.width, 40); assert.equal(back.height, 30); assert.deepEqual([...back.data], [...img.data]);
  assert.ok(isPng(encodePng(img))); assert.equal(isPng(Buffer.from('nope')), false);
  assert.throws(() => decodePng(Buffer.from('not a png at all')), /signature/);
});

test('B7 comp vs itself ≥ 99 and every region matches', () => {
  const c = comp();
  const r = measureFidelity(c, c);
  assert.ok(r.score >= 99, `score ${r.score}`); assert.equal(r.verdict, 'match'); assert.equal(r.counts.match, r.regions.length);
  assert.deepEqual(r.bands.comp, r.bands.build);
});

test('B7 an erased region is missing; the rest still matches', () => {
  const c = comp();
  const r = measureFidelity(c, erased(c, { x: 170, y: 96, w: 126, h: 204 }));
  const rightCols = r.regions.filter((g) => g.col >= 2 && g.row >= 1 && g.row <= 3);
  assert.ok(rightCols.some((g) => g.verdict === 'missing'), `no missing region among ${JSON.stringify(rightCols.map((g) => g.verdict))}`);
  assert.ok(r.regions.filter((g) => g.col <= 1).every((g) => g.verdict === 'match'), 'untouched left half must match');
  assert.equal(r.verdict, 'missing'); assert.ok(r.score < 99);
});

test('B7 a recoloured comp is contradicted overall', () => {
  const c = comp();
  const r = measureFidelity(c, recoloured(c));
  assert.equal(r.verdict, 'contradicted'); assert.ok(r.counts.contradicted >= r.regions.length * 0.4);
});

test('B7 the tool writes a report, a side-by-side, and a heatmap under .brainrouter/design/fidelity', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    fs.mkdirSync(path.join(ws, 'shots'));
    const c = comp();
    fs.writeFileSync(path.join(ws, 'shots', 'comp.png'), encodePng(c));
    fs.writeFileSync(path.join(ws, 'shots', 'build.png'), encodePng(erased(c, { x: 24, y: 330, w: 272, h: 110 })));
    const { result, artifacts } = runDesignFidelity(ws, 'shots/comp.png', 'shots/build.png', { now: () => new Date('2026-09-05T12:00:00Z') });
    assert.ok(artifacts.heatmap.startsWith(path.join(DESIGN_FIDELITY_DIR, 'comp-vs-build')));
    const heat = decodePng(fs.readFileSync(path.join(ws, artifacts.heatmap)));
    assert.equal(heat.width, result.working.width); assert.equal(heat.height, result.working.height);
    const side = decodePng(fs.readFileSync(path.join(ws, artifacts.sideBySide)));
    assert.equal(side.width, result.working.width * 2 + 8);
    const report = JSON.parse(fs.readFileSync(path.join(ws, artifacts.report), 'utf8')) as { verdict: string; compPath: string };
    assert.equal(report.compPath, 'shots/comp.png'); assert.equal(report.verdict, result.verdict);
    const md = fidelityReportMarkdown(result, artifacts);
    assert.match(md, /^Fidelity \d+(\.\d+)?\/100 — (missing|drift)/); assert.match(md, /heatmap/); assert.match(md, /not a gate/);
    assert.throws(() => runDesignFidelity(ws, '../outside.png', 'shots/build.png'), /outside the workspace/);
  });
});
