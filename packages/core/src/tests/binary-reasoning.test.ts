import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inferModelReasoningCapabilities,
  registerModelReasoningCapabilities,
  isBinaryReasoningModel,
} from '../provider/models/reasoning.js';
import { resolveWireEffort } from '../agent/agent.js';

/**
 * Binary on/off reasoning detection (the google/gemma-4-12b-qat on LM Studio
 * case): a model that advertises only `on`/`off` must never be sent a graded
 * `low`/`high` value it rejects — it collapses to `on`.
 *
 * Tests use DISTINCT model names so the shared capability registry never
 * cross-contaminates between concurrently-run tests (no global reset needed).
 */

const cfg = (model: string): any => ({ provider: 'openai-compatible', apiKey: 'k', model });

test('inferModelReasoningCapabilities: flat supported_reasoning_efforts on/off → binary vocab', () => {
  const caps = inferModelReasoningCapabilities({ id: 'm', supported_reasoning_efforts: ['on', 'off'] });
  assert.deepEqual(caps.efforts, ['on', 'off']);
  assert.equal(caps.reasoning, true);
  assert.equal(caps.effort, undefined, 'on/off is NOT the graded reasoning_effort param');
});

test('inferModelReasoningCapabilities: LM Studio capabilities.reasoning.allowed_options', () => {
  const caps = inferModelReasoningCapabilities({
    key: 'm',
    capabilities: { reasoning: { allowed_options: ['On', 'Off'], default: 'off' } },
  });
  assert.deepEqual(caps.efforts, ['on', 'off'], 'lowercased + captured from the nested LM Studio shape');
  assert.equal(caps.reasoning, true);
});

test('inferModelReasoningCapabilities: graded vocab marks effort:true and is NOT binary', () => {
  const caps = inferModelReasoningCapabilities({ id: 'm', supported_reasoning_efforts: ['low', 'medium', 'high'] });
  assert.deepEqual(caps.efforts, ['low', 'medium', 'high']);
  assert.equal(caps.effort, true);
});

test('isBinaryReasoningModel: on/off true; graded false; mixed false; unknown false', () => {
  registerModelReasoningCapabilities('vendor/bin-only', { reasoning: true, efforts: ['on', 'off'] });
  registerModelReasoningCapabilities('vendor/graded-only', { reasoning: true, efforts: ['low', 'high'] });
  registerModelReasoningCapabilities('vendor/mixed', { reasoning: true, efforts: ['on', 'off', 'high'] });
  assert.equal(isBinaryReasoningModel('vendor/bin-only'), true);
  assert.equal(isBinaryReasoningModel('bin-only'), true, 'matches vendor-stripped form too');
  assert.equal(isBinaryReasoningModel('vendor/graded-only'), false);
  assert.equal(isBinaryReasoningModel('vendor/mixed'), false, 'a graded tier present → send graded, not on/off');
  assert.equal(isBinaryReasoningModel('vendor/never-registered'), false);
});

test('resolveWireEffort: binary model collapses every graded effort to on (medium omits)', () => {
  registerModelReasoningCapabilities('lmstudio/gemma-4-12b-qat', { reasoning: true, efforts: ['on', 'off'] });
  const c = cfg('lmstudio/gemma-4-12b-qat');
  assert.equal(resolveWireEffort(c, 'high'), 'on', 'high → on (was sending invalid high)');
  assert.equal(resolveWireEffort(c, 'low'), 'on', 'low → on');
  assert.equal(resolveWireEffort(c, 'xhigh'), 'on', 'xhigh → on');
  assert.equal(resolveWireEffort(c, 'medium'), null, 'medium omits the field → model default');
});

test('resolveWireEffort: graded model is unaffected by the binary path', () => {
  registerModelReasoningCapabilities('vendor/graded-reasoner', { reasoning: true, effort: true, efforts: ['low', 'medium', 'high'] });
  const c = cfg('vendor/graded-reasoner');
  assert.equal(resolveWireEffort(c, 'high'), 'high', 'graded value passes through');
  assert.equal(resolveWireEffort(c, 'low'), 'low');
});

test('resolveWireEffort: model with no advertised vocab keeps prior behavior', () => {
  // No registration → isBinaryReasoningModel false → DEFAULT_EFFORT_VALUE_MAP applies.
  const c = cfg('vendor/unknown-effort-model');
  assert.equal(resolveWireEffort(c, 'high'), 'high');
});
