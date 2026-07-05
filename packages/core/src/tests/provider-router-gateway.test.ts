import test from 'node:test';
import assert from 'node:assert/strict';
import type { Config } from '../config/config.js';
import type { RouterGatewayTransport } from '../router/gateway.js';
import { startRouterGateway } from '../router/gateway.js';

const config: Config = {
  activeServer: 's',
  servers: {},
  llm: { provider: 'openai', apiKey: 'base-key', model: 'gpt-5.3', endpoint: 'https://api.openai.com/v1' },
  providers: {
    groq: {
      provider: 'groq',
      apiKey: 'groq-key',
      model: 'llama-3.3-70b',
      endpoint: 'https://api.groq.com/openai/v1',
      cachedModels: ['llama-3.3-70b', 'shared-model'],
    },
    openrouter: {
      provider: 'openrouter',
      apiKey: 'or-key',
      model: 'openai/gpt-5.3',
      endpoint: 'https://openrouter.ai/api/v1',
      cachedModels: ['openai/gpt-5.3', 'shared-model'],
    },
  },
  cli: {
    router: {
      enabled: true,
      chain: ['groq/shared-model', 'openrouter/shared-model'],
      serve: true,
      serveKey: 'test-key',
    },
  },
};

async function withGateway(
  fn: (baseUrl: string) => Promise<void>,
  transport: RouterGatewayTransport = async () => ({ content: 'ok' }),
) {
  const handle = await startRouterGateway({
    config,
    host: '127.0.0.1',
    port: 0,
    serveKey: 'test-key',
    transport,
  });
  try {
    await fn(`http://${handle.host}:${handle.port}`);
  } finally {
    await handle.close();
  }
}

test('router gateway rejects missing bearer and lists aggregate models', async () => {
  await withGateway(async (baseUrl) => {
    const denied = await fetch(`${baseUrl}/router/v1/models`);
    assert.equal(denied.status, 401);
    const ok = await fetch(`${baseUrl}/router/v1/models`, { headers: { authorization: 'Bearer test-key' } });
    assert.equal(ok.status, 200);
    const body = await ok.json() as any;
    assert.equal(body.object, 'list');
    assert.ok(body.data.some((item: any) => item.id === 'groq/shared-model'));
  });
});

test('router gateway supports model list prefix modes and query filtering', async () => {
  await withGateway(async (baseUrl) => {
    const headers = { authorization: 'Bearer test-key' };
    // OpenAI /v1/models shape: { id, object:'model', created, owned_by }.
    const bare = await fetch(`${baseUrl}/router/v1/models?prefix=bare&q=shared`, { headers });
    assert.equal(bare.status, 200);
    const bareBody = await bare.json() as any;
    assert.equal(bareBody.object, 'list');
    assert.deepEqual(
      bareBody.data.map((item: any) => [item.id, item.object, item.owned_by]),
      [['shared-model', 'model', 'groq']],
    );
    assert.ok(bareBody.data.every((item: any) => typeof item.created === 'number'));

    const alias = await fetch(`${baseUrl}/router/v1/models?prefix=alias`, { headers });
    assert.equal(alias.status, 200);
    const aliasBody = await alias.json() as any;
    assert.deepEqual(aliasBody.data, []);

    // Drop-in OpenAI base_url: `/v1/models` (no /router prefix) works too.
    const v1 = await fetch(`${baseUrl}/v1/models`, { headers });
    assert.equal(v1.status, 200);
  });
});

test('router gateway resolves auto and falls back on first route failure', async () => {
  const seen: string[] = [];
  await withGateway(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/router/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.choices[0].message.content, 'from openrouter');
    assert.equal(body.model, 'shared-model');
    assert.deepEqual(seen, ['groq/shared-model', 'openrouter/shared-model']);
  }, async (llm) => {
    seen.push(`${llm.provider}/${llm.model}`);
    if (llm.provider === 'groq') {
      throw Object.assign(new Error('rate limited'), { status: 429 });
    }
    return { content: `from ${llm.provider}` };
  });
});

test('router gateway streams OpenAI SSE: role → content deltas → finish → usage → [DONE]', async () => {
  const handle = await startRouterGateway({
    config, host: '127.0.0.1', port: 0, serveKey: 'test-key',
    streamTransport: async (_llm, _messages, _tools, _options, handlers) => {
      handlers.onTextDelta?.('Hello');
      handlers.onTextDelta?.(' world');
      return { content: 'Hello world', usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } };
    },
  });
  try {
    const res = await fetch(`http://${handle.host}:${handle.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'auto', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const frames = (await res.text()).split('\n\n').map((f) => f.replace(/^data: /, '').trim()).filter(Boolean);
    assert.equal(frames.at(-1), '[DONE]');
    const chunks = frames.filter((f) => f !== '[DONE]').map((f) => JSON.parse(f));
    assert.ok(chunks.every((c) => c.object === 'chat.completion.chunk'));
    assert.equal(new Set(chunks.map((c) => c.id)).size, 1); // stable id across chunks
    assert.equal(chunks[0].choices[0].delta.role, 'assistant');
    assert.deepEqual(chunks.filter((c) => c.choices[0]?.delta?.content).map((c) => c.choices[0].delta.content), ['Hello', ' world']);
    assert.ok(chunks.some((c) => c.choices[0]?.finish_reason === 'stop'));
    const usageFrame = chunks.find((c) => c.choices.length === 0 && c.usage);
    assert.equal(usageFrame.usage.total_tokens, 5);
  } finally { await handle.close(); }
});

test('router gateway is keyless when no serveKey is configured', async () => {
  const handle = await startRouterGateway({ config, host: '127.0.0.1', port: 0, transport: async () => ({ content: 'ok' }) });
  try {
    const res = await fetch(`http://${handle.host}:${handle.port}/v1/models`); // no Authorization header
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.object, 'list');
  } finally { await handle.close(); }
});
