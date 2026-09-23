import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Config } from '../config/config.js';
import type { RouterGatewayTransport } from '../provider/routing/gateway.js';
import { startRouterGateway } from '../provider/routing/gateway.js';
import { resetRouterPolicyForTests } from '../provider/routing/policy.js';

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

test('router gateway projects the shared recovery receipt without provider secrets', async () => {
  resetRouterPolicyForTests();
  const receipts: unknown[] = [];
  const handle = await startRouterGateway({
    config,
    host: '127.0.0.1',
    port: 0,
    onRecoveryReceipt: (receipt) => receipts.push(receipt),
    transport: async (llm) => {
      if (llm.provider === 'groq') {
        throw Object.assign(new Error('rate limited'), { status: 429 });
      }
      return { content: 'ok' };
    },
  });
  try {
    const res = await fetch(`http://${handle.host}:${handle.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    assert.equal(receipts.length, 1);
    assert.deepEqual(
      (receipts[0] as any).attempts.map((attempt: any) => [attempt.route.slug, attempt.outcome]),
      [
        ['groq/shared-model', 'failed'],
        ['openrouter/shared-model', 'succeeded'],
      ],
    );
    assert.doesNotMatch(JSON.stringify(receipts[0]), /groq-key|or-key|base-key/);
  } finally {
    await handle.close();
  }
});

test('router gateway streams OpenAI SSE: role → content deltas → finish → usage → [DONE]', async () => {
  const handle = await startRouterGateway({
    config, host: '127.0.0.1', port: 0, serveKey: 'test-key',
    streamTransport: async function* (_llm, _messages, _tools, _options) {
      yield { type: 'text', delta: 'Hello' };
      yield { type: 'text', delta: ' world' };
      yield { type: 'done', result: { content: 'Hello world', usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } } };
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

test('router gateway streaming falls back before output and records one recovery receipt', async () => {
  resetRouterPolicyForTests();
  const seen: string[] = [];
  const receipts: any[] = [];
  const handle = await startRouterGateway({
    config,
    host: '127.0.0.1',
    port: 0,
    onRecoveryReceipt: (receipt) => receipts.push(receipt),
    streamTransport: async function* (llm, _messages, _tools, _options) {
      seen.push(`${llm.provider}/${llm.model}`);
      if (llm.provider === 'groq') {
        throw Object.assign(new Error('rate limited before output'), { status: 429 });
      }
      yield { type: 'text', delta: 'fallback answer' };
      yield { type: 'done', result: { content: 'fallback answer' } };
    },
  });
  try {
    const res = await fetch(`http://${handle.host}:${handle.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /fallback answer/);
    assert.deepEqual(seen, ['groq/shared-model', 'openrouter/shared-model']);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].outcome, 'succeeded');
    assert.deepEqual(
      receipts[0].attempts.map((attempt: any) => [attempt.route.slug, attempt.outcome]),
      [
        ['groq/shared-model', 'failed'],
        ['openrouter/shared-model', 'succeeded'],
      ],
    );
  } finally {
    await handle.close();
  }
});

test('router gateway streaming never changes route after output has started', async () => {
  resetRouterPolicyForTests();
  const seen: string[] = [];
  const receipts: any[] = [];
  const handle = await startRouterGateway({
    config,
    host: '127.0.0.1',
    port: 0,
    onRecoveryReceipt: (receipt) => receipts.push(receipt),
    streamTransport: async function* (llm, _messages, _tools, _options) {
      seen.push(`${llm.provider}/${llm.model}`);
      yield { type: 'text', delta: 'partial answer' };
      throw Object.assign(new Error('connection closed after output'), { status: 503 });
    },
  });
  try {
    const res = await fetch(`http://${handle.host}:${handle.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /partial answer/);
    assert.match(text, /data: \[DONE\]/);
    assert.deepEqual(seen, ['groq/shared-model']);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].outcome, 'failed');
    assert.equal(receipts[0].attempts.length, 1);
    assert.equal(receipts[0].attempts[0].failure.kind, 'non_retryable');
  } finally {
    await handle.close();
  }
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

// ---------------------------------------------------------------------------
// ADR-061 D3.3 — the route choice, at the only place `auto` is a live request.
// ---------------------------------------------------------------------------

test('auto on the default rules provider starts on the configured head, and decides nothing', async () => {
  const seen: string[] = [];
  const decisions: unknown[] = [];
  const handle = await startRouterGateway({
    config,
    host: '127.0.0.1',
    port: 0,
    transport: async (llm) => { seen.push(`${llm.provider}/${llm.model}`); return { content: 'ok' }; },
    onRouteDecision: (entry) => { decisions.push(entry); },
  });
  try {
    const res = await fetch(`http://${handle.host}:${handle.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ['groq/shared-model'], 'the chain head, exactly as before the tier existed');
    assert.deepEqual(decisions, [], 'on `rules` the head IS the answer; a line per request would say nothing');
  } finally { await handle.close(); }
});

test('a configured provider that cannot be built keeps the chain and says why', async () => {
  // The knobs come from the gateway's OWN config, not the ambient session's —
  // a decision that disagreed with the router it decides for would be worse
  // than no decision at all.
  const seen: string[] = [];
  const decisions: any[] = [];
  const handle = await startRouterGateway({
    config: { ...config, cli: { ...config.cli, decisions: { provider: 'local' } } },
    host: '127.0.0.1',
    port: 0,
    transport: async (llm) => { seen.push(`${llm.provider}/${llm.model}`); return { content: 'ok' }; },
    onRouteDecision: (entry) => { decisions.push(entry); },
  });
  try {
    const res = await fetch(`http://${handle.host}:${handle.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ['groq/shared-model'], 'a tier that is down must not change which model answers');
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].consumer, 'route');
    assert.equal(decisions[0].value, 'groq/shared-model');
    assert.equal(decisions[0].outcome, 'kept the configured head');
    assert.match(decisions[0].fellBack, /cli\.decisions\.local\.model/);
  } finally { await handle.close(); }
});

test('an explicit model never reaches the route choice', async () => {
  const decisions: unknown[] = [];
  const handle = await startRouterGateway({
    config: { ...config, cli: { ...config.cli, decisions: { provider: 'local' } } },
    host: '127.0.0.1',
    port: 0,
    transport: async () => ({ content: 'ok' }),
    onRouteDecision: (entry) => { decisions.push(entry); },
  });
  try {
    const res = await fetch(`http://${handle.host}:${handle.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'groq/shared-model', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(decisions, [], "an explicit pick is the caller's, and ADR-041's contract stands");
  } finally { await handle.close(); }
});

// ---------------------------------------------------------------------------
// Every test above injects `transport`, which is precisely why none of them
// could see that the gateway was destroying client tool definitions. The
// conversion bug lives BETWEEN the gateway and `callOpenAI`, so the only test
// that can catch it is one that uses the real transport and reads the bytes an
// upstream provider actually receives.
// ---------------------------------------------------------------------------

async function withUpstream(fn: (baseUrl: string, seen: () => any) => Promise<void>) {
  let received: any;
  const origin = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      received = JSON.parse(raw);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'x', object: 'chat.completion', created: 1, model: 'm',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
      }));
    });
  });
  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', () => resolve()));
  const upstreamPort = (origin.address() as { port: number }).port;
  const endpoint = `http://127.0.0.1:${upstreamPort}/v1`;
  // No `transport` override: this must go through the real callOpenAI.
  const handle = await startRouterGateway({
    config: {
      activeServer: 's', servers: {},
      llm: { provider: 'openai', apiKey: 'k', model: 'm', endpoint },
      providers: { up: { provider: 'openai', apiKey: 'k', model: 'm', endpoint, cachedModels: ['m'] } },
      cli: { router: { enabled: true, chain: ['up/m'], serve: true } },
    } as unknown as Config,
    host: '127.0.0.1',
    port: 0,
  });
  try {
    await fn(`http://${handle.host}:${handle.port}`, () => received);
  } finally {
    await handle.close();
    await new Promise<void>((resolve) => origin.close(() => resolve()));
  }
}

test('a client\'s tool definitions reach the upstream intact', async () => {
  await withUpstream(async (baseUrl, seen) => {
    const parameters = {
      type: 'object',
      properties: { city: { type: 'string' }, unit: { type: 'string', enum: ['c', 'f'] } },
      required: ['city'],
    };
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'auto',
        messages: [{ role: 'user', content: 'weather?' }],
        tools: [{ type: 'function', function: { name: 'get_weather', description: 'Look up the weather', parameters } }],
        tool_choice: { type: 'function', function: { name: 'get_weather' } },
      }),
    });
    assert.equal(res.status, 200);
    const sent = seen();
    // The whole point: a NAME (or `tool_choice` names a tool that isn't there)
    // and the SCHEMA (or the model is asked to fill `{}`).
    assert.equal(sent.tools[0].function.name, 'get_weather');
    assert.equal(sent.tools[0].function.description, 'Look up the weather');
    assert.deepEqual(sent.tools[0].function.parameters, parameters);
    assert.deepEqual(sent.tool_choice, { type: 'function', function: { name: 'get_weather' } });
  });
});

test('a malformed tool is dropped rather than forwarded blank', async () => {
  await withUpstream(async (baseUrl, seen) => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'auto',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          { type: 'function', function: { description: 'no name at all' } },
          { type: 'function', function: { name: '   ' } },
          null,
          { type: 'function', function: { name: 'real_one' } },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const sent = seen();
    assert.equal(sent.tools.length, 1, 'a blank tool IS the bug; forwarding one would reintroduce it');
    assert.equal(sent.tools[0].function.name, 'real_one');
    assert.deepEqual(sent.tools[0].function.parameters, { type: 'object', properties: {} },
      'a tool with no parameters still gets a valid empty schema');
  });
});

test('a request with no tools sends no tools key at all', async () => {
  await withUpstream(async (baseUrl, seen) => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    assert.equal(seen().tools, undefined, 'an empty tools array must not become `tools: []`');
  });
});
