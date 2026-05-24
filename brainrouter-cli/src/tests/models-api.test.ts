import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveModelsUrl } from '../cli/wizard/modelsApi.js';

test('deriveModelsUrl: replaces /chat/completions with /models', () => {
  assert.equal(
    deriveModelsUrl('https://api.openai.com/v1/chat/completions'),
    'https://api.openai.com/v1/models',
  );
});

test('deriveModelsUrl: handles trailing slash', () => {
  assert.equal(
    deriveModelsUrl('https://api.openai.com/v1/chat/completions/'),
    'https://api.openai.com/v1/models',
  );
});

test('deriveModelsUrl: OpenRouter shape with /api/v1 prefix', () => {
  assert.equal(
    deriveModelsUrl('https://openrouter.ai/api/v1/chat/completions'),
    'https://openrouter.ai/api/v1/models',
  );
});

test('deriveModelsUrl: localhost shapes (LM Studio, Ollama)', () => {
  assert.equal(
    deriveModelsUrl('http://localhost:1234/v1/chat/completions'),
    'http://localhost:1234/v1/models',
  );
  assert.equal(
    deriveModelsUrl('http://localhost:11434/v1/chat/completions'),
    'http://localhost:11434/v1/models',
  );
});

test('deriveModelsUrl: endpoint without /chat/completions gets /models appended', () => {
  assert.equal(
    deriveModelsUrl('https://example.com/api'),
    'https://example.com/api/models',
  );
});
