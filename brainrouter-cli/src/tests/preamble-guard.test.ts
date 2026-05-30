import test from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeStalledPreamble, looksLikeDeferredToolPromise, stripLeadingAck } from '../agent/toolCallRecovery.js';

// The exact phrasing that slipped through the guard (gpt-5.3-codex):
const STALL = 'Absolutely — I\'ll run the full deep sweep now (lint, strict types, audits, and runtime smoke paths) and return a prioritized bug list with exact file paths.';

test('stripLeadingAck peels a leading acknowledgement + separator', () => {
  assert.match(stripLeadingAck(STALL), /^I'll run the full deep sweep/);
  assert.match(stripLeadingAck('Sure, let me check the repo'), /^let me check/i);
  assert.match(stripLeadingAck('Got it! Now I\'ll search'), /^Now I'll search/);
  assert.equal(stripLeadingAck('The answer is 42.'), 'The answer is 42.'); // no ack → unchanged
});

test('looksLikeStalledPreamble: catches a leading-ack preamble (the real miss)', () => {
  assert.equal(looksLikeStalledPreamble(STALL), true);
  assert.equal(looksLikeStalledPreamble("I'll run the search now"), true);
});

test('looksLikeStalledPreamble: a substantive prose answer is NOT a preamble', () => {
  assert.equal(looksLikeStalledPreamble('The recall pipeline fuses FTS and vector hits with RRF, then reranks.'), false);
});

test('looksLikeDeferredToolPromise: true when it announces tool work but (the caller knows) emitted none', () => {
  assert.equal(looksLikeDeferredToolPromise(STALL), true);                          // I'll + run/sweep/audit
  assert.equal(looksLikeDeferredToolPromise('Sure, let me check the codebase for bugs.'), true);
  assert.equal(looksLikeDeferredToolPromise('Now I will grep for the failing call sites.'), true);
});

test('looksLikeDeferredToolPromise: false for prose answers (protects legit zero-tool turns)', () => {
  // future intent but NO tool-action verb → a real prose answer, must not force-loop
  assert.equal(looksLikeDeferredToolPromise("I'll explain how the recall pipeline works: it uses RRF."), false);
  // no future intent at all
  assert.equal(looksLikeDeferredToolPromise('The answer is 42.'), false);
  assert.equal(looksLikeDeferredToolPromise(''), false);
});

test('looksLikeDeferredToolPromise: adjacency — a tool verb buried in prose does NOT match', () => {
  // Regression (these wrongly matched when the verb was scanned anywhere): the
  // opener verb is explanatory (summarize/clarify/note), so they are answers.
  assert.equal(looksLikeDeferredToolPromise("I'll summarize: the function reads the config and runs once."), false);
  assert.equal(looksLikeDeferredToolPromise('Let me clarify — the test passes and the build is green.'), false);
  assert.equal(looksLikeDeferredToolPromise("I'll note that grep finds three call sites."), false);
  // still catches genuine promises (tool verb adjacent to the opener)
  assert.equal(looksLikeDeferredToolPromise("I'll start by exploring the repo"), true);
  assert.equal(looksLikeDeferredToolPromise('Let me just run the tests'), true);
});
