import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LADDERS,
  NEEDS_HIGH_MARKER_RE,
  currentTier,
  detectNeedsHigh,
  nextTier,
  resolveTierLadder,
  stripNeedsHigh,
} from '../runtime/tierLadder.js';

test('detectNeedsHigh matches the bare marker on the first non-empty line', () => {
  const d = detectNeedsHigh('<<<NEEDS_HIGH>>>\nrest of the answer');
  assert.ok(d);
  assert.equal(d!.reason, null);
});

test('detectNeedsHigh extracts a reason after the colon', () => {
  const d = detectNeedsHigh('<<<NEEDS_HIGH: deep recursion required>>>\n\nthen explanation…');
  assert.ok(d);
  assert.equal(d!.reason, 'deep recursion required');
});

test('detectNeedsHigh ignores the marker when it is NOT the first non-empty line', () => {
  const d = detectNeedsHigh('Some preamble.\n<<<NEEDS_HIGH>>>\n');
  assert.equal(d, null);
});

test('detectNeedsHigh tolerates leading whitespace', () => {
  const d = detectNeedsHigh('   \n   <<<NEEDS_HIGH>>>');
  assert.ok(d);
});

test('stripNeedsHigh removes the marker for user-facing rendering', () => {
  const cleaned = stripNeedsHigh('<<<NEEDS_HIGH: too hard>>>\nlemme escalate');
  assert.equal(cleaned, 'lemme escalate');
});

test('stripNeedsHigh is a no-op on input without the marker', () => {
  assert.equal(stripNeedsHigh('hello world'), 'hello world');
});

test('resolveTierLadder degrades to a single-tier ladder for unknown providers without override', () => {
  // 0.3.9 removed the Anthropic built-in. With no provider id matched and
  // no override, the ladder collapses to a single-tier (flash = standard
  // = pro), so the marker becomes a no-op.
  const ladder = resolveTierLadder({ provider: 'anthropic' });
  assert.equal(ladder.ladder.flash, ladder.ladder.standard);
  assert.equal(ladder.ladder.standard, ladder.ladder.pro);
});

test('resolveTierLadder still works for the supported built-ins (openai, deepseek)', () => {
  const openai = resolveTierLadder({ provider: 'openai' });
  assert.equal(openai.ladder.flash, 'gpt-5-mini');
  assert.equal(openai.ladder.pro, 'gpt-5-pro');
  const deepseek = resolveTierLadder({ provider: 'deepseek' });
  assert.equal(deepseek.ladder.flash, 'deepseek-v4-flash');
  assert.equal(deepseek.ladder.pro, 'deepseek-v4-pro');
});

test('resolveTierLadder layers user overrides over built-ins', () => {
  const ladder = resolveTierLadder({
    provider: 'openai',
    override: { standard: 'gpt-5-codex' },
  });
  assert.equal(ladder.ladder.standard, 'gpt-5-codex');
  assert.equal(ladder.ladder.flash, DEFAULT_LADDERS.openai!.ladder.flash);
});

test('resolveTierLadder accepts a fully-custom ladder for unknown providers', () => {
  const ladder = resolveTierLadder({
    provider: 'cohere',
    override: { flash: 'command-r', standard: 'command-r-plus', pro: 'command-r-08-2024' },
  });
  assert.equal(ladder.ladder.flash, 'command-r');
  assert.equal(ladder.ladder.pro, 'command-r-08-2024');
});

test('resolveTierLadder degrades to single-tier when the provider is unknown and override is partial', () => {
  const ladder = resolveTierLadder({ provider: 'whatever', override: { flash: 'only-one' } });
  assert.equal(ladder.ladder.flash, ladder.ladder.standard);
  assert.equal(ladder.ladder.standard, ladder.ladder.pro);
});

test('currentTier identifies the active tier', () => {
  const ladder = resolveTierLadder({ provider: 'openai' });
  assert.equal(currentTier('gpt-5-mini', ladder), 'flash');
  assert.equal(currentTier('gpt-5', ladder), 'standard');
  assert.equal(currentTier('gpt-5-pro', ladder), 'pro');
  assert.equal(currentTier('unrelated-model', ladder), null);
});

test('nextTier walks the ladder, with pro as a hard top', () => {
  assert.equal(nextTier('flash'), 'standard');
  assert.equal(nextTier('standard'), 'pro');
  assert.equal(nextTier('pro'), null);
});

test('NEEDS_HIGH_MARKER_RE matches both bare and reasoned forms', () => {
  assert.match('<<<NEEDS_HIGH>>>', NEEDS_HIGH_MARKER_RE);
  assert.match('<<<NEEDS_HIGH: x>>>', NEEDS_HIGH_MARKER_RE);
  assert.doesNotMatch('NEEDS_HIGH', NEEDS_HIGH_MARKER_RE);
});
