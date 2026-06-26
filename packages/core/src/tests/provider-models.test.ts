import test from 'node:test';
import assert from 'node:assert/strict';
import type { Config, LLMConfig } from '../config/config.js';
import {
  setProvider,
  removeProvider,
  resolveAgentLlm,
  normalizeProviderModels,
} from '../provider/agentModels.js';

const main: LLMConfig = { provider: 'openai', apiKey: 'main-key', model: 'gpt-5.3', endpoint: 'https://api.openai.com/v1' };
const baseConfig = (): Config => ({ activeServer: 's', servers: {}, llm: main });

// A named provider carrying the new Onyx-parity `models` allowlist.
const groqMulti: LLMConfig = {
  provider: 'groq',
  apiKey: 'groq-key',
  model: 'llama-3.3-70b',
  endpoint: 'https://api.groq.com/openai/v1',
  models: ['llama-3.3-70b', 'llama-3.1-405b', 'mixtral-8x7b'],
};

test('setProvider round-trips models[] through a JSON save/load cycle, order preserved', () => {
  const cfg = setProvider(baseConfig(), 'groq', groqMulti);
  // mimic saveConfig → loadConfig (JSON serialize/parse), no filesystem.
  const reloaded = JSON.parse(JSON.stringify(cfg)) as Config;
  assert.deepEqual(reloaded.providers?.groq.models, ['llama-3.3-70b', 'llama-3.1-405b', 'mixtral-8x7b']);
  assert.equal(reloaded.providers?.groq.model, 'llama-3.3-70b', 'single default preserved alongside the allowlist');
});

test('setProvider round-trips an optional apiVersion alongside models[]', () => {
  const azure: LLMConfig = { provider: 'azure', apiKey: 'k', model: 'gpt-4o', endpoint: 'https://r.openai.azure.com/openai/v1', models: ['gpt-4o'], apiVersion: '2024-02-01' };
  const reloaded = JSON.parse(JSON.stringify(setProvider(baseConfig(), 'az', azure))) as Config;
  assert.equal(reloaded.providers?.az.apiVersion, '2024-02-01');
});

test('a provider with no models[] yields NO models key (legacy shape, backward compatible)', () => {
  const single: LLMConfig = { provider: 'openai', apiKey: 'k', model: 'gpt-5.3', endpoint: 'https://api.openai.com/v1' };
  const cfg = setProvider(baseConfig(), 'main2', single);
  const reloaded = JSON.parse(JSON.stringify(cfg)) as Config;
  assert.equal('models' in (reloaded.providers?.main2 ?? {}), false, 'no phantom models[] injected');
});

test('removeProvider drops a provider that carried models[]', () => {
  let cfg = setProvider(baseConfig(), 'groq', groqMulti);
  cfg = removeProvider(cfg, 'groq');
  assert.equal(cfg.providers, undefined);
});

test('resolveAgentLlm ignores models[] — resolution still uses the single default model', () => {
  const cfg = setProvider(baseConfig(), 'groq', groqMulti);
  const withRole = { ...cfg, agentModels: { explorer: { provider: 'groq' } } };
  const r = resolveAgentLlm(withRole, main, 'explorer');
  assert.equal(r.model, 'llama-3.3-70b', 'uses provider default, not the array');
  assert.equal('models' in r, false, 'models[] does not leak into a resolved LLM');
});

test('normalizeProviderModels: empty/absent allowlist passes the default through unchanged', () => {
  assert.deepEqual(normalizeProviderModels('gpt-5.3', undefined), { model: 'gpt-5.3' });
  assert.deepEqual(normalizeProviderModels('gpt-5.3', []), { model: 'gpt-5.3' });
  assert.deepEqual(normalizeProviderModels('gpt-5.3', ['   ', '']), { model: 'gpt-5.3' }, 'all-blank ⇒ no allowlist');
});

test('normalizeProviderModels: default ∉ allowlist → falls back to models[0]', () => {
  assert.deepEqual(
    normalizeProviderModels('not-listed', ['a', 'b', 'c']),
    { model: 'a', models: ['a', 'b', 'c'] },
  );
});

test('normalizeProviderModels: default ∈ allowlist is kept; blanks dropped, dupes collapsed, order kept', () => {
  assert.deepEqual(
    normalizeProviderModels('b', ['a', ' b ', 'a', '', 'c']),
    { model: 'b', models: ['a', 'b', 'c'] },
  );
});
