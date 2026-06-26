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
 * case): a model that advertises only `on`/`off` is reporting a thinking-mode
 * toggle, not necessarily a valid `reasoning_effort` wire value. Providers must
 * not inherit `on` from local metadata unless their own contract opts in.
 *
 * Tests use DISTINCT model names so the shared capability registry never
 * cross-contaminates between concurrently-run tests (no global reset needed).
 */

const cfg = (model: string, overrides: Record<string, unknown> = {}): any => ({
  provider: 'openai-compatible',
  apiKey: 'k',
  model,
  ...overrides,
});

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

test('resolveWireEffort: binary metadata alone does not emit on/off as reasoning_effort', () => {
  registerModelReasoningCapabilities('lmstudio/gemma-4-12b-qat', { reasoning: true, efforts: ['on', 'off'] });
  const lmStudio = cfg('lmstudio/gemma-4-12b-qat', { provider: 'lmstudio', endpoint: 'http://localhost:1234/v1' });
  assert.equal(resolveWireEffort(lmStudio, 'high'), 'high', 'LM Studio documents graded effort; on/off metadata is not a wire effort');
  assert.equal(resolveWireEffort(lmStudio, 'low'), 'low');
  assert.equal(resolveWireEffort(lmStudio, 'xhigh'), 'high', 'LM Studio has no xhigh tier, so cap to high');
  assert.equal(resolveWireEffort(lmStudio, 'medium'), null, 'medium omits the field → model default');

  const genericLocal = cfg('lmstudio/gemma-4-12b-qat', { provider: 'openai', endpoint: 'http://localhost:1234/v1' });
  assert.equal(resolveWireEffort(genericLocal, 'high'), 'high', 'generic local endpoints use graded OpenAI-compatible effort unless a provider opts into binary');
});

test('resolveWireEffort: binary metadata does not force cloud or named graded providers to send on', () => {
  registerModelReasoningCapabilities('gpt-5-binary-metadata', { reasoning: true, efforts: ['on', 'off'] });
  assert.equal(
    resolveWireEffort(cfg('gpt-5-binary-metadata', { provider: 'openai', endpoint: 'https://api.openai.com/v1' }), 'high'),
    'high',
    'OpenAI rejects reasoning_effort=on; provider graded contract wins',
  );
  assert.equal(
    resolveWireEffort(cfg('gpt-5-binary-metadata', { provider: 'openai', endpoint: 'https://api.openai.com/v1' }), 'xhigh'),
    'high',
    'OpenAI gpt-5 caps xhigh to high instead of inheriting binary on',
  );

  registerModelReasoningCapabilities('deepseek-v4-binary-metadata', { reasoning: true, efforts: ['on', 'off'] });
  assert.equal(
    resolveWireEffort(cfg('deepseek-v4-binary-metadata', { provider: 'openai-compatible', endpoint: 'https://api.deepseek.com/v1' }), 'xhigh'),
    'max',
    'DeepSeek keeps its provider-specific xhigh=max mapping',
  );

  registerModelReasoningCapabilities('qwen3-binary-metadata', { reasoning: true, efforts: ['on', 'off'] });
  assert.equal(
    resolveWireEffort(cfg('qwen3-binary-metadata', { provider: 'ollama', endpoint: 'http://localhost:11434/v1' }), 'high'),
    'high',
    'Ollama is local but has a known graded effort contract',
  );
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
