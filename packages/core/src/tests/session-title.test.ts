/**
 * ADR-027 D8 (P5-2) — session naming.
 *
 * The bulk of these test REJECTION, because that is where the value is. A model
 * asked for a title will sometimes hand back a refusal, a preamble, a quoted
 * restatement, or a paragraph, and any of those pasted into a session list is
 * worse than an honest truncation of what the user typed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveSessionTitle,
  resolveSessionTitleDecision,
  normalizeAgentTitle,
  normalizeExplicitSessionTitle,
  deriveSessionTitle,
  MAX_SESSION_TITLE,
  UNTITLED_SESSION,
} from '../session/sessionTitle.js';

test('a good agent title is used verbatim', () => {
  assert.equal(normalizeAgentTitle('Fix post-merge build failure'), 'Fix post-merge build failure');
});

test('quotes and backticks the model wrapped around the title are stripped', () => {
  assert.equal(normalizeAgentTitle('"Fix the login redirect"'), 'Fix the login redirect');
  assert.equal(normalizeAgentTitle("'Fix the login redirect'"), 'Fix the login redirect');
  assert.equal(normalizeAgentTitle('`Fix the login redirect`'), 'Fix the login redirect');
});

test('a preamble is rejected — the model answered the wrong question', () => {
  for (const bad of [
    "Here's a title: Fix the build",
    'Sure! Fix the build',
    'Certainly, I can help with that',
    'Title: Fix the build',
    'Session title: Fix the build',
    'I will name this Fix the build',
  ]) {
    assert.equal(normalizeAgentTitle(bad), null, `should reject: ${bad}`);
  }
});

test('a refusal is rejected rather than stored as a name', () => {
  for (const bad of ['I cannot help with that', "Sorry, I can't do this", 'As an AI language model, I…']) {
    assert.equal(normalizeAgentTitle(bad), null, `should reject: ${bad}`);
  }
});

test('structural output is rejected', () => {
  for (const bad of ['# Fix the build', '- Fix the build', '{"title": "Fix"}', '["Fix the build"]', '| a | b |']) {
    assert.equal(normalizeAgentTitle(bad), null, `should reject: ${bad}`);
  }
});

test('multi-line output is rejected rather than guessed at', () => {
  assert.equal(normalizeAgentTitle('Fix the build\nAlso update docs'), null);
});

test('a single word or empty answer names nothing', () => {
  for (const bad of ['', '   ', 'Fix', 'Bug', null, undefined, 42 as unknown as string]) {
    assert.equal(normalizeAgentTitle(bad as string), null, `should reject: ${JSON.stringify(bad)}`);
  }
});

test('a paragraph is rejected; a merely-long title is truncated', () => {
  assert.equal(normalizeAgentTitle('word '.repeat(60).trim()), null, 'far too long is a paragraph');

  const longish = 'Fix the authentication redirect loop that appears after session expiry';
  const out = normalizeAgentTitle(longish);
  assert.ok(out);
  assert.ok(out.length <= MAX_SESSION_TITLE, 'the ellipsis remains inside the shared title cap');
  assert.match(out, /…$/);
  assert.doesNotMatch(out, /\s…$/, 'truncation trims before the ellipsis');
});

test('title truncation keeps the ellipsis in bounds without splitting emoji', () => {
  const out = normalizeExplicitSessionTitle('😀'.repeat(40));
  assert.ok(out);
  assert.ok(out.length <= MAX_SESSION_TITLE);
  assert.equal(out.endsWith('…'), true);
  assert.equal(Array.from(out.slice(0, -1)).every((character) => character === '😀'), true);
});

test('derivation keeps the first sentence rather than a blind cut', () => {
  const derived = deriveSessionTitle('The build is broken. It started after the merge yesterday.');
  assert.equal(derived, 'The build is broken');
});

test('derivation drops pasted code and stack traces', () => {
  // A pasted block is not a name. If nothing but code was sent, say so plainly.
  const derived = deriveSessionTitle('```\nTypeError: undefined is not a function\n```');
  assert.equal(derived, UNTITLED_SESSION);

  const mixed = deriveSessionTitle('Why does this fail? `foo.bar()` throws every time.');
  assert.equal(mixed, 'Why does this fail');
});

test('derivation truncates on a word boundary, never mid-token', () => {
  const derived = deriveSessionTitle('a'.repeat(20) + ' ' + 'b'.repeat(80));
  assert.ok(derived.length <= MAX_SESSION_TITLE);
  assert.match(derived, /…$/);
});

test('derivation degrades to a named placeholder, never to an empty string', () => {
  for (const empty of ['', '   ', null, undefined, 123 as unknown as string]) {
    assert.equal(deriveSessionTitle(empty as string), UNTITLED_SESSION);
  }
});

test('resolve prefers the agent title and falls back on a bad one', () => {
  assert.equal(
    resolveSessionTitle({ agentTitle: 'Fix the redirect loop', firstUserMessage: 'hey the login is broken' }),
    'Fix the redirect loop',
  );
  // A rejected agent title must not blank the session — fall back to derivation.
  assert.equal(
    resolveSessionTitle({ agentTitle: "Here's a title", firstUserMessage: 'The login is broken.' }),
    'The login is broken',
  );
  assert.equal(resolveSessionTitle({}), UNTITLED_SESSION);
});

test('human and hook titles outrank agent and derived titles', () => {
  assert.deepEqual(resolveSessionTitleDecision({
    humanTitle: 'Release work',
    hookTitle: 'Hook title',
    agentTitle: 'Agent proposal',
    firstUserMessage: 'Derived request',
  }), { title: 'Release work', source: 'human' });
  assert.deepEqual(resolveSessionTitleDecision({
    hookTitle: 'Hook title',
    agentTitle: 'Agent proposal',
    firstUserMessage: 'Derived request',
  }), { title: 'Hook title', source: 'hook' });
});

test('the same inputs give the same name on every surface', () => {
  // The bug this prevents: desktop cut at 48 and said "New session", the
  // dashboard cut at 52 and said "Untitled task", so one session had two names
  // depending on where you looked at it.
  const input = { firstUserMessage: 'Investigate the flaky checkout test that fails on CI only.' };
  assert.equal(resolveSessionTitle(input), resolveSessionTitle({ ...input }));
});
