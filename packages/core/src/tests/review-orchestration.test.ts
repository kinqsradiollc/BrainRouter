/**
 * ADR-033 D1/D2/D8 — one pipeline, bundles in flight together, and a failure
 * that costs coverage instead of the whole run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planReviewBundles } from '../review/reviewBundles.js';
import { orchestrateReview } from '../review/reviewOrchestration.js';
import {
  buildEvidenceRequestContract,
  formatServedEvidence,
  parseEvidenceRequest,
} from '../review/reviewEvidenceRequest.js';

function fileDiff(path: string, line: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,0 +1,1 @@',
    `+${line}`,
  ].join('\n');
}

const DIFF = [
  fileDiff('src/a/one.ts', 'const one = 1;'),
  fileDiff('src/b/two.ts', 'const two = 2;'),
  fileDiff('src/c/three.ts', 'const three = 3;'),
].join('\n');

test('bundles are reviewed concurrently, not one after another', async () => {
  const plan = planReviewBundles({ diff: DIFF, maxBundleChars: 120, maxBundles: 10 });
  assert.ok(plan.bundles.length >= 3, 'the fixture did not produce independent bundles');
  let inFlight = 0;
  let peak = 0;
  const result = await orchestrateReview({
    diff: DIFF,
    bundles: plan.bundles,
    concurrency: 3,
    analyzeBundle: async (bundle) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { bundleId: bundle.id, ok: true, findings: [] };
    },
  });
  assert.ok(peak > 1, 'the bundles were still reviewed serially');
  assert.equal(result.reviewedBundles, plan.bundles.length);
});

test('one bundle failing does not sink the review', async () => {
  const plan = planReviewBundles({ diff: DIFF, maxBundleChars: 120, maxBundles: 10 });
  const result = await orchestrateReview({
    diff: DIFF,
    bundles: plan.bundles,
    concurrency: 2,
    analyzeBundle: async (bundle, context) => {
      if (context.index === 0) throw new Error('provider timeout');
      return {
        bundleId: bundle.id,
        ok: true,
        findings: [
          {
            file: bundle.paths[0],
            line: 1,
            severity: 'high',
            confidence: 90,
            summary: `issue in ${bundle.paths[0]}`,
          },
        ],
      };
    },
  });
  assert.equal(result.failedBundles, 1);
  assert.equal(result.reviewedBundles, plan.bundles.length - 1);
  assert.equal(result.findings.length, plan.bundles.length - 1);
});

test('positions are computed against the whole diff and counted', async () => {
  const plan = planReviewBundles({ diff: DIFF, maxBundleChars: 120, maxBundles: 10 });
  const result = await orchestrateReview({
    diff: DIFF,
    bundles: plan.bundles,
    concurrency: 4,
    analyzeBundle: async (bundle) => ({
      bundleId: bundle.id,
      ok: true,
      findings: [
        {
          file: bundle.paths[0],
          line: 999,
          severity: 'low',
          confidence: 50,
          summary: 'claimed on a line that does not exist',
        },
      ],
    }),
  });
  assert.equal(result.positions.file_only, plan.bundles.length);
  assert.equal(result.positions.model_line_confirmed, 0);
  for (const finding of result.findings) assert.equal(finding.line, undefined);
});

test('orchestration upgrades D4 positioning with exact source when available', async () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -10 +10 @@',
    '-export const changed = false;',
    '+export const changed = true;',
  ].join('\n');
  const plan = planReviewBundles({ diff, maxBundleChars: 1_000, maxBundles: 10 });
  const requested: string[] = [];
  const result = await orchestrateReview({
    diff,
    bundles: plan.bundles,
    concurrency: 1,
    sourceTextForPath: (path) => {
      requested.push(path);
      return 'const evidenceOutsideHunk = true;\nexport const changed = true;';
    },
    analyzeBundle: async (bundle) => ({
      bundleId: bundle.id,
      ok: true,
      findings: [{
        file: 'src/a.ts',
        line: 10,
        codeExcerpt: 'const evidenceOutsideHunk = true;',
        severity: 'high',
        confidence: 90,
        summary: 'outside-hunk evidence',
      }],
    }),
  });
  assert.deepEqual(requested, ['src/a.ts']);
  assert.equal(result.findings[0]?.line, 1);
  assert.equal(result.positions.excerpt_relocated, 1);
});

test('the reflection pass runs over the whole set once, after dedupe', async () => {
  const plan = planReviewBundles({ diff: DIFF, maxBundleChars: 120, maxBundles: 10 });
  let sets = 0;
  const result = await orchestrateReview({
    diff: DIFF,
    bundles: plan.bundles,
    concurrency: 3,
    analyzeBundle: async (bundle) => ({
      bundleId: bundle.id,
      ok: true,
      findings: [
        { file: 'src/a/one.ts', line: 1, severity: 'high', confidence: 90, summary: 'the same issue' },
      ],
    }),
    reflect: async (findings) => {
      sets += 1;
      assert.equal(findings.length, 1, 'duplicates reached the reflection pass');
      return { findings: [], dropped: 1, merged: 0, reflected: true };
    },
  });
  assert.equal(sets, 1);
  assert.equal(result.findings.length, 0);
  assert.equal(result.reflection.required, true);
  assert.equal(result.reflection.dropped, 1);
});

test('a reflection infrastructure failure keeps positioned findings', async () => {
  const plan = planReviewBundles({ diff: DIFF, maxBundleChars: 120, maxBundles: 10 });
  const result = await orchestrateReview({
    diff: DIFF,
    bundles: plan.bundles,
    concurrency: 3,
    analyzeBundle: async (bundle) => ({
      bundleId: bundle.id,
      ok: true,
      findings: [{
        file: bundle.paths[0],
        codeExcerpt: bundle.paths[0].includes('/a/')
          ? 'const one = 1;'
          : bundle.paths[0].includes('/b/')
            ? 'const two = 2;'
            : 'const three = 3;',
        severity: 'high',
        confidence: 90,
        summary: `issue in ${bundle.paths[0]}`,
      }],
    }),
    reflect: async () => {
      throw new Error('reflection provider unavailable');
    },
  });
  assert.equal(result.findings.length, plan.bundles.length);
  assert.equal(result.reflection.required, true);
  assert.equal(result.reflection.reflected, false);
});

test('an explicit clean candidate set does not require reflection', async () => {
  const plan = planReviewBundles({ diff: DIFF, maxBundleChars: 120, maxBundles: 10 });
  const result = await orchestrateReview({
    diff: DIFF,
    bundles: plan.bundles,
    concurrency: 2,
    analyzeBundle: async (bundle) => ({ bundleId: bundle.id, ok: true, findings: [] }),
    reflect: async () => { throw new Error('must not run for an empty set'); },
  });
  assert.equal(result.reflection.required, false);
  assert.equal(result.reflection.reflected, false);
});

test('a file request is recognised, and an unserved path says so', () => {
  const requested = parseEvidenceRequest('```json\n{"request_files": ["src/a/one.ts", "src/a/one.ts"]}\n```');
  assert.deepEqual(requested, ['src/a/one.ts']);
  assert.equal(parseEvidenceRequest('```json\n[{"file":"x","summary":"y"}]\n```'), null);
  assert.equal(parseEvidenceRequest(
    '```json\n{"request_files":["src/a.ts"],"findings":[]}\n```',
  ), null);
  assert.equal(parseEvidenceRequest(
    '```json\n{"request_files":["src/**/*.ts"]}\n```',
  ), null);
  assert.equal(parseEvidenceRequest(
    'I might need this.\n```json\n{"request_files":["src/a.ts"]}\n```',
  ), null);
  assert.match(buildEvidenceRequestContract(3), /at most 3 paths/);

  const rendered = formatServedEvidence([
    { path: 'src/a/one.ts', content: 'const one = 1;' },
    { path: 'secrets/.env', unavailableReason: 'not part of the reviewed checkout' },
  ]);
  assert.match(rendered, /1\tconst one = 1;/);
  assert.match(rendered, /UNAVAILABLE: not part of the reviewed checkout/);
  assert.match(rendered, /^<untrusted_repository_context_evidence>/);
});
