import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const host = readFileSync(new URL('../../electron/host.ts', import.meta.url), 'utf8');

test('Desktop review uses the shared orchestration and cannot claim clean on missing coverage', () => {
  const reviewerFactory = host.match(/const spawnReviewer[\s\S]*?const spawnTaskAgent/)?.[0] ?? '';
  assert.match(host, /runLocalReviewOrchestration\(/);
  assert.match(reviewerFactory, /authorityToolCeiling:\s*\{/);
  assert.match(reviewerFactory, /mcp:\s*\[\]/);
  assert.match(reviewerFactory, /enableRecall:\s*false/);
  assert.match(reviewerFactory, /reviewSourceSafety:\s*true/);
  assert.match(reviewerFactory, /roleOverlay:[\s\S]*UNTRUSTED_REVIEW_EVIDENCE_RULE/);
  assert.doesNotMatch(reviewerFactory, /systemPromptOverride/);
  assert.doesNotMatch(reviewerFactory, /local:[^\n]*\blsp\b/);
  assert.match(host, /local\.review\.failedBundles > 0[\s\S]{0,220}local\.plan\.deferredPaths\.length > 0/);
  assert.match(host, /local\.review\.reflection\.required[\s\S]{0,120}!local\.review\.reflection\.reflected/);
  assert.match(host, /status:\s*incomplete \? 'failed' : 'completed'/);
});
