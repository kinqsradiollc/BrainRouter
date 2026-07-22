import test from 'node:test';
import assert from 'node:assert/strict';
import { callOpenAI } from '../agent/transport/llmTransport.js';

const LOCAL_LLM = {
  provider: 'lmstudio',
  apiKey: '',
  model: 'local-test-model',
  endpoint: 'http://127.0.0.1:1234/v1',
} as const;

test('bounded LLM calls reject an oversized response while reading the body', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ choices: [{ message: { content: 'x'.repeat(256) } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
  try {
    await assert.rejects(
      callOpenAI(LOCAL_LLM, [{ role: 'user', content: 'classify' }], [], {
        maxResponseBytes: 64,
      }),
      /response exceeded the 64-byte limit/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('single-call mode does not retry a provider that rejects forced tools', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: 'tools are not supported' } }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    await assert.rejects(
      callOpenAI(
        LOCAL_LLM,
        [{ role: 'user', content: 'classify' }],
        [{ name: 'classify', description: '', inputSchema: { type: 'object', properties: {} } }],
        {
          tool_choice: { type: 'function', function: { name: 'classify' } },
          allowCompatibilityRetry: false,
          maxResponseBytes: 4 * 1024,
        },
      ),
      /OpenAI API error: 400/,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
