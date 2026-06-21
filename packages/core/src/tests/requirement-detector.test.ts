import test from 'node:test';
import assert from 'node:assert/strict';
import { detectRequirementShapedPrompt } from '../requirement/requirementDetector.js';

test('requirement detector: imperative request with a concrete object becomes an auto-ready draft input', () => {
  const result = detectRequirementShapedPrompt('add a rate-limiter to the gateway');

  assert.equal(result.detected, true);
  assert.equal(result.candidate, false);
  assert.ok(result.confidence >= 0.7);
  assert.deepEqual(result.input, {
    title: 'Add a rate-limiter to the gateway',
    description: 'add a rate-limiter to the gateway',
    acceptanceCriteria: ['Add a rate-limiter to the gateway.'],
  });
});
test('requirement detector: questions and conversational prompts do not create requirements', () => {
  assert.equal(detectRequirementShapedPrompt('what does the gateway do?').detected, false);
  assert.equal(detectRequirementShapedPrompt('thanks for the update').detected, false);
  assert.equal(detectRequirementShapedPrompt('maybe we should rewrite the parser').detected, false);
});

test('requirement detector: ambiguous implementation intent remains a candidate below the auto-create threshold', () => {
  const result = detectRequirementShapedPrompt('improve caching', { autoCreateThreshold: 0.8, lowActThreshold: 0.4 });

  assert.equal(result.detected, false);
  assert.equal(result.candidate, true);
  assert.ok(result.confidence >= 0.4 && result.confidence < 0.8);
  assert.match(result.clarify ?? '', /scope/i);
});

test('requirement detector: an equivalent open requirement suppresses duplicate creation', () => {
  const result = detectRequirementShapedPrompt('add a rate limiter to the gateway', {
    openRequirements: [{
      title: 'Add a rate-limiter to the gateway',
      acceptanceCriteria: ['Add a rate-limiter to the gateway.'],
      status: 'draft',
    }],
  });

  assert.equal(result.detected, false);
  assert.equal(result.candidate, false);
  assert.equal(result.duplicate, true);
});
