import test from 'node:test';
import assert from 'node:assert/strict';
import type { Config, LLMConfig } from '../config/config.js';
import {
  resolveAgentLlm,
  setProvider,
  removeProvider,
  setAgentModel,
  listProviderNames,
  describeAgentModel,
  isSubagentRole,
} from '../config/agentModels.js';

const main: LLMConfig = { provider: 'openai', apiKey: 'main-key', model: 'gpt-5.3', endpoint: 'https://api.openai.com/v1' };
const groq: LLMConfig = { provider: 'groq', apiKey: 'groq-key', model: 'llama-3.3-70b', endpoint: 'https://api.groq.com/openai/v1' };

const baseConfig = (): Config => ({ activeServer: 's', servers: {}, llm: main });

test('resolveAgentLlm: no assignment → inherits the parent base LLM', () => {
  assert.deepEqual(resolveAgentLlm(baseConfig(), main, 'explorer'), main);
});

test('resolveAgentLlm: provider assignment swaps endpoint/key + model', () => {
  const cfg = setProvider(baseConfig(), 'groq', groq);
  const withRole = setAgentModel(cfg, 'explorer', { provider: 'groq' });
  const r = resolveAgentLlm(withRole, main, 'explorer');
  assert.equal(r.endpoint, groq.endpoint);
  assert.equal(r.apiKey, groq.apiKey);
  assert.equal(r.model, groq.model, 'uses the provider default model when none given');
});

test('resolveAgentLlm: provider + explicit model', () => {
  let cfg = setProvider(baseConfig(), 'groq', groq);
  cfg = setAgentModel(cfg, 'reviewer', { provider: 'groq', model: 'llama-3.1-405b' });
  const r = resolveAgentLlm(cfg, main, 'reviewer');
  assert.equal(r.endpoint, groq.endpoint);
  assert.equal(r.model, 'llama-3.1-405b');
});

test('resolveAgentLlm: model-only assignment keeps the parent provider', () => {
  const cfg = setAgentModel(baseConfig(), 'worker', { model: 'gpt-5.3-codex' });
  const r = resolveAgentLlm(cfg, main, 'worker');
  assert.equal(r.endpoint, main.endpoint);
  assert.equal(r.apiKey, main.apiKey);
  assert.equal(r.model, 'gpt-5.3-codex');
});

test('resolveAgentLlm: default role applies to any unassigned sub-agent', () => {
  let cfg = setProvider(baseConfig(), 'groq', groq);
  cfg = setAgentModel(cfg, 'default', { provider: 'groq' });
  cfg = setAgentModel(cfg, 'reviewer', { model: 'gpt-5.3-codex' }); // reviewer overrides
  assert.equal(resolveAgentLlm(cfg, main, 'explorer').endpoint, groq.endpoint, 'explorer → default → groq');
  assert.equal(resolveAgentLlm(cfg, main, 'reviewer').model, 'gpt-5.3-codex', 'reviewer override wins');
  assert.equal(resolveAgentLlm(cfg, main, 'reviewer').endpoint, main.endpoint, 'reviewer model-only keeps main endpoint');
});

test('setProvider / listProviderNames / setAgentModel are immutable transforms', () => {
  const cfg = baseConfig();
  const withGroq = setProvider(cfg, 'groq', groq);
  assert.deepEqual(listProviderNames(cfg), [], 'original config untouched');
  assert.deepEqual(listProviderNames(withGroq), ['groq']);
  const withRole = setAgentModel(withGroq, 'explorer', { provider: 'groq', model: 'x' });
  assert.equal(withGroq.agentModels, undefined, 'original untouched');
  assert.deepEqual(withRole.agentModels?.explorer, { provider: 'groq', model: 'x' });
});

test('setAgentModel with empty assignment clears the role', () => {
  let cfg = setAgentModel(baseConfig(), 'worker', { model: 'x' });
  assert.ok(cfg.agentModels?.worker);
  cfg = setAgentModel(cfg, 'worker', { provider: '', model: '  ' });
  assert.equal(cfg.agentModels, undefined, 'clearing the last role drops agentModels entirely');
});

test('removeProvider drops the provider AND any role pointing at it (keeps model-only)', () => {
  let cfg = setProvider(baseConfig(), 'groq', groq);
  cfg = setAgentModel(cfg, 'explorer', { provider: 'groq' });
  cfg = setAgentModel(cfg, 'reviewer', { provider: 'groq', model: 'keep-me' });
  cfg = removeProvider(cfg, 'groq');
  assert.equal(cfg.providers, undefined, 'provider removed');
  assert.equal(cfg.agentModels?.explorer, undefined, 'provider-only role dropped');
  assert.deepEqual(cfg.agentModels?.reviewer, { model: 'keep-me' }, 'model-only override preserved');
});

test('describeAgentModel + isSubagentRole', () => {
  let cfg = setProvider(baseConfig(), 'groq', groq);
  cfg = setAgentModel(cfg, 'explorer', { provider: 'groq' });
  assert.equal(describeAgentModel(cfg, 'explorer'), 'groq · llama-3.3-70b');
  assert.equal(describeAgentModel(cfg, 'worker'), 'inherits main model');
  assert.ok(isSubagentRole('reviewer'));
  assert.ok(!isSubagentRole('nope'));
});
