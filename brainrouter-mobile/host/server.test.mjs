// Unit tests for the host's env -> LLMConfig override (lets `node server.mjs`
// target a local model without editing ~/.config/brainrouter/config.json).
//   Run:  npx tsx --test host/server.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { llmFromEnv } from './server.mjs';

test('llmFromEnv returns null unless BOTH endpoint and model are set', () => {
  assert.equal(llmFromEnv({}), null);
  assert.equal(llmFromEnv({ BRAINROUTER_LLM_ENDPOINT: 'http://localhost:9000/v1' }), null);
  assert.equal(llmFromEnv({ BRAINROUTER_LLM_MODEL: 'Qwen3.5-9B-Q4_K_M.gguf' }), null);
});

test('llmFromEnv builds an lmstudio config from endpoint + model', () => {
  assert.deepEqual(
    llmFromEnv({ BRAINROUTER_LLM_ENDPOINT: 'http://localhost:9000/v1', BRAINROUTER_LLM_MODEL: 'Qwen3.5-9B-Q4_K_M.gguf' }),
    { provider: 'lmstudio', model: 'Qwen3.5-9B-Q4_K_M.gguf', endpoint: 'http://localhost:9000/v1', apiKey: 'sk-local' },
  );
});

test('llmFromEnv honours explicit provider / api-key overrides', () => {
  const cfg = llmFromEnv({
    BRAINROUTER_LLM_ENDPOINT: 'http://localhost:1234/v1',
    BRAINROUTER_LLM_MODEL: 'm',
    BRAINROUTER_LLM_PROVIDER: 'openai',
    BRAINROUTER_LLM_API_KEY: 'sk-real',
  });
  assert.equal(cfg.provider, 'openai');
  assert.equal(cfg.apiKey, 'sk-real');
});
