/**
 * ADR-027 D4.1 — input modality as a declared model capability.
 *
 * The helpers live in `@kinqs/brainrouter-types`, which ships no test runner;
 * this suite exercises them from core, which does. A test in a package nothing
 * runs is worse than no test — it reads as coverage while proving nothing.
 *
 * The property under test is the one that matters in production: `unknown` must
 * never collapse into `unsupported`. The dangerous failure is not a rejected
 * request — it is a model that silently ignores an image and answers
 * confidently about a picture it never received, with no signal to the human.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  modelAcceptsModality,
  parseModelInputModalities,
  isModelInputModality,
  type ModelCapabilities,
} from '@kinqs/brainrouter-types';

function caps(input?: ModelCapabilities['input']): ModelCapabilities {
  return { streaming: true, tools: true, responses: false, reasoning: false, ...(input ? { input } : {}) };
}

test('a model with no declared modality reads as unknown, never as text-only', () => {
  assert.equal(modelAcceptsModality(caps(), 'image'), 'unknown');
  assert.equal(modelAcceptsModality(caps({ status: 'unknown' }), 'image'), 'unknown');
  // A BYOK model an operator never annotated must not have vision silently
  // disabled on it.
  assert.equal(modelAcceptsModality(null, 'image'), 'unknown');
  assert.equal(modelAcceptsModality(undefined, 'image'), 'unknown');
});

test('a known accept-list answers per modality', () => {
  const vision = caps({ status: 'known', accepts: ['image'] });
  assert.equal(modelAcceptsModality(vision, 'image'), 'accepted');
  assert.equal(modelAcceptsModality(vision, 'pdf'), 'unsupported');
  assert.equal(modelAcceptsModality(vision, 'audio'), 'unsupported');
});

test('an explicitly empty accept-list means text-only, which is NOT unknown', () => {
  // "We checked and it takes text only" is a real, useful answer and must be
  // distinguishable from "nobody has told us".
  const textOnly = caps({ status: 'known', accepts: [] });
  assert.equal(modelAcceptsModality(textOnly, 'image'), 'unsupported');
});

test('native document input is expressible alongside image', () => {
  // The reason this is a set and not a vision boolean: a model that accepts a
  // PDF directly lets the document pipeline skip extraction for that model.
  const multi = caps({ status: 'known', accepts: ['image', 'pdf'] });
  assert.equal(modelAcceptsModality(multi, 'image'), 'accepted');
  assert.equal(modelAcceptsModality(multi, 'pdf'), 'accepted');
  assert.equal(modelAcceptsModality(multi, 'audio'), 'unsupported');
});

test('a malformed stored blob degrades to unknown, not to an empty accept-list', () => {
  // A parse failure is an ABSENCE of information. Reading it as "supports
  // nothing" would silently disable a capable model on a bad write.
  for (const bad of [null, undefined, 'image', 42, [], {}, { accepts: 'image' }, { accepts: null }]) {
    assert.deepEqual(parseModelInputModalities(bad), { status: 'unknown' }, `for ${JSON.stringify(bad)}`);
  }
});

test('parsing keeps recognised modalities, drops junk, and de-duplicates', () => {
  assert.deepEqual(
    parseModelInputModalities({ accepts: ['image', 'video', 'image', 'pdf', 7, null] }),
    { status: 'known', accepts: ['image', 'pdf'] },
  );
  // An explicit empty array survives as a known text-only answer.
  assert.deepEqual(parseModelInputModalities({ accepts: [] }), { status: 'known', accepts: [] });
});

test('modality narrowing accepts only the declared set', () => {
  assert.ok(isModelInputModality('image'));
  assert.ok(isModelInputModality('pdf'));
  assert.ok(isModelInputModality('audio'));
  for (const bad of ['video', 'Image', '', 0, null, undefined, {}]) {
    assert.equal(isModelInputModality(bad), false, `for ${JSON.stringify(bad)}`);
  }
});

test('a round trip through the parser preserves the verdict', () => {
  const parsed = parseModelInputModalities({ accepts: ['image'] });
  assert.equal(modelAcceptsModality(caps(parsed), 'image'), 'accepted');
  assert.equal(modelAcceptsModality(caps(parsed), 'audio'), 'unsupported');
});
