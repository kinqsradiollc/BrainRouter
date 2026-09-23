/**
 * ADR-056 D-B4 — `critique` is two assessments that cannot see each other.
 * With no isolated seam the run degrades sequentially and SAYS so on its first
 * line; with a seam the evidence pass starts only after the review ended and
 * the review prompt carries no detector output; every run snapshots under
 * .brainrouter/design/critiques/<slug>/ and the second run shows a trend.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runDesignCritique, readDesignCritiqueSnapshots, DESIGN_CRITIQUE_DIR } from '../design/index.js';
import { withTempWorkspaceAsync } from './_helpers.js';

const TELL = '<!doctype html><html><head><style>.card{border-left:4px solid #e11d48}</style></head><body><div class="card">x</div><img src="a.png"><marquee>hi</marquee></body></html>';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('B4 without a seam the critique degrades sequentially and its first line says so', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    fs.mkdirSync(path.join(ws, 'src')); fs.writeFileSync(path.join(ws, 'src', 'page.html'), TELL);
    const run = await runDesignCritique({ workspaceRoot: ws, targets: ['src/page.html'], seam: null });
    assert.equal(run.degraded, true);
    assert.match(run.synthesisPrompt.split('\n')[0], /^Degraded critique: no isolated subagent seam/);
    assert.equal(run.review, null);
    assert.ok(run.evidence.findings.some((f) => f.rule === 'side-stripe-border'));
    assert.match(run.synthesisPrompt, /write the design review FIRST/i);
    assert.match(run.synthesisPrompt, /end with the targeted questions/i);
    assert.ok(fs.existsSync(path.join(ws, run.snapshotPath)), 'no snapshot written');
    assert.ok(run.snapshotPath.startsWith(path.join(DESIGN_CRITIQUE_DIR, 'src-page-html')));
    assert.equal(run.trend, null, 'first run has nothing to trend against');
  });
});

test('B4 with a seam the review runs blind, the evidence pass starts after it ends, and a second run trends', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    fs.mkdirSync(path.join(ws, 'src')); fs.writeFileSync(path.join(ws, 'src', 'page.html'), TELL);
    let reviewEnded = 0; let prompts: string[] = [];
    const seam = { run: async (prompt: string) => { prompts.push(prompt); await sleep(5); reviewEnded = Date.now(); return 'Fit: weak — the page sells nothing.\nCraft: flat hierarchy.\n{"hierarchy": 6, "clarity": 5, "resonance": 4}'; } };
    const t0 = new Date('2026-09-05T10:00:00.000Z');
    const first = await runDesignCritique({ workspaceRoot: ws, targets: ['src/page.html'], mode: 'persuade', seam, now: () => t0 });
    assert.equal(first.degraded, false);
    assert.equal(first.synthesisPrompt.startsWith('Degraded'), false);
    assert.ok(first.review); assert.deepEqual(first.review!.scores, { hierarchy: 6, clarity: 5, resonance: 4 });
    assert.ok(!/side-stripe-border|design_detect|findings/i.test(prompts[0]), 'the review prompt must not carry detector output or ask for it');
    assert.match(prompts[0], /Mode: persuade/);
    assert.ok(Date.parse(first.evidence.startedAt) >= reviewEnded, 'evidence started before the review ended');
    assert.match(first.synthesisPrompt, /Design review \(isolated subagent\)/); assert.match(first.synthesisPrompt, /Fit: weak/); assert.match(first.synthesisPrompt, /side-stripe-border/);
    assert.ok(first.synthesisPrompt.indexOf('Fit: weak') < first.synthesisPrompt.indexOf('side-stripe-border'), 'review precedes evidence in synthesis');

    seam.run = async () => 'Better.\n{"hierarchy": 7, "clarity": 5, "resonance": 6}';
    const second = await runDesignCritique({ workspaceRoot: ws, targets: ['src/page.html'], mode: 'persuade', seam, now: () => new Date(t0.getTime() + 60_000) });
    assert.ok(second.trend, 'second run has no trend');
    assert.match(second.trend!, /hierarchy 6 → 7/); assert.match(second.trend!, /clarity 5 → 5/); assert.match(second.trend!, /resonance 4 → 6/); assert.match(second.trend!, /findings 3 → 3/);
    assert.match(second.synthesisPrompt, /Trend/);
    const snaps = readDesignCritiqueSnapshots(ws, second.slug);
    assert.equal(snaps.length, 2); assert.equal(snaps[1].scores?.hierarchy, 7); assert.equal(snaps[0].at, t0.toISOString());
  });
});
