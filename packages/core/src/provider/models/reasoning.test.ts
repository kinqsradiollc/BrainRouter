import test from 'node:test';
import assert from 'node:assert/strict';
import {
  _resetModelReasoningCapabilities,
  inferModelReasoningCapabilities,
  isReasoningModel,
  modelSupportsXhighEffort,
  registerModelReasoningCapabilities,
} from './reasoning.js';

test('reasoning metadata: live capabilities make an unlisted model reasoning-capable', () => {
  _resetModelReasoningCapabilities();
  assert.equal(isReasoningModel('future-model-9'), false);

  const caps = inferModelReasoningCapabilities({
    id: 'future-model-9',
    supported_parameters: ['tools', 'reasoning_effort'],
    supported_reasoning_efforts: ['low', 'high', 'xhigh'],
  });
  registerModelReasoningCapabilities('future-model-9', caps);

  assert.equal(isReasoningModel('future-model-9'), true);
  assert.equal(modelSupportsXhighEffort('future-model-9'), true);
  _resetModelReasoningCapabilities();
});

test('reasoning metadata: LM Studio capability object is a positive reasoning hint', () => {
  const caps = inferModelReasoningCapabilities({
    key: 'vendor/custom-local-model',
    capabilities: {
      reasoning: { allowed_options: ['on', 'off'], default: 'off' },
    },
  });
  assert.deepEqual(caps, { reasoning: true });
});

test('reasoning metadata does not override known non-reasoning chat variants', () => {
  _resetModelReasoningCapabilities();
  registerModelReasoningCapabilities('gpt-5-chat-latest', { reasoning: true, effort: true });
  assert.equal(isReasoningModel('gpt-5-chat-latest'), false);
  _resetModelReasoningCapabilities();
});
