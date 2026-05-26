import test from 'node:test';
import assert from 'node:assert/strict';
import { backfillApiKeyFromEnv } from '../config/config.js';

// Snapshots + restores process.env between cases so a test doesn't
// leak state into others. Provider-specific env vars are normally
// undefined; we set them explicitly per case.
function withEnv<T>(patch: Record<string, string | undefined>, body: () => T): T {
  const original: Record<string, string | undefined> = {};
  for (const k of Object.keys(patch)) {
    original[k] = process.env[k];
    if (patch[k] === undefined) delete process.env[k];
    else process.env[k] = patch[k];
  }
  try {
    return body();
  } finally {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('backfillApiKeyFromEnv: DeepSeek endpoint → DEEPSEEK_API_KEY wins over OPENAI_API_KEY', () => {
  const out = withEnv({
    DEEPSEEK_API_KEY: 'dsk-1234567890123456',
    OPENAI_API_KEY:   'sk-aaaaaaaaaaaaaaaa',
    BRAINROUTER_LLM_API_KEY: undefined,
  }, () => backfillApiKeyFromEnv('https://api.deepseek.com/v1'));
  assert.equal(out, 'dsk-1234567890123456');
});

test('backfillApiKeyFromEnv: OpenRouter endpoint → OPENROUTER_API_KEY wins', () => {
  const out = withEnv({
    OPENROUTER_API_KEY: 'sk-or-v1-aaaaaaaaaaa',
    OPENAI_API_KEY:     'sk-bbbbbbbbbbbbbbbb',
  }, () => backfillApiKeyFromEnv('https://openrouter.ai/api/v1'));
  assert.equal(out, 'sk-or-v1-aaaaaaaaaaa');
});

test('backfillApiKeyFromEnv: Gemini endpoint → GEMINI_API_KEY', () => {
  const out = withEnv({
    GEMINI_API_KEY: 'AIzaXXXXXXXXXXXXXXXXX',
  }, () => backfillApiKeyFromEnv('https://generativelanguage.googleapis.com/v1beta/openai'));
  assert.equal(out, 'AIzaXXXXXXXXXXXXXXXXX');
});

test('backfillApiKeyFromEnv: LM Studio endpoint → LMSTUDIO_API_KEY', () => {
  const out = withEnv({
    LMSTUDIO_API_KEY: 'lm-studio-local',
  }, () => backfillApiKeyFromEnv('http://localhost:1234/v1'));
  assert.equal(out, 'lm-studio-local');
});

test('backfillApiKeyFromEnv: trailing slash on endpoint still matches', () => {
  const out = withEnv({
    DEEPSEEK_API_KEY: 'dsk-aaaaaaaaaaaaaaaa',
  }, () => backfillApiKeyFromEnv('https://api.deepseek.com/v1/'));
  assert.equal(out, 'dsk-aaaaaaaaaaaaaaaa');
});

test('backfillApiKeyFromEnv: unknown endpoint falls through to OPENAI_API_KEY', () => {
  const out = withEnv({
    OPENAI_API_KEY: 'sk-fallback-aaaaaaaaa',
    DEEPSEEK_API_KEY: undefined,
    OPENROUTER_API_KEY: undefined,
  }, () => backfillApiKeyFromEnv('https://custom.example.com/v1'));
  assert.equal(out, 'sk-fallback-aaaaaaaaa');
});

test('backfillApiKeyFromEnv: nothing set anywhere → undefined', () => {
  const out = withEnv({
    OPENAI_API_KEY: undefined,
    DEEPSEEK_API_KEY: undefined,
    OPENROUTER_API_KEY: undefined,
    GEMINI_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined,
    BRAINROUTER_LLM_API_KEY: undefined,
    LMSTUDIO_API_KEY: undefined,
    OLLAMA_API_KEY: undefined,
  }, () => backfillApiKeyFromEnv('https://api.openai.com/v1'));
  assert.equal(out, undefined);
});

test('backfillApiKeyFromEnv: provider-specific key wins even if BRAINROUTER_LLM_API_KEY is set', () => {
  const out = withEnv({
    DEEPSEEK_API_KEY: 'dsk-real-deepseek-key',
    BRAINROUTER_LLM_API_KEY: 'should-not-win',
    OPENAI_API_KEY: undefined,
  }, () => backfillApiKeyFromEnv('https://api.deepseek.com/v1'));
  assert.equal(out, 'dsk-real-deepseek-key');
});

test('backfillApiKeyFromEnv: empty endpoint → generic fallback only', () => {
  const out = withEnv({
    OPENAI_API_KEY: 'sk-generic-fallback-key',
    DEEPSEEK_API_KEY: 'should-not-win',
  }, () => backfillApiKeyFromEnv(undefined));
  assert.equal(out, 'sk-generic-fallback-key');
});

test('backfillApiKeyFromEnv: whitespace-only env values are ignored', () => {
  const out = withEnv({
    DEEPSEEK_API_KEY: '   ',
    OPENAI_API_KEY: 'sk-real-key-here',
  }, () => backfillApiKeyFromEnv('https://api.deepseek.com/v1'));
  // Whitespace DEEPSEEK is rejected; falls through to OPENAI generic.
  assert.equal(out, 'sk-real-key-here');
});
