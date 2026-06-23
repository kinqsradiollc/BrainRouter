import test from 'node:test';
import assert from 'node:assert/strict';
import type { Config, LLMConfig } from '../config/config.js';
import { createModelGateway, ModelGateway } from '../provider/gateway.js';
import { listProviderNames, getProvider, resolveAgentLlm } from '../provider/agentModels.js';
import { isModelNotFoundError, shouldFallbackModel } from '../provider/modelFallback.js';

const base: LLMConfig = { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' };
const config: Pick<Config, 'providers' | 'agentModels'> = {
  providers: { openai: base, local: { provider: 'local', model: 'llama', apiKey: '' } },
  agentModels: { reviewer: { model: 'gpt-4o-mini' } },
};

test('ModelGateway is a pure facade — every method matches the provider module', () => {
  const gw = createModelGateway(config);
  assert.ok(gw instanceof ModelGateway);

  // registry
  assert.deepEqual(gw.listProviders(), listProviderNames(config));
  assert.deepEqual(gw.getProvider('openai'), getProvider(config, 'openai'));
  assert.equal(gw.getProvider('nope'), undefined);

  // per-role resolution (delegates to resolveAgentLlm — unchanged behaviour)
  assert.deepEqual(gw.resolveForRole(base, 'reviewer'), resolveAgentLlm(config, base, 'reviewer'));
  assert.deepEqual(gw.resolveForRole(base, 'unassigned'), resolveAgentLlm(config, base, 'unassigned'));

  // fallback policy
  assert.equal(gw.isModelNotFound('HTTP 404: model not found'), isModelNotFoundError('HTTP 404: model not found'));
  assert.equal(gw.isModelNotFound('rate limited'), isModelNotFoundError('rate limited'));
  assert.equal(gw.shouldFallback('a', 'b', false), shouldFallbackModel('a', 'b', false));
  assert.equal(gw.shouldFallback('a', 'a', false), shouldFallbackModel('a', 'a', false));
  assert.equal(gw.shouldFallback('a', 'b', true), shouldFallbackModel('a', 'b', true));
});
