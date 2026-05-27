/**
 * Tests for the JSON-config loader (0.3.9 follow-up).
 *
 * The loader reads three shipped files from `brainrouter-cli/config/`:
 *   - models.json
 *   - providers.json
 *   - api-key-prefixes.json
 *
 * It is sync, cached, and falls back to empty defaults on malformed JSON
 * (with a warning) so the runtime always boots.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  _resetConfigCache,
  loadApiKeyPrefixesConfig,
  loadModelsConfig,
  loadProvidersConfig,
} from '../runtime/configLoader.js';

test('configLoader: models.json loads with the expected built-in keys', () => {
  _resetConfigCache();
  const cfg = loadModelsConfig();
  // Sanity-check a handful of known entries.
  assert.ok(cfg.models['gpt-5'], 'gpt-5 must be a known model');
  assert.equal(cfg.models['gpt-5']?.contextWindow, 400_000);
  assert.equal(cfg.models['deepseek-v4-flash']?.contextWindow, 1_000_000);
  assert.equal(cfg.models['gpt-5']?.pricing?.inputCacheMiss, 1.25);
});

test('configLoader: models.json familyFallbacks compile to live RegExp objects', () => {
  _resetConfigCache();
  const cfg = loadModelsConfig();
  assert.ok(cfg.familyFallbacks.length >= 4, 'expected at least 4 family fallbacks shipped');
  for (const fb of cfg.familyFallbacks) {
    assert.ok(fb.pattern instanceof RegExp, `familyFallback ${fb.fallbackTo} should expose a compiled RegExp`);
    // The fallbackTo target MUST also exist in cfg.models, otherwise the
    // fallback would point at a phantom key.
    assert.ok(cfg.models[fb.fallbackTo], `familyFallback.fallbackTo=${fb.fallbackTo} must exist in models`);
  }
});

test('configLoader: providers.json includes picker-visible and ladder-only entries', () => {
  _resetConfigCache();
  const cfg = loadProvidersConfig();
  // OpenAI is picker-visible and has both fields + a tier ladder.
  const openai = cfg.providers['openai'];
  assert.ok(openai);
  assert.equal(openai!.pickerVisible, true);
  assert.equal(openai!.endpoint, 'https://api.openai.com/v1');
  assert.ok(openai!.tierLadder);

  // DeepSeek is picker-hidden but carries the ladder — that's by design.
  const deepseek = cfg.providers['deepseek'];
  assert.ok(deepseek);
  assert.equal(deepseek!.pickerVisible, false);
  assert.ok(deepseek!.tierLadder);
});

test('configLoader: api-key-prefixes.json carries both known and foreign lists', () => {
  _resetConfigCache();
  const cfg = loadApiKeyPrefixesConfig();
  assert.ok(cfg.known.length >= 4, 'expected at least 4 known prefixes shipped');
  assert.ok(cfg.foreignModelPrefixes.length >= 5, 'expected at least 5 foreign prefixes shipped');
  // sk-ant- was removed in 0.3.9 alongside the Anthropic-native adapter — it
  // must NOT be in the known list, otherwise we silently encourage Anthropic-
  // native usage that the rest of the codebase refuses.
  const knownPrefixStrings = cfg.known.map((e) => e.prefix);
  assert.equal(knownPrefixStrings.includes('sk-ant-'), false, 'sk-ant- should be gone from the known prefix list');
  // OpenRouter prefix must still be present.
  assert.ok(knownPrefixStrings.includes('sk-or-v1-'), 'sk-or-v1- must still be a known prefix');
});

test('configLoader: cache returns the same object across calls (cheap hot path)', () => {
  _resetConfigCache();
  const a = loadModelsConfig();
  const b = loadModelsConfig();
  assert.strictEqual(a, b, 'consecutive calls must hit the in-memory cache');
});

test('configLoader: _resetConfigCache drops the cache', () => {
  _resetConfigCache();
  const a = loadModelsConfig();
  _resetConfigCache();
  const b = loadModelsConfig();
  assert.notStrictEqual(a, b, 'after reset, the next load must produce a fresh object');
});
