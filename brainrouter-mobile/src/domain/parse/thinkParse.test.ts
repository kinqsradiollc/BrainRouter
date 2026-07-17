import test from 'node:test';
import assert from 'node:assert/strict';
import { parseThink } from './thinkParse.js';

test('no reasoning tags → text passes through unchanged', () => {
  const p = parseThink('Just a normal answer.');
  assert.equal(p.hadThink, false);
  assert.equal(p.visible, 'Just a normal answer.');
  assert.equal(p.reasoning, '');
});

test('leading <think> block is extracted; visible answer is the remainder', () => {
  const p = parseThink('<think>weigh A vs B, B wins</think>The answer is B.');
  assert.equal(p.hadThink, true);
  assert.equal(p.streaming, false);
  assert.equal(p.reasoning, 'weigh A vs B, B wins');
  assert.equal(p.visible, 'The answer is B.');
});

test('tag matching is case-insensitive and tolerates leading whitespace', () => {
  const p = parseThink('\n  <Thinking>step one</Thinking>\nDone.');
  assert.equal(p.reasoning, 'step one');
  assert.equal(p.visible, 'Done.');
});

test('alternative reasoning tags (thought/reasoning) are recognized', () => {
  assert.equal(parseThink('<thought>hmm</thought>ok').reasoning, 'hmm');
  assert.equal(parseThink('<reasoning>r</reasoning>v').visible, 'v');
});

test('an unclosed (still streaming) block is all reasoning, no visible answer yet', () => {
  const p = parseThink('<think>still reasoning and not done');
  assert.equal(p.hadThink, true);
  assert.equal(p.streaming, true);
  assert.equal(p.reasoning, 'still reasoning and not done');
  assert.equal(p.visible, '');
});

test('a <think> that appears MID-answer is left untouched (e.g. code about HTML)', () => {
  const src = 'Use the tag like this:\n```html\n<think>x</think>\n```';
  const p = parseThink(src);
  assert.equal(p.hadThink, false, 'only a LEADING block counts');
  assert.equal(p.visible, src);
});

test('mismatched open/close tags do not cross-match', () => {
  // <think> opened, </thinking> close — not a matching pair → treated as unclosed.
  const p = parseThink('<think>reasoning</thinking>');
  assert.equal(p.streaming, true);
  assert.equal(p.reasoning, 'reasoning</thinking>');
});

test('multiline reasoning is preserved and trimmed', () => {
  const p = parseThink('<think>line one\nline two</think>\n\nFinal.');
  assert.equal(p.reasoning, 'line one\nline two');
  assert.equal(p.visible, 'Final.');
});

test('empty input is safe', () => {
  const p = parseThink('');
  assert.deepEqual(p, { reasoning: '', visible: '', hadThink: false, streaming: false });
});
