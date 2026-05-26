import test from 'node:test';
import assert from 'node:assert/strict';
import {
  _resetPricingCache,
  buildCostSummary,
  cacheSavingsUsd,
  costUsd,
  formatCostBadge,
  pricingFor,
} from '../runtime/pricing.js';

test('pricingFor returns the built-in row for known models', () => {
  // 0.3.9 removed the Anthropic built-ins. Use the OpenAI / DeepSeek
  // rows that still ship as the canonical example.
  const p = pricingFor('gpt-5');
  assert.ok(p);
  assert.equal(p!.inputCacheHit, 0.125);
  assert.equal(p!.inputCacheMiss, 1.25);
  assert.equal(p!.output, 5.0);
});

test('pricingFor strips vendor prefix (openrouter / openai)', () => {
  const a = pricingFor('openai/gpt-5');
  const b = pricingFor('gpt-5');
  assert.deepEqual(a, b);
});

test('pricingFor returns a zero-cost row for unknown models', () => {
  const p = pricingFor('some-future-model-id');
  assert.ok(p);
  assert.equal(p!.inputCacheHit, 0);
  assert.equal(p!.inputCacheMiss, 0);
  assert.equal(p!.output, 0);
});

test('pricingFor returns undefined on empty input', () => {
  assert.equal(pricingFor(''), undefined);
  assert.equal(pricingFor(undefined), undefined);
});

test('costUsd matches Reasonix telemetry math (deepseek-v4-flash example)', () => {
  // From openSrc/DeepSeek-Reasonix/benchmarks/real-world-cache: 435M
  // cached, 767K missed, 180K output. Cost should be ~$1.38.
  const cost = costUsd('deepseek-v4-flash', {
    cachedTokens: 435_033_856,
    missedTokens: 767_616,
    completionTokens: 179_763,
  });
  // $1.22 (hit) + $0.11 (miss) + $0.05 (output) = $1.38
  assert.ok(cost > 1.35 && cost < 1.42, `expected ~$1.38, got $${cost.toFixed(4)}`);
});

test('cacheSavingsUsd is 0 when no tokens were cached', () => {
  assert.equal(cacheSavingsUsd('deepseek-v4-flash', 0), 0);
});

test('cacheSavingsUsd is positive for a meaningful hit count', () => {
  const saved = cacheSavingsUsd('deepseek-v4-flash', 1_000_000);
  // (0.14 - 0.0028) per 1M → ~$0.1372 saved per 1M cached tokens.
  assert.ok(Math.abs(saved - 0.1372) < 0.01, `expected ~$0.1372, got $${saved.toFixed(4)}`);
});

test('formatCostBadge bands turn cost by threshold', () => {
  assert.equal(formatCostBadge(0.001, 'turn').band, 'green');
  assert.equal(formatCostBadge(0.1, 'turn').band, 'yellow');
  assert.equal(formatCostBadge(0.5, 'turn').band, 'red');
});

test('formatCostBadge session band is 10x the turn band', () => {
  // Session thresholds are 10× turn: green <$0.5, yellow <$2.0.
  // $0.4 is green at session scale but red at turn scale.
  assert.equal(formatCostBadge(0.4, 'session').band, 'green');
  assert.equal(formatCostBadge(0.4, 'turn').band, 'red');
  // $1.0 is yellow at session, red at turn.
  assert.equal(formatCostBadge(1.0, 'session').band, 'yellow');
  assert.equal(formatCostBadge(1.0, 'turn').band, 'red');
});

test('buildCostSummary aggregates into the panel shape', () => {
  _resetPricingCache();
  const summary = buildCostSummary({
    model: 'deepseek-v4-flash',
    turnCachedTokens: 50_000,
    turnMissedTokens: 10_000,
    turnCompletionTokens: 1_000,
    sessionCachedTokens: 200_000,
    sessionMissedTokens: 30_000,
    sessionCompletionTokens: 5_000,
  });
  assert.ok(summary.turnCostUsd > 0);
  assert.ok(summary.sessionCostUsd > summary.turnCostUsd);
  assert.ok(summary.cacheStats.turn.cacheHitRatio > 0.8);
  assert.equal(summary.turnBadge.text.startsWith('$'), true);
});

test('buildCostSummary handles a zero-token snapshot cleanly', () => {
  const summary = buildCostSummary({
    model: 'deepseek-v4-flash',
    turnCachedTokens: 0,
    turnMissedTokens: 0,
    turnCompletionTokens: 0,
    sessionCachedTokens: 0,
    sessionMissedTokens: 0,
    sessionCompletionTokens: 0,
  });
  assert.equal(summary.turnCostUsd, 0);
  assert.equal(summary.sessionCostUsd, 0);
  assert.equal(summary.turnBadge.band, 'mono');
});
