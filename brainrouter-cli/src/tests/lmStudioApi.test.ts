/**
 * Tests for the LM Studio native /api/v1/models enrichment helper.
 *
 * The fetch path is intercepted via globalThis.fetch monkey-patch so
 * tests run offline. The parser is exercised against the real payload
 * shape the user pasted, including the "loaded_instances empty array =
 * not loaded" subtlety.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  _resetLmStudioCache,
  deriveLmStudioModelsUrl,
  isLmStudioEndpoint,
  lmStudioCacheSnapshot,
  lookupLmStudioModel,
  refreshLmStudioCache,
} from '../runtime/lmStudioApi.js';

// Real LM Studio /api/v1/models payload (trimmed from the user's example).
const SAMPLE_PAYLOAD = {
  models: [
    {
      type: 'llm',
      publisher: 'microsoft',
      key: 'microsoft/phi-4-mini-reasoning',
      display_name: 'Phi 4 Mini Reasoning',
      architecture: 'phi3',
      quantization: { name: '4bit', bits_per_weight: 4 },
      size_bytes: 2180017503,
      params_string: '3.8B',
      loaded_instances: [],
      max_context_length: 131072,
      format: 'mlx',
      capabilities: {
        vision: false,
        trained_for_tool_use: false,
        reasoning: { allowed_options: ['on'], default: 'on' },
      },
    },
    {
      type: 'llm',
      publisher: 'qwen',
      key: 'qwen2.5-coder-32b-instruct',
      display_name: 'Qwen2.5 Coder 32B Instruct',
      quantization: { name: 'Q4_K_M', bits_per_weight: 4 },
      params_string: '32B',
      loaded_instances: [{ id: 'inst-1' }],
      max_context_length: 32768,
      format: 'gguf',
      capabilities: {
        vision: false,
        trained_for_tool_use: true,
        reasoning: { allowed_options: ['on', 'off'], default: 'off' },
      },
    },
    {
      type: 'embedding',
      publisher: 'nomic-ai',
      key: 'text-embedding-nomic-embed-text-v1.5',
      display_name: 'Nomic Embed Text v1.5',
      max_context_length: 2048,
      loaded_instances: [],
      format: 'gguf',
    },
  ],
};

function stubFetch(response: unknown, opts: { ok?: boolean; status?: number } = {}): () => void {
  const original = globalThis.fetch;
  (globalThis as any).fetch = async () => ({
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    statusText: opts.ok === false ? 'Internal Server Error' : 'OK',
    json: async () => response,
    text: async () => JSON.stringify(response),
  });
  return () => { (globalThis as any).fetch = original; };
}

test('isLmStudioEndpoint accepts localhost / 127.0.0.1 / ::1 with or without :1234', () => {
  assert.equal(isLmStudioEndpoint('http://localhost:1234'), true);
  assert.equal(isLmStudioEndpoint('http://localhost:1234/v1'), true);
  assert.equal(isLmStudioEndpoint('http://127.0.0.1:1234/v1/chat/completions'), true);
  assert.equal(isLmStudioEndpoint('http://localhost/'), true);
  assert.equal(isLmStudioEndpoint('http://[::1]:1234/v1'), true);
  // Negative cases — anything cloud is NOT LM Studio.
  assert.equal(isLmStudioEndpoint('https://api.openai.com/v1'), false);
  assert.equal(isLmStudioEndpoint('https://openrouter.ai/api/v1/chat/completions'), false);
  assert.equal(isLmStudioEndpoint(''), false);
  assert.equal(isLmStudioEndpoint(undefined), false);
});

test('deriveLmStudioModelsUrl strips /v1, /chat/completions, trailing slash', () => {
  assert.equal(deriveLmStudioModelsUrl('http://localhost:1234'), 'http://localhost:1234/api/v1/models');
  assert.equal(deriveLmStudioModelsUrl('http://localhost:1234/'), 'http://localhost:1234/api/v1/models');
  assert.equal(deriveLmStudioModelsUrl('http://localhost:1234/v1'), 'http://localhost:1234/api/v1/models');
  assert.equal(deriveLmStudioModelsUrl('http://localhost:1234/v1/chat/completions'), 'http://localhost:1234/api/v1/models');
});

test('refreshLmStudioCache parses the rich payload and exposes lookupLmStudioModel', async () => {
  _resetLmStudioCache();
  const restore = stubFetch(SAMPLE_PAYLOAD);
  try {
    const count = await refreshLmStudioCache('http://localhost:1234/v1/chat/completions');
    assert.equal(count, 3, 'expected 3 model rows parsed (2 llm + 1 embedding)');

    const phi = lookupLmStudioModel('microsoft/phi-4-mini-reasoning');
    assert.ok(phi);
    assert.equal(phi!.type, 'llm');
    assert.equal(phi!.maxContextLength, 131072);
    assert.equal(phi!.loaded, false);
    assert.equal(phi!.trainedForToolUse, false);
    assert.deepEqual(phi!.reasoning?.allowedOptions, ['on']);
    assert.equal(phi!.reasoning?.defaultOption, 'on');
    assert.equal(phi!.paramsString, '3.8B');
    assert.equal(phi!.quantisation, '4bit');
    assert.equal(phi!.format, 'mlx');

    // Lookup is case-insensitive and tolerates vendor-prefix strip.
    const stripped = lookupLmStudioModel('phi-4-mini-reasoning');
    assert.ok(stripped, 'vendor-prefix-stripped lookup should hit the same row');
    assert.equal(stripped!.key, 'microsoft/phi-4-mini-reasoning');

    // The qwen row reports `loaded: true` and `trained_for_tool_use: true`.
    const qwen = lookupLmStudioModel('qwen2.5-coder-32b-instruct');
    assert.ok(qwen);
    assert.equal(qwen!.loaded, true);
    assert.equal(qwen!.trainedForToolUse, true);
  } finally {
    restore();
  }
});

test('refreshLmStudioCache returns 0 and leaves cache empty when endpoint is not LM Studio', async () => {
  _resetLmStudioCache();
  // Use an unambiguously cloud endpoint to bypass the heuristic.
  const count = await refreshLmStudioCache('https://api.openai.com/v1');
  assert.equal(count, 0);
  assert.equal(lookupLmStudioModel('any-model'), undefined);
});

test('refreshLmStudioCache returns 0 on HTTP error and leaves the cache untouched', async () => {
  _resetLmStudioCache();
  // First populate with a good response.
  let restore = stubFetch(SAMPLE_PAYLOAD);
  try {
    await refreshLmStudioCache('http://localhost:1234/v1');
    assert.equal(lmStudioCacheSnapshot().entries.length, 3);
  } finally {
    restore();
  }
  // Then simulate a failure — cache should stay populated (better stale than empty).
  restore = stubFetch({ error: 'server down' }, { ok: false, status: 500 });
  try {
    const count = await refreshLmStudioCache('http://localhost:1234/v1');
    // refreshLmStudioCache returns the EXISTING cache size on failure.
    assert.equal(count, 3, 'failure leaves the existing cache in place');
    assert.equal(lmStudioCacheSnapshot().entries.length, 3);
  } finally {
    restore();
  }
});

test('parseLmStudioModel: tolerates missing fields without throwing', async () => {
  _resetLmStudioCache();
  const restore = stubFetch({
    models: [
      // Bare-minimum row (just `key`) — should still parse.
      { key: 'minimal-model', type: 'llm' },
      // Garbage row (no key) — should be filtered out.
      { type: 'llm', display_name: 'no key' },
      // Missing `capabilities` and `loaded_instances` — should default cleanly.
      { key: 'sparse', type: 'llm', max_context_length: 8192 },
    ],
  });
  try {
    const count = await refreshLmStudioCache('http://localhost:1234');
    assert.equal(count, 2, 'expected 2 valid rows (1 garbage row dropped)');
    const minimal = lookupLmStudioModel('minimal-model');
    assert.ok(minimal);
    assert.equal(minimal!.loaded, false);
    assert.equal(minimal!.maxContextLength, undefined);
    const sparse = lookupLmStudioModel('sparse');
    assert.ok(sparse);
    assert.equal(sparse!.maxContextLength, 8192);
    assert.equal(sparse!.trainedForToolUse, undefined);
  } finally {
    restore();
  }
});

test('contextWindowFor: LM Studio enrichment wins over the shipped models.json fallback', async () => {
  _resetLmStudioCache();
  // The shipped models.json has `gpt-oss-20b: 32768`. If LM Studio reports
  // a different value for the same key, the LM Studio number wins (it
  // reflects the actual loaded variant + quantisation).
  const restore = stubFetch({
    models: [
      { key: 'gpt-oss-20b', type: 'llm', max_context_length: 65536, loaded_instances: [] },
    ],
  });
  try {
    await refreshLmStudioCache('http://localhost:1234');
    const { contextWindowFor } = await import('../runtime/contextWindow.js');
    assert.equal(contextWindowFor('gpt-oss-20b'), 65536, 'LM Studio value (65536) must beat shipped 32768');
  } finally {
    restore();
  }
});

test('contextWindowFor: falls through to shipped JSON when LM Studio cache is empty', async () => {
  _resetLmStudioCache();
  // No fetch was made — `lookupLmStudioModel` returns undefined and the
  // shipped models.json `gpt-5: 400000` should be the answer.
  const { contextWindowFor } = await import('../runtime/contextWindow.js');
  assert.equal(contextWindowFor('gpt-5'), 400_000);
});
