import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateCacheStats,
  extractCacheStats,
  formatCacheStats,
  type CacheStats,
} from '../runtime/cacheStats.js';

test('extractCacheStats returns zeros for null / empty', () => {
  for (const v of [null, undefined, {}]) {
    const stats = extractCacheStats(v as any);
    assert.equal(stats.cachedTokens, 0);
    assert.equal(stats.missedTokens, 0);
    assert.equal(stats.cacheHitRatio, 0);
    assert.equal(stats.source, 'unknown');
  }
});

test('extractCacheStats reads OpenAI prompt_tokens_details.cached_tokens', () => {
  const stats = extractCacheStats({
    prompt_tokens: 10_000,
    completion_tokens: 500,
    prompt_tokens_details: { cached_tokens: 8_000 },
  });
  assert.equal(stats.cachedTokens, 8_000);
  assert.equal(stats.missedTokens, 2_000);
  assert.equal(stats.source, 'openai');
  assert.ok(Math.abs(stats.cacheHitRatio - 0.8) < 1e-9);
});

test('extractCacheStats reads DeepSeek prompt_cache_hit_tokens / miss_tokens', () => {
  const stats = extractCacheStats({
    prompt_tokens: 12_000,
    completion_tokens: 800,
    prompt_cache_hit_tokens: 11_800,
    prompt_cache_miss_tokens: 200,
  });
  assert.equal(stats.cachedTokens, 11_800);
  assert.equal(stats.missedTokens, 200);
  assert.equal(stats.source, 'deepseek');
  assert.ok(stats.cacheHitRatio > 0.98);
});

test('extractCacheStats: Anthropic native fields are no longer recognised (provider removed in 0.3.9)', () => {
  // Bare Anthropic-shape usage (no OpenAI-compat fields) returns zeros
  // — the runtime intentionally drops the Anthropic-native branch.
  const stats = extractCacheStats({
    input_tokens: 500,
    output_tokens: 200,
    cache_read_input_tokens: 9_000,
    cache_creation_input_tokens: 200,
  } as any);
  assert.equal(stats.cachedTokens, 0);
  assert.equal(stats.missedTokens, 0);
  assert.equal(stats.source, 'unknown');
});

test('extractCacheStats falls back to OpenAI when no nested field is present', () => {
  const stats = extractCacheStats({ prompt_tokens: 500, completion_tokens: 100 });
  assert.equal(stats.cachedTokens, 0);
  assert.equal(stats.missedTokens, 500);
  assert.equal(stats.source, 'openai');
});

test('aggregateCacheStats sums input correctly', () => {
  const snapshots: CacheStats[] = [
    { cachedTokens: 100, missedTokens: 50, cacheHitRatio: 0, source: 'openai' },
    { cachedTokens: 200, missedTokens: 50, cacheHitRatio: 0, source: 'deepseek' },
  ];
  const agg = aggregateCacheStats(snapshots);
  assert.equal(agg.cachedTokens, 300);
  assert.equal(agg.missedTokens, 100);
  assert.ok(Math.abs(agg.cacheHitRatio - 0.75) < 1e-9);
});

test('formatCacheStats handles the zero / unknown case', () => {
  assert.equal(
    formatCacheStats({ cachedTokens: 0, missedTokens: 0, cacheHitRatio: 0, source: 'unknown' }),
    'cache —',
  );
});

test('formatCacheStats renders a percentage and token ratio', () => {
  const formatted = formatCacheStats({
    cachedTokens: 800,
    missedTokens: 200,
    cacheHitRatio: 0.8,
    source: 'openai',
  });
  assert.match(formatted, /cache 80\.0% \(800\/1,000 tok\)/);
});

test('extractCacheStats ignores negative or non-finite cache fields defensively', () => {
  const stats = extractCacheStats({
    prompt_tokens: 1000,
    prompt_tokens_details: { cached_tokens: -50 as any },
  });
  assert.equal(stats.cachedTokens, 0);
  assert.equal(stats.missedTokens, 1000);
});
