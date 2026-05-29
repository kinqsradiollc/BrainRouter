import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TURN_END_RESULT_CAP_TOKENS,
  shouldProactivelyShrink,
  shrinkOversizedToolResults,
} from '../agent/turnEndShrink.js';

test('shrinkOversizedToolResults is a no-op when nothing exceeds the cap', () => {
  const history = [
    { role: 'system' as const, content: 'sys' },
    { role: 'user' as const, content: 'hi' },
    { role: 'tool' as const, content: 'short tool output', name: 'read_file' },
  ];
  const result = shrinkOversizedToolResults(history);
  assert.equal(result.shrunkCount, 0);
  assert.equal(result.charsSaved, 0);
  assert.equal(history[2]!.content, 'short tool output');
});

test('shrinkOversizedToolResults shrinks tool messages over the cap', () => {
  // Default cap = 3000 tokens × 4 chars/token = 12,000 chars.
  const bigOutput = 'a'.repeat(20_000);
  const history = [
    { role: 'system' as const, content: 'sys' },
    { role: 'tool' as const, name: 'list_dir', content: bigOutput },
  ];
  const result = shrinkOversizedToolResults(history, {
    compact: () => ({ inlineText: '[shrunk]' }),
  });
  assert.equal(result.shrunkCount, 1);
  assert.equal(history[1]!.content, '[shrunk]');
  assert.ok(result.charsSaved > 19_000);
  assert.ok(result.tokensSaved > 4000);
});

test('shrinkOversizedToolResults skips non-tool roles', () => {
  const big = 'a'.repeat(50_000);
  const history = [
    { role: 'user' as const, content: big },
    { role: 'assistant' as const, content: big },
    { role: 'system' as const, content: big },
  ];
  const result = shrinkOversizedToolResults(history, {
    compact: () => ({ inlineText: '[shrunk]' }),
  });
  assert.equal(result.shrunkCount, 0);
  assert.equal(history[0]!.content, big);
  assert.equal(history[1]!.content, big);
  assert.equal(history[2]!.content, big);
});

test('shrinkOversizedToolResults marks shrunk messages so they aren\'t re-shrunk', () => {
  const big = 'a'.repeat(50_000);
  const history = [
    { role: 'tool' as const, name: 't1', content: big },
  ];
  let compactCalls = 0;
  const compact = () => {
    compactCalls += 1;
    return { inlineText: '[shrunk]' };
  };
  shrinkOversizedToolResults(history, { compact });
  shrinkOversizedToolResults(history, { compact });
  shrinkOversizedToolResults(history, { compact });
  assert.equal(compactCalls, 1);
});

test('shrinkOversizedToolResults respects an explicit capTokens override', () => {
  const history = [
    { role: 'tool' as const, name: 't1', content: 'a'.repeat(800) },
  ];
  // 100 tokens × 4 chars = 400 char cap; 800-char content exceeds.
  const result = shrinkOversizedToolResults(history, {
    capTokens: 100,
    compact: () => ({ inlineText: '[shrunk-low-cap]' }),
  });
  assert.equal(result.shrunkCount, 1);
  assert.equal(history[0]!.content, '[shrunk-low-cap]');
});

test('shouldProactivelyShrink returns true above the ratio', () => {
  const history = [
    { role: 'tool' as const, content: 'a'.repeat(80_000) }, // ~20k tokens
  ];
  // 20k tokens / 40k ctxMax = 0.5 > 0.4
  assert.equal(shouldProactivelyShrink(history, 40_000), true);
});

test('shouldProactivelyShrink returns false below the ratio', () => {
  const history = [
    { role: 'tool' as const, content: 'a'.repeat(40_000) }, // ~10k tokens
  ];
  // 10k / 100k = 0.1 < 0.4
  assert.equal(shouldProactivelyShrink(history, 100_000), false);
});

test('TURN_END_RESULT_CAP_TOKENS default is 3000', () => {
  assert.equal(TURN_END_RESULT_CAP_TOKENS, 3000);
});
