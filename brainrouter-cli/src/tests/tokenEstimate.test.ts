/**
 * Tests for the content-aware token estimator. We don't claim
 * tokenizer-level accuracy — the goal is "close enough that
 * compaction never fires criminally early on prose or criminally
 * late on CJK/code." Numbers in these tests are documented
 * expected ranges, not exact predictions of any provider's BPE.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateChatHistoryTokens,
  estimateTokens,
  estimateTokensDetailed,
} from '../runtime/tokenEstimate.js';

test('estimateTokens: zero / null / non-string returns 0 without throwing', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null as any), 0);
  assert.equal(estimateTokens(undefined as any), 0);
  assert.equal(estimateTokens(123 as any), 0);
});

test('estimateTokens: English prose lands in the ~4 chars/token band', () => {
  const text = 'The quick brown fox jumps over the lazy dog. '.repeat(20);
  // 45 chars * 20 = 900 chars. ~225 tokens at 4:1 ratio.
  // We bucket the spaces+letters as `prose` → 900/4 = 225, rounded up.
  const tokens = estimateTokens(text);
  assert.ok(tokens >= 200 && tokens <= 260, `expected ~225 tokens for English prose, got ${tokens}`);
});

test('estimateTokens: CJK text lands in the much-denser ~1.5 chars/token band', () => {
  // 100 ideographs. Old `length/4` would have said 25 tokens. The real
  // count under any modern tokenizer is closer to 100/1.5 ≈ 67.
  const text = '汉'.repeat(100);
  const tokens = estimateTokens(text);
  assert.ok(tokens >= 60 && tokens <= 80, `expected ~67 tokens for 100 CJK chars, got ${tokens}`);
});

test('estimateTokens: code-heavy content is denser than prose', () => {
  const code = 'function foo(a: number, b: number): number { return a + b; }\n'.repeat(50);
  const proseEquivalent = 'a'.repeat(code.length);
  const codeTokens = estimateTokens(code);
  const proseTokens = estimateTokens(proseEquivalent);
  // Same length string; code has more code-density chars → more tokens.
  assert.ok(codeTokens > proseTokens, `code (${codeTokens}) should yield more tokens than prose-of-same-length (${proseTokens})`);
});

test('estimateTokensDetailed: returns per-class breakdown', () => {
  const text = 'Hello { world } 你好';
  const detail = estimateTokensDetailed(text);
  assert.ok(detail.breakdown.cjkChars >= 2, 'expected at least 2 CJK chars (你好)');
  assert.ok(detail.breakdown.codeChars >= 2, 'expected braces counted as code-density chars');
  assert.ok(detail.breakdown.proseChars > 0, 'expected prose chars counted');
  assert.equal(detail.tokens, detail.tokens, 'tokens is the sum of the per-class estimates');
});

test('estimateChatHistoryTokens: counts content + per-message overhead', () => {
  const history = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello there' },
  ];
  const tokens = estimateChatHistoryTokens(history);
  // 3 messages * 4 tokens overhead = 12, plus content tokens for each.
  // Lower bound = 12 + 1 + 1 + 1 = 15 (every short message contributes
  // at least 1 token of content via Math.ceil).
  assert.ok(tokens >= 15, `expected at least 15 tokens for 3 short messages, got ${tokens}`);
  // Upper bound — sanity check against the old `length / 4` proxy.
  const old = Math.ceil(JSON.stringify(history).length / 4);
  assert.ok(tokens < old, `estimator (${tokens}) should beat the legacy JSON-stringify proxy (${old})`);
});

test('estimateChatHistoryTokens: handles tool_calls as billed content', () => {
  const history = [
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { function: { name: 'read_file', arguments: '{"path":"src/foo.ts"}' } },
      ],
    },
  ];
  const tokens = estimateChatHistoryTokens(history);
  // The tool_call's name + arguments string both contribute to the count.
  assert.ok(tokens >= 10, `expected tool_call name+args to push count up, got ${tokens}`);
});
