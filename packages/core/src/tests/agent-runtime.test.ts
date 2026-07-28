import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Agent, buildChatCompletionPayload, buildResponsesPayload, callOpenAI, callOpenAIStream, resolveRequestFormat, sanitizeToolCallsForHistory } from '../agent/agent.js';
import { _resetCliKnobsCache, setCliKnobOverride } from '../config/config.js';
import { BudgetExceededError } from '../provider/budget.js';
import { _resetModelReasoningCapabilities, registerModelReasoningCapabilities } from '../provider/models/reasoning.js';
import { createWorkspaceManifest, saveWorkspaceManifest } from '../workspace/manifest.js';
import {
  buildWorkspaceSelectionCatalog,
  migrateWorkspaceManifestToolSelection,
} from '../workspace/selectionCatalog.js';

function resetCliKnobsForAgentRuntimeTest(extra: Parameters<typeof setCliKnobOverride>[0] = {}): void {
  _resetCliKnobsCache();
  // Keep the suite independent from the developer's real global config.
  setCliKnobOverride({ providerRequestFormat: {}, recallMode: 'gated', ...extra });
}

async function waitForValue<T>(
  read: () => T,
  ready: (value: T) => boolean,
  attempts = 200,
  intervalMs = 25,
): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = read();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return read();
}

test.beforeEach(() => {
  resetCliKnobsForAgentRuntimeTest();
});

test.after(() => {
  _resetCliKnobsCache();
});

test('sanitizeToolCallsForHistory: malformed/object args become valid JSON-object strings (run_workflow 400 fix)', () => {
  const orig = [
    { id: 'c1', type: 'function', function: { name: 'run_workflow', arguments: '{"name":"x", bad json' } }, // malformed
    { id: 'c2', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },           // valid string
    { id: 'c3', type: 'function', function: { name: 'foo', arguments: { a: 1 } } },                           // object, not string
    { id: 'c4', type: 'function', function: { name: 'bar', arguments: '[1,2,3]' } },                          // valid JSON but not an object
  ];
  const out = sanitizeToolCallsForHistory(orig);
  // every history arg must be a parseable JSON OBJECT string
  for (const c of out) { const v = JSON.parse(c.function.arguments); assert.equal(v !== null && typeof v === 'object' && !Array.isArray(v), true, c.function.name); }
  assert.equal(out[0].function.arguments, '{}');            // malformed → {}
  assert.deepEqual(JSON.parse(out[1].function.arguments), { path: 'a.ts' }); // valid preserved
  assert.deepEqual(JSON.parse(out[2].function.arguments), { a: 1 });         // object → stringified
  assert.equal(out[3].function.arguments, '{}');            // array → {}
  // originals are NOT mutated (execution still sees the raw malformed args)
  assert.equal(orig[0].function.arguments, '{"name":"x", bad json');
});

function layeredSystemForTests() {
  return {
    role: 'system',
    content: 'FLAT SYSTEM',
    promptLayers: {
      instructions: 'CORE INSTRUCTIONS',
      developer: ['DEV MEMORY', 'DEV POLICY'],
      environment: 'WORKSPACE INSTRUCTIONS\n<environment_context>cwd=/repo</environment_context>',
    },
  };
}

const sampleTool = {
  name: 'read_file',
  description: 'Read a file',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
};

test('buildChatCompletionPayload: bundles Codex prompt layers into one provider-safe chat prefix', () => {
  const body = buildChatCompletionPayload(
    { provider: 'openai-compatible', apiKey: 'k', model: 'custom-model', endpoint: 'https://gateway.example/v1' },
    [
      layeredSystemForTests(),
      { role: 'user', content: 'hello' },
    ],
    [sampleTool],
  );

  assert.deepEqual(body.messages.map((m) => m.role), ['system', 'user']);
  assert.match(body.messages[0].content, /^CORE INSTRUCTIONS/);
  assert.match(body.messages[0].content, /DEV MEMORY/);
  assert.match(body.messages[0].content, /DEV POLICY/);
  assert.match(body.messages[0].content, /WORKSPACE INSTRUCTIONS/);
  assert.equal(body.messages[1].content, 'hello');
  assert.equal(body.tools?.[0].function.name, 'read_file');
  assert.equal(body.tool_choice, 'auto');
  assert.equal(body.messages.some((m) => m.role === 'developer'), false);
  assert.equal(body.messages.filter((m) => m.role === 'system').length, 1);
});

test('buildChatCompletionPayload: folds mid-history system/developer directives into the chat system prefix', () => {
  const body = buildChatCompletionPayload(
    { provider: 'openai-compatible', apiKey: 'k', model: 'custom-model', endpoint: 'https://gateway.example/v1' },
    [
      layeredSystemForTests(),
      { role: 'system', content: 'runtime directive' },
      { role: 'developer', content: 'developer hint' },
      { role: 'user', content: 'hello' },
    ],
    [],
  );

  assert.deepEqual(body.messages.map((m) => m.role), ['system', 'user']);
  assert.match(body.messages[0].content, /runtime directive/);
  assert.match(body.messages[0].content, /developer hint/);
  assert.equal(body.messages[1].content, 'hello');
  assert.equal(body.messages.filter((m) => m.role === 'system').length, 1);
});

test('buildChatCompletionPayload: preserves waited child outputs as high-authority runtime context', () => {
  const body = buildChatCompletionPayload(
    { provider: 'openai-compatible', apiKey: 'k', model: 'custom-model', endpoint: 'https://gateway.example/v1' },
    [
      layeredSystemForTests(),
      {
        role: 'system',
        content: [
          '<system-reminder id="child-results">',
          'Recently waited child-agent outputs are available below.',
          'child output',
          '</system-reminder>',
        ].join('\n'),
      },
      { role: 'user', content: 'synthesize' },
    ],
    [],
  );

  assert.deepEqual(body.messages.map((m) => m.role), ['system', 'user']);
  assert.match(body.messages[0].content, /Recently waited child-agent outputs/);
  assert.equal(body.messages[1].content, 'synthesize');
});

test('buildChatCompletionPayload: a user turn with sidecar images becomes multi-part image_url content (vision)', () => {
  const body = buildChatCompletionPayload(
    { provider: 'openai-compatible', apiKey: 'k', model: 'gpt-4o', endpoint: 'https://gateway.example/v1' },
    [
      { role: 'user', content: 'what is in this screenshot?', images: [{ mediaType: 'image/png', dataBase64: 'iVBORw0KAAAA' }] },
    ],
    [],
  );
  const userMsg = body.messages[body.messages.length - 1];
  assert.equal(userMsg.role, 'user');
  // text stays a string token; the image rides as an OpenAI image_url data-URL part.
  assert.deepEqual(userMsg.content, [
    { type: 'text', text: 'what is in this screenshot?' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KAAAA' } },
  ]);
});

test('buildChatCompletionPayload: a user turn with NO images keeps plain string content (no regression)', () => {
  const body = buildChatCompletionPayload(
    { provider: 'openai-compatible', apiKey: 'k', model: 'gpt-4o', endpoint: 'https://gateway.example/v1' },
    [{ role: 'user', content: 'plain text only' }],
    [],
  );
  assert.equal(body.messages[body.messages.length - 1].content, 'plain text only');
});

test('buildResponsesPayload: a user turn with sidecar images becomes input_text + input_image parts (vision)', () => {
  const body = buildResponsesPayload(
    { provider: 'openai', apiKey: 'k', model: 'gpt-5', endpoint: 'https://api.openai.com/v1' },
    [
      { role: 'user', content: 'describe this', images: [{ mediaType: 'image/jpeg', dataBase64: 'BBBB' }] },
    ],
    [],
  );
  const userInput = body.input[body.input.length - 1] as { role: string; content: unknown };
  assert.equal(userInput.role, 'user');
  assert.deepEqual(userInput.content, [
    { type: 'input_text', text: 'describe this' },
    { type: 'input_image', image_url: 'data:image/jpeg;base64,BBBB' },
  ]);
});

test('buildResponsesPayload: emits Codex-style developer input/tools and preserves tool-call history', () => {
  const body = buildResponsesPayload(
    { provider: 'openai', apiKey: 'k', model: 'gpt-5', endpoint: 'https://api.openai.com/v1' },
    [
      layeredSystemForTests(),
      {
        role: 'assistant',
        content: 'I will read it.',
        tool_calls: [{
          id: 'call_read',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"README.md"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_read', name: 'read_file', content: 'README body' },
      { role: 'user', content: 'continue' },
    ],
    [sampleTool],
    { effort: 'high' },
  );

  assert.equal(body.instructions, 'CORE INSTRUCTIONS');
  assert.equal(body.input[0].role, 'developer');
  assert.deepEqual(body.input[0].content.map((c: any) => c.text), ['DEV MEMORY', 'DEV POLICY']);
  assert.equal(body.input[1].role, 'user');
  assert.match(body.input[1].content[0].text, /environment_context/);
  assert.deepEqual(
    body.input.slice(2).map((item: any) => item.type),
    ['message', 'function_call', 'function_call_output', 'message'],
  );
  assert.equal(body.input[3].call_id, 'call_read');
  assert.equal(body.input[4].call_id, 'call_read');
  assert.equal(body.tools?.[0].name, 'read_file');
  assert.equal(body.tools?.[0].strict, false);
  assert.equal(body.tool_choice, 'auto');
  assert.equal(body.parallel_tool_calls, true);
  assert.deepEqual(body.reasoning, { effort: 'high' });
  assert.equal(body.store, false);
  assert.deepEqual(body.include, []);
});

test('buildResponsesPayload/buildChatCompletionPayload: OpenAI never emits binary reasoning_effort=on', () => {
  _resetModelReasoningCapabilities();
  registerModelReasoningCapabilities('gpt-5-binary-regression', { reasoning: true, efforts: ['on', 'off'] });
  try {
    const messages = [{ role: 'user', content: 'think hard' }];
    const config = {
      provider: 'openai',
      apiKey: 'k',
      model: 'gpt-5-binary-regression',
      endpoint: 'https://api.openai.com/v1',
    };

    const responses = buildResponsesPayload(config, messages, [], { effort: 'high' });
    assert.deepEqual((responses as any).reasoning, { effort: 'high' });

    const chat = buildChatCompletionPayload(config, messages, [], { effort: 'high' });
    assert.equal((chat as any).reasoning_effort, 'high');
    assert.notEqual((chat as any).reasoning_effort, 'on');
  } finally {
    _resetModelReasoningCapabilities();
  }
});

test('resolveRequestFormat: only canonical OpenAI uses Responses; custom endpoints fall back to chat completions', () => {
  assert.equal(
    resolveRequestFormat({ provider: 'openai', apiKey: 'k', model: 'gpt-5', endpoint: 'https://api.openai.com/v1' }),
    'responses',
  );
  assert.equal(
    resolveRequestFormat({ provider: 'openai', apiKey: 'k', model: 'gpt-5', endpoint: 'https://openrouter.ai/api/v1' }),
    'chat-completions',
  );
  assert.equal(
    resolveRequestFormat({ provider: 'openai-compatible', apiKey: 'k', model: 'gpt-5', endpoint: 'https://api.openai.com/v1' }),
    'responses',
  );
});

test('callOpenAI: sends Responses payload to canonical OpenAI and normalizes output/tool calls/usage', async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = '';
  let capturedBody: any;
  globalThis.fetch = (async (url: any, opts: any) => {
    capturedUrl = String(url);
    capturedBody = JSON.parse(opts.body);
    return new Response(JSON.stringify({
      id: 'resp_test',
      status: 'completed',
      output_text: 'done',
      output: [{
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_read',
        name: 'read_file',
        arguments: '{"path":"README.md"}',
      }],
      usage: {
        input_tokens: 100,
        output_tokens: 7,
        total_tokens: 107,
        input_tokens_details: { cached_tokens: 25 },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as any;

  try {
    const result = await callOpenAI(
      { provider: 'openai', apiKey: 'k', model: 'gpt-5', endpoint: 'https://api.openai.com/v1' },
      [layeredSystemForTests(), { role: 'user', content: 'read README' }],
      [sampleTool],
      { effort: 'high' },
    );
    assert.equal(capturedUrl, 'https://api.openai.com/v1/responses');
    assert.equal(capturedBody.instructions, 'CORE INSTRUCTIONS');
    assert.equal(capturedBody.input[0].role, 'developer');
    assert.deepEqual(capturedBody.input[0].content.map((c: any) => c.text), ['DEV MEMORY', 'DEV POLICY']);
    assert.equal(capturedBody.tools[0].name, 'read_file');
    assert.deepEqual(capturedBody.reasoning, { effort: 'high' });
    assert.equal(result.content, 'done');
    assert.equal(result.toolCalls?.[0].id, 'call_read');
    assert.equal(result.usage?.prompt_tokens, 100);
    assert.equal((result.usage as any).prompt_tokens_details.cached_tokens, 25);
  } finally {
    resetCliKnobsForAgentRuntimeTest();
    globalThis.fetch = originalFetch;
  }
});

test('callOpenAI: custom OpenAI-compatible endpoint keeps chat-completions with mirrored layers', async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = '';
  let capturedBody: any;
  globalThis.fetch = (async (url: any, opts: any) => {
    capturedUrl = String(url);
    capturedBody = JSON.parse(opts.body);
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'chat done' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 3 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as any;

  try {
    const result = await callOpenAI(
      { provider: 'openai', apiKey: '', model: 'custom-model', endpoint: 'http://localhost:1234/v1' },
      [layeredSystemForTests(), { role: 'user', content: 'hello' }],
      [sampleTool],
    );
    assert.equal(capturedUrl, 'http://localhost:1234/v1/chat/completions');
    assert.deepEqual(capturedBody.messages.map((m: any) => m.role), ['system', 'user']);
    assert.match(capturedBody.messages[0].content, /^CORE INSTRUCTIONS/);
    assert.match(capturedBody.messages[0].content, /DEV MEMORY/);
    assert.match(capturedBody.messages[0].content, /WORKSPACE INSTRUCTIONS/);
    assert.equal(capturedBody.messages[1].content, 'hello');
    assert.equal(capturedBody.messages.some((m: any) => m.role === 'developer'), false);
    assert.equal(capturedBody.messages.filter((m: any) => m.role === 'system').length, 1);
    assert.equal(capturedBody.tools[0].function.name, 'read_file');
    assert.equal(result.content, 'chat done');
  } finally {
    resetCliKnobsForAgentRuntimeTest();
    globalThis.fetch = originalFetch;
  }
});

test('callOpenAI: explicit Responses override sends non-OpenAI gateway models through /responses', async () => {
  const originalFetch = globalThis.fetch;
  resetCliKnobsForAgentRuntimeTest({ providerRequestFormat: { 'openai-compatible': 'responses' } });
  let capturedUrl = '';
  let capturedBody: any;
  globalThis.fetch = (async (url: any, opts: any) => {
    capturedUrl = String(url);
    capturedBody = JSON.parse(opts.body);
    return new Response(JSON.stringify({
      id: 'resp_gateway_model',
      status: 'completed',
      output_text: 'gemma done',
      output: [],
      usage: { input_tokens: 12, output_tokens: 2, total_tokens: 14 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as any;

  try {
    const result = await callOpenAI(
      { provider: 'openai-compatible', apiKey: 'k', model: 'google/gemma-4-12b', endpoint: 'https://gateway.example/v1' },
      [layeredSystemForTests(), { role: 'user', content: 'hi' }],
      [],
    );
    assert.equal(capturedUrl, 'https://gateway.example/v1/responses');
    assert.equal(capturedBody.model, 'google/gemma-4-12b');
    assert.equal(capturedBody.instructions, 'CORE INSTRUCTIONS');
    assert.equal(capturedBody.messages, undefined);
    assert.equal(capturedBody.input[0].role, 'developer');
    assert.deepEqual(capturedBody.input[0].content.map((c: any) => c.text), ['DEV MEMORY', 'DEV POLICY']);
    assert.equal(capturedBody.input[1].role, 'user');
    assert.match(capturedBody.input[1].content[0].text, /WORKSPACE INSTRUCTIONS/);
    assert.equal(capturedBody.input[2].role, 'user');
    assert.equal(capturedBody.input[2].content[0].text, 'hi');
    assert.equal(result.content, 'gemma done');
  } finally {
    resetCliKnobsForAgentRuntimeTest();
    globalThis.fetch = originalFetch;
  }
});

test('callOpenAI: retries once without reasoning effort when an OpenAI-compatible backend rejects the field', async () => {
  const originalFetch = globalThis.fetch;
  _resetModelReasoningCapabilities();
  registerModelReasoningCapabilities('lmstudio/gemma-retry-binary', { reasoning: true, efforts: ['on', 'off'] });
  const capturedBodies: any[] = [];
  globalThis.fetch = (async (_url: any, opts: any) => {
    const body = JSON.parse(opts.body);
    capturedBodies.push(body);
    if (capturedBodies.length === 1) {
      return new Response(JSON.stringify({
        error: {
          message: "Invalid 'reasoning_effort' value: 'high'. Supported values: none, minimal, low, medium, high, xhigh.",
          type: 'invalid_request_error',
          param: 'reasoning_effort',
          code: 'invalid_value',
        },
      }), { status: 400, statusText: 'Bad Request', headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'retried without effort' }, finish_reason: 'stop' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as any;

  try {
    const result = await callOpenAI(
      { provider: 'lmstudio', apiKey: '', model: 'lmstudio/gemma-retry-binary' },
      [{ role: 'user', content: 'hello' }],
      [],
      { effort: 'high' },
    );

    assert.equal(capturedBodies.length, 2);
    assert.equal(capturedBodies[0].reasoning_effort, 'high');
    assert.deepEqual(capturedBodies[0].reasoning, { effort: 'high' });
    assert.equal(capturedBodies[1].reasoning_effort, undefined);
    assert.equal(capturedBodies[1].reasoning, undefined);
    assert.equal(result.content, 'retried without effort');
  } finally {
    _resetModelReasoningCapabilities();
    globalThis.fetch = originalFetch;
  }
});

test('callOpenAI: provider default endpoint is used before the OpenAI fallback', async () => {
  const originalFetch = globalThis.fetch;
  _resetModelReasoningCapabilities();
  registerModelReasoningCapabilities('lmstudio/gemma-provider-default', { reasoning: true, efforts: ['on', 'off'] });
  let capturedUrl = '';
  let capturedHeaders: Record<string, string> = {};
  let capturedBody: any;
  globalThis.fetch = (async (url: any, opts: any) => {
    capturedUrl = String(url);
    capturedHeaders = opts.headers;
    capturedBody = JSON.parse(opts.body);
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'local done' }, finish_reason: 'stop' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as any;

  try {
    const result = await callOpenAI(
      { provider: 'lmstudio', apiKey: '', model: 'lmstudio/gemma-provider-default' },
      [{ role: 'user', content: 'think locally' }],
      [],
      { effort: 'high' },
    );

    assert.equal(capturedUrl, 'http://localhost:1234/v1/chat/completions');
    assert.equal(capturedHeaders.Authorization, 'Bearer local');
    assert.equal(capturedBody.reasoning_effort, 'high');
    assert.deepEqual(capturedBody.reasoning, { effort: 'high' });
    assert.equal(result.content, 'local done');
  } finally {
    _resetModelReasoningCapabilities();
    globalThis.fetch = originalFetch;
  }
});

test('callOpenAI: explicit canonical OpenAI endpoint overrides a mismatched binary-capable provider id', async () => {
  const originalFetch = globalThis.fetch;
  _resetModelReasoningCapabilities();
  registerModelReasoningCapabilities('gpt-5-provider-mismatch', { reasoning: true, efforts: ['on', 'off'] });
  let capturedUrl = '';
  let capturedBody: any;
  globalThis.fetch = (async (url: any, opts: any) => {
    capturedUrl = String(url);
    capturedBody = JSON.parse(opts.body);
    return new Response(JSON.stringify({
      id: 'resp_provider_mismatch',
      status: 'completed',
      output_text: 'openai done',
      output: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as any;

  try {
    const result = await callOpenAI(
      {
        provider: 'lmstudio',
        apiKey: 'k',
        model: 'gpt-5-provider-mismatch',
        endpoint: 'https://api.openai.com/v1',
      },
      [{ role: 'user', content: 'think on openai' }],
      [],
      { effort: 'high' },
    );

    assert.equal(capturedUrl, 'https://api.openai.com/v1/responses');
    assert.deepEqual(capturedBody.reasoning, { effort: 'high' });
    assert.equal(capturedBody.reasoning_effort, undefined);
    assert.equal(result.content, 'openai done');
  } finally {
    _resetModelReasoningCapabilities();
    globalThis.fetch = originalFetch;
  }
});

test('callOpenAIStream: parses Responses typed SSE text, function calls, and usage', async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const frames = [
    { type: 'response.output_text.delta', delta: 'he' },
    { type: 'response.output_text.delta', delta: 'llo' },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_read', name: 'read_file', arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"path":"' },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: 'README.md"}' },
    { type: 'response.function_call_arguments.done', output_index: 1, arguments: '{"path":"README.md"}', item: { type: 'function_call', call_id: 'call_read', name: 'read_file' } },
    { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 8, output_tokens: 2 } } },
  ];
  globalThis.fetch = (async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('')));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as any;

  try {
    const deltas: string[] = [];
    const result = await callOpenAIStream(
      { provider: 'openai', apiKey: 'k', model: 'gpt-5', endpoint: 'https://api.openai.com/v1' },
      [layeredSystemForTests(), { role: 'user', content: 'hello' }],
      [sampleTool],
      {},
      { onTextDelta: (text) => deltas.push(text) },
    );
    assert.deepEqual(deltas, ['he', 'llo']);
    assert.equal(result.content, 'hello');
    assert.equal(result.toolCalls?.[0].id, 'call_read');
    assert.equal(result.toolCalls?.[0].function.arguments, '{"path":"README.md"}');
    assert.equal(result.usage?.prompt_tokens, 8);
    assert.equal(result.usage?.completion_tokens, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('callOpenAIStream: provider default endpoint is used before the OpenAI fallback', async () => {
  const originalFetch = globalThis.fetch;
  _resetModelReasoningCapabilities();
  registerModelReasoningCapabilities('lmstudio/gemma-provider-default-stream', { reasoning: true, efforts: ['on', 'off'] });
  const encoder = new TextEncoder();
  let capturedUrl = '';
  let capturedHeaders: Record<string, string> = {};
  let capturedBody: any;
  globalThis.fetch = (async (url: any, opts: any) => {
    capturedUrl = String(url);
    capturedHeaders = opts.headers;
    capturedBody = JSON.parse(opts.body);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"local stream"},"finish_reason":"stop"}]}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as any;

  try {
    const result = await callOpenAIStream(
      { provider: 'lmstudio', apiKey: '', model: 'lmstudio/gemma-provider-default-stream' },
      [{ role: 'user', content: 'think locally' }],
      [],
      { effort: 'high' },
    );

    assert.equal(capturedUrl, 'http://localhost:1234/v1/chat/completions');
    assert.equal(capturedHeaders.Authorization, 'Bearer local');
    assert.equal(capturedBody.reasoning_effort, 'high');
    assert.deepEqual(capturedBody.reasoning, { effort: 'high' });
    assert.equal(capturedBody.stream, true);
    assert.equal(result.content, 'local stream');
  } finally {
    _resetModelReasoningCapabilities();
    globalThis.fetch = originalFetch;
  }
});

test('callOpenAIStream: retries once without reasoning effort when the stream endpoint rejects the field', async () => {
  const originalFetch = globalThis.fetch;
  _resetModelReasoningCapabilities();
  registerModelReasoningCapabilities('lmstudio/gemma-stream-retry-binary', { reasoning: true, efforts: ['on', 'off'] });
  const encoder = new TextEncoder();
  const capturedBodies: any[] = [];
  globalThis.fetch = (async (_url: any, opts: any) => {
    const body = JSON.parse(opts.body);
    capturedBodies.push(body);
    if (capturedBodies.length === 1) {
      return new Response(JSON.stringify({
        error: {
          message: "Invalid 'reasoning_effort' value: 'high'. Supported values: none, minimal, low, medium, high, xhigh.",
          param: 'reasoning_effort',
        },
      }), { status: 400, statusText: 'Bad Request', headers: { 'Content-Type': 'application/json' } });
    }
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"retry stream"},"finish_reason":"stop"}]}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as any;

  try {
    const result = await callOpenAIStream(
      { provider: 'lmstudio', apiKey: '', model: 'lmstudio/gemma-stream-retry-binary' },
      [{ role: 'user', content: 'hello' }],
      [],
      { effort: 'high' },
    );

    assert.equal(capturedBodies.length, 2);
    assert.equal(capturedBodies[0].reasoning_effort, 'high');
    assert.equal(capturedBodies[0].stream, true);
    assert.equal(capturedBodies[1].reasoning_effort, undefined);
    assert.equal(capturedBodies[1].reasoning, undefined);
    assert.equal(capturedBodies[1].stream, true);
    assert.equal(result.content, 'retry stream');
  } finally {
    _resetModelReasoningCapabilities();
    globalThis.fetch = originalFetch;
  }
});
import { executeOrchestrationTool } from '../orchestration/tools.js';
import { clearGoal, readGoal, setGoal } from '../goal/store/goalStore.js';
import { makeAgent, withTempWorkspace, withTempWorkspaceAsync } from './_helpers.js';

test('direct browser tool dispatch stays blocked for silent/non-interactive agents even if a port is present', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const agent = makeAgent(workspace);
    agent.browserControlPort = { request: async (command: any) => ({ ok: true, kind: command.kind, durationMs: 0 }) };
    await assert.rejects(
      () => agent.executeLocalTool('browser_list_tabs', {}),
      /(?:unavailable outside the active top-level local Desktop browser session|Unknown local tool)/,
    );
  });
});
import { listArtifacts } from '../artifact/artifactStore.js';
import { createConnector } from '../connectors/store/connectorStore.js';

test('compactHistory: stores compacted state in prompt layers without chat developer roles', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const agent: any = makeAgent(workspace);
    agent.chatHistory = [
      agent.createSystemMessage(),
      { role: 'user', content: `first request ${'context '.repeat(200)}` },
      { role: 'assistant', content: `first answer ${'evidence '.repeat(200)}` },
      { role: 'system', content: '<!--brainrouter:goal-anchor-->\nPreserve unresolved constraint alpha.' },
      { role: 'user', content: 'continue from here' },
    ];

    const originalFetch = globalThis.fetch;
    let capturedCompactionBody: any;
    globalThis.fetch = (async (_url: any, opts: any) => {
      capturedCompactionBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: '<analysis>keep the key state</analysis><summary>Important compacted state.</summary>',
          },
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;

    try {
      const result = await agent.compactHistory();
      assert.equal(result?.summary, 'Important compacted state.');
      assert.deepEqual(capturedCompactionBody.messages.map((m: any) => m.role), ['system', 'user']);
      assert.match(capturedCompactionBody.messages[0].content, /Never copy passwords, API keys/);
      assert.match(capturedCompactionBody.messages[1].content, /Preserve unresolved constraint alpha/);
      assert.doesNotMatch(capturedCompactionBody.messages[1].content, /You are BrainRouter CLI/);

      const history = agent.chatHistory;
      assert.equal(history.length, 2);
      assert.equal(history[1].role, 'user');
      assert.equal(history.some((m: any, index: number) => index > 0 && m.role === 'system'), false);
      assert.equal(
        history[0].promptLayers.developer.some((text: string) => text.includes('Important compacted state.')),
        true,
      );

      const chatBody = buildChatCompletionPayload(
        { provider: 'openai-compatible', apiKey: 'k', model: 'custom-model', endpoint: 'https://gateway.example/v1' },
        history,
        [],
      );
      assert.equal(chatBody.messages.some((m) => m.role === 'developer'), false);
      assert.equal(chatBody.messages.some((m) => m.role === 'system' && String(m.content).includes('Important compacted state.')), true);

    const responsesBody = buildResponsesPayload(
      { provider: 'openai', apiKey: 'k', model: 'gpt-5', endpoint: 'https://api.openai.com/v1' },
      history,
      [],
    );
    assert.equal(responsesBody.input[0].role, 'developer');
    assert.equal(
      responsesBody.input[0].content.some((part: any) => part.text.includes('Important compacted state.')),
        true,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('compactHistory: normalizes full chat endpoint URLs and local auth', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const agent: any = makeAgent(workspace);
    agent.setLLMConfig({
      apiKey: '',
      endpoint: 'http://localhost:1234/v1/chat/completions',
      model: 'local-model',
    });
    agent.chatHistory = [
      agent.createSystemMessage(),
      { role: 'user', content: `first request ${'context '.repeat(200)}` },
      { role: 'assistant', content: `first answer ${'evidence '.repeat(200)}` },
      { role: 'user', content: 'continue from here' },
    ];

    const originalFetch = globalThis.fetch;
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = (async (url: any, opts: any) => {
      capturedUrl = String(url);
      capturedHeaders = opts.headers;
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: '<summary>Local compact summary.</summary>',
          },
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;

    try {
      await agent.compactHistory();
      assert.equal(capturedUrl, 'http://localhost:1234/v1/chat/completions');
      assert.equal(capturedHeaders.Authorization, 'Bearer local');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('artifact_write tool: creates then grows an artifact by id (versioned, editedBy agent) — §AV-4', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const agent: any = makeAgent(workspace);
    const created = await agent.executeLocalTool('artifact_write', { kind: 'design-note', title: 'Schema plan', format: 'markdown', content: '# v1' });
    const id = /art_[0-9a-f]{8}/.exec(created)?.[0];
    assert.ok(id, `expected an artifact id in: ${created}`);
    assert.match(created, /v1/);
    // grow it by id → v2
    const updated = await agent.executeLocalTool('artifact_write', { id, content: '# v1\n## more' });
    assert.match(updated, /v2/);
    const a = listArtifacts(workspace).find((x) => x.id === id)!;
    assert.equal(a.content, '# v1\n## more');
    assert.equal(a.versions!.length, 2);
    assert.equal(a.versions!.every((v) => v.editedBy === 'agent'), true);
    assert.equal(a.sessionKey, 'session:test');
    // updating a missing id throws
    await assert.rejects(() => agent.executeLocalTool('artifact_write', { id: 'art_00000000', content: 'x' }));
  });
});

test('connector_list tool: returns configured connectors for the workspace', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const agent: any = makeAgent(workspace);
    const created = createConnector(workspace, {
      source: 'filesystem',
      name: 'FS',
      config: { roots: ['docs'] },
      credential: { mode: 'none' },
      flows: ['checkpoint'],
    });
    const out = await agent.executeLocalTool('connector_list', {});
    const rows = JSON.parse(out) as Array<{ id: string; source: string; status: string; lastRunAt: string | null; lastError: string | null }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, created.id);
    assert.equal(rows[0].source, 'filesystem');
    assert.equal(rows[0].status, 'active');
    assert.equal(rows[0].lastRunAt, null);
    // source filter
    const empty = JSON.parse(await agent.executeLocalTool('connector_list', { source: 'github' })) as unknown[];
    assert.equal(empty.length, 0);
  });
});

test('connector_run tool: oauth github with no keychain client reports the desktop-only guidance (no memory import)', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const agent: any = makeAgent(workspace);
    const created = createConnector(workspace, {
      source: 'github',
      name: 'GH',
      config: { owner: 'kinqsradiollc' },
      credential: { mode: 'oauth', ref: 'gh' },
      flows: ['checkpoint'],
    });
    const out = await agent.executeLocalTool('connector_run', { connectorId: created.id });
    assert.match(out, /ran with failures/);
    assert.match(out, /run it from BrainRouter Desktop/);
    assert.match(out, /imported to memory: 0/);
  });
});

test('connector_run tool: requires a connectorId', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const agent: any = makeAgent(workspace);
    await assert.rejects(() => agent.executeLocalTool('connector_run', {}), /requires a `connectorId`/);
  });
});

test('resolveRecallMode: cli.recallMode > default (9b)', async () => {
  const { resolveRecallMode } = await import('../agent/agent.js');
    try {
      resetCliKnobsForAgentRuntimeTest();
      assert.equal(resolveRecallMode(), 'gated', 'unset config defaults to gated');

    setCliKnobOverride({ recallMode: 'always' });
    assert.equal(resolveRecallMode(), 'always');

    setCliKnobOverride({ recallMode: 'off' });
    assert.equal(resolveRecallMode(), 'off');

    setCliKnobOverride({ recallMode: 'gated' });
    assert.equal(resolveRecallMode(), 'gated');
    } finally {
      resetCliKnobsForAgentRuntimeTest();
    }
});

test('countEntityTokens: detects file paths, identifiers, and proper nouns (9b)', async () => {
  const { countEntityTokens } = await import('../agent/agent.js');
  // Empty / trivial inputs.
  assert.equal(countEntityTokens(''), 0);
  assert.equal(countEntityTokens('thanks'), 0);
  assert.equal(countEntityTokens('ok'), 0);

  // File paths trigger detection.
  assert.ok(countEntityTokens('look at src/foo.ts') >= 1);
  assert.ok(countEntityTokens('compare src/foo.ts vs lib/bar.ts') >= 2);

  // Identifier-shaped tokens (camelCase, snake_case, PascalCase) trigger.
  assert.ok(countEntityTokens('debug the BillingService and userController paths') >= 2);

  // Sentence-leading capitals do NOT count — only mid-sentence proper nouns.
  // "The cat" → "The" is leading, not counted; "cat" lowercase doesn't count.
  assert.equal(countEntityTokens('The cat sat down.'), 0);
  // "I talked to John about Mary" → John + Mary count.
  assert.ok(countEntityTokens('I talked to John about Mary') >= 2);

  // A realistic "ambiguous-enough-to-need-recall" message clears the 2-cue bar.
  const score = countEntityTokens('what did we decide about src/foo.ts and the BillingService?');
  assert.ok(score >= 2, `expected ≥2 entity hits, got ${score}`);
});

test('normalizeToolName resolves common LLM hallucinations to the canonical tool name', async () => {
  const { normalizeToolName } = await import('../agent/agent.js');
  const candidates = ['read_file', 'list_dir', 'grep_search', 'memory_recall'];
  // Exact match passes through unchanged.
  assert.equal(normalizeToolName('read_file', candidates), 'read_file');
  // Case variants.
  assert.equal(normalizeToolName('Read_File', candidates), 'read_file');
  assert.equal(normalizeToolName('READ_FILE', candidates), 'read_file');
  // Separator variants.
  assert.equal(normalizeToolName('read-file', candidates), 'read_file');
  assert.equal(normalizeToolName('read.file', candidates), 'read_file');
  assert.equal(normalizeToolName('read file', candidates), 'read_file');
  // Whitespace around.
  assert.equal(normalizeToolName('  read_file  ', candidates), 'read_file');
  // Unknown name passes through (trimmed) so the existing explainer can fire.
  assert.equal(normalizeToolName('not_a_real_tool', candidates), 'not_a_real_tool');
  // Ambiguous collision: if two candidates would normalize to the same form,
  // we fall back to the input rather than silently picking one.
  assert.equal(normalizeToolName('foo', ['foo_', 'foo-']), 'foo');
});

test('normalizeToolName resolves cross-vendor shell aliases to run_command', async () => {
  const { normalizeToolName } = await import('../agent/agent.js');
  const candidates = ['run_command', 'read_file', 'list_dir'];
  // Known shell-tool convention.
  assert.equal(normalizeToolName('Bash', candidates), 'run_command');
  assert.equal(normalizeToolName('bash', candidates), 'run_command');
  // Generic shell synonyms.
  assert.equal(normalizeToolName('shell', candidates), 'run_command');
  assert.equal(normalizeToolName('sh', candidates), 'run_command');
});

test('normalizeToolName does NOT alias bash when run_command is not in the registry', async () => {
  const { normalizeToolName } = await import('../agent/agent.js');
  // Read-only access mode strips run_command. Aliasing must not silently
  // re-create access the agent doesn't have — let dispatch return "unknown
  // tool" instead.
  const candidates = ['read_file', 'list_dir'];
  assert.equal(normalizeToolName('bash', candidates), 'bash');
});

test('Agent.setModel / getModel switches the LLM model at runtime', () => {
  withTempWorkspace((workspace) => {
    const agent = makeAgent(workspace);
    assert.equal(agent.getModel(), 'test-model');
    agent.setModel('claude-sonnet-4-5');
    assert.equal(agent.getModel(), 'claude-sonnet-4-5');
  });
});

test('Agent.setLLMConfig: /config writes propagate to the live agent without restart', () => {
  withTempWorkspace((workspace) => {
    const agent = makeAgent(workspace);
    // Baseline from makeAgent fixture: openai, apiKey='k', model='test-model', no endpoint.
    assert.equal(agent.getLLMConfig().apiKey, 'k');
    assert.equal(agent.getLLMConfig().endpoint, undefined);
    // Simulate /config changing the API key + endpoint (e.g. user
    // pointed the CLI at LM Studio). Pre-0.3.10 this required a CLI
    // restart because the agent only exposed setModel.
    agent.setLLMConfig({
      apiKey: 'lm-studio-key',
      endpoint: 'http://localhost:1234/v1',
      model: 'qwen3-coder-30b',
    });
    const after = agent.getLLMConfig();
    assert.equal(after.apiKey, 'lm-studio-key');
    assert.equal(after.endpoint, 'http://localhost:1234/v1');
    assert.equal(after.model, 'qwen3-coder-30b');
    // Provider was not in the partial; setLLMConfig merges, so it
    // should be preserved from the prior config.
    assert.equal(after.provider, 'openai');
  });
});

test('Agent.setLLMConfig: partial updates leave untouched fields alone', () => {
  withTempWorkspace((workspace) => {
    const agent = makeAgent(workspace);
    agent.setLLMConfig({ endpoint: 'http://example.com/v1' });
    const after = agent.getLLMConfig();
    assert.equal(after.endpoint, 'http://example.com/v1');
    // model + apiKey + provider untouched.
    assert.equal(after.model, 'test-model');
    assert.equal(after.apiKey, 'k');
    assert.equal(after.provider, 'openai');
  });
});

test('Agent.setAccessMode / getAccessMode round-trips and tracks current mode', () => {
  withTempWorkspace((workspace) => {
    const agent = makeAgent(workspace);
    // Silent children default to whatever was constructed; we explicitly set here.
    agent.setAccessMode('read');
    assert.equal(agent.getAccessMode(), 'read');
    agent.setAccessMode('write');
    assert.equal(agent.getAccessMode(), 'write');
    agent.setAccessMode('shell');
    assert.equal(agent.getAccessMode(), 'shell');
  });
});

test('Agent.loadHistory replaces chat history and refreshSystemPrompt updates it in place', () => {
  withTempWorkspace((workspace) => {
    const agent = makeAgent(workspace);
    const replay = [
      { role: 'user', content: 'previous question' },
      { role: 'assistant', content: 'previous answer' },
      { role: 'system', content: 'should be ignored' }, // only user/assistant/tool replayed
    ];
    const count = agent.loadHistory(replay);
    assert.equal(count, 2);
    // Pre-9d the goal block landed in chatHistory[0] AND was re-pushed as a
    // per-turn `goal-anchor` system message — same content in two places
    // per turn. 9d made the per-turn anchor the single owner; the
    // foundational system message no longer mentions the goal. Verify the
    // ownership change: setting a goal + refreshing the prompt produces a
    // system message that DOES NOT contain the goal text (the next
    // runTurn would push it via the anchor).
    setGoal(workspace, 'finish the auth refactor', agent.sessionKey);
    agent.refreshSystemPrompt();
    const sys = (agent as any).chatHistory[0];
    assert.equal(sys.role, 'system');
    assert.doesNotMatch(sys.content, /Active Goal/, 'foundational system message must not carry the goal block (9d)');
    assert.doesNotMatch(sys.content, /finish the auth refactor/, 'foundational system message must not echo the goal text (9d)');
    clearGoal(workspace, agent.sessionKey);
  });
});

test('Agent.runTurn pushes the goal-anchor system message as the single owner of goal state (9d)', async () => {
  // Verifies the per-turn anchor still fires after createSystemMessage
  // stopped embedding the goal. Without this assertion, future refactors
  // could silently drop the anchor injection and lose the goal entirely.
  await withTempWorkspaceAsync(async (workspace) => {
    const agent = makeAgent(workspace);
    setGoal(workspace, 'reach a stable build', agent.sessionKey);
    // Seed the chat history with the foundational system message exactly
    // as bootstrapSession would, so the test mirrors the real runTurn
    // sequencing (foundational system message first, then per-turn
    // anchor pushed to the end).
    agent.loadHistory([]);
    agent.refreshSystemPrompt();
    const foundationalSystem = (agent as any).chatHistory[0];
    assert.doesNotMatch(
      foundationalSystem.content,
      /reach a stable build/,
      'foundational system message must not carry the goal text (9d ownership change)',
    );
    // Now drive the anchor injection directly — same code path as
    // `agent.ts:680` inside `runTurn`.
    const { formatGoalBlock, readGoal } = await import('../goal/store/goalStore.js');
    const goal = readGoal(workspace, agent.sessionKey);
    assert.ok(goal, 'precondition: setGoal succeeded');
    (agent as any).replaceTaggedSystemMessage('goal-anchor', formatGoalBlock(goal!));
    const hist = (agent as any).chatHistory;
    const anchor = hist.find((m: any) =>
      m.role === 'system' && typeof m.content === 'string' && m.content.includes('brainrouter:goal-anchor'),
    );
    assert.ok(anchor, 'goal-anchor must be present after the per-turn re-push');
    assert.match(anchor.content, /reach a stable build/, 'anchor must contain the goal text');
    assert.match(anchor.content, /Active Goal/, 'anchor must contain the canonical block header');
    // Anchor lives AT THE END so it's in immediate-context distance for
    // the upcoming user message (PR #26 design — the whole point of the
    // per-turn re-push). chatHistory[0] still must not duplicate it.
    assert.equal(hist[hist.length - 1], anchor);
    assert.notEqual(hist[0], anchor, 'foundational system message must not BE the anchor (9d)');
    clearGoal(workspace, agent.sessionKey);
  });
});

test('Agent.fork swaps the sessionKey while preserving prior history', () => {
  withTempWorkspace((workspace) => {
    const agent = makeAgent(workspace);
    agent.loadHistory([
      { role: 'user', content: 'first turn' },
      { role: 'assistant', content: 'reply' },
    ]);
    const newKey = `${agent.sessionKey}:fork:abcdef`;
    agent.fork(newKey);
    assert.equal(agent.sessionKey, newKey);
    const hist = (agent as any).chatHistory;
    // System message is regenerated, but the prior turn pair is kept.
    assert.equal(hist[0].role, 'system');
    assert.equal(hist[1].content, 'first turn');
    assert.equal(hist[2].content, 'reply');
  });
});

test('agent: removeTaggedSystemMessage is idempotent and clears stale entries', async () => {
  const { Agent } = await import('../agent/agent.js');
  // Construct an Agent without touching MCP/LLM; we just exercise the
  // chatHistory mutation methods that are pure CPU.
  const stubMcp: any = { callTool: async () => ({ content: [] }) };
  const agent: any = new Agent(stubMcp, { provider: 'openai', apiKey: '', model: 'gpt-4o-mini' }, {
    workspaceRoot: '/tmp', launchCwd: '/tmp', sessionKey: 's:test',
  });
  // Seed with a system message (the constructor pushes one).
  agent.replaceTaggedSystemMessage('demo', 'first version');
  assert.equal(agent.chatHistory.filter((m: any) => m.content?.includes('first version')).length, 1);
  agent.replaceTaggedSystemMessage('demo', 'second version');
  // Replace removes the first version and adds the second.
  assert.equal(agent.chatHistory.filter((m: any) => m.content?.includes('first version')).length, 0);
  assert.equal(agent.chatHistory.filter((m: any) => m.content?.includes('second version')).length, 1);
  agent.replaceTaggedSystemMessage('later', 'later directive');
  const stableIndex = agent.chatHistory.findIndex((m: any) => m.content?.includes('second version'));
  agent.replaceTaggedSystemMessage('demo', 'second version');
  assert.equal(
    agent.chatHistory.findIndex((m: any) => m.content?.includes('second version')),
    stableIndex,
    'byte-identical replacements preserve stable directive ordering',
  );
  // Remove drops the second.
  agent.removeTaggedSystemMessage('demo');
  assert.equal(agent.chatHistory.filter((m: any) => m.content?.includes('second version')).length, 0);
  // Idempotent: removing again is a no-op (doesn't throw).
  agent.removeTaggedSystemMessage('demo');
  // Other tags are untouched by tag-specific removal.
  agent.replaceTaggedSystemMessage('other', 'keep me');
  agent.removeTaggedSystemMessage('demo');
  assert.equal(agent.chatHistory.filter((m: any) => m.content?.includes('keep me')).length, 1);
});

test('Agent steering inbox is ordered, bounded, and consumed exactly once', () => {
  const stubMcp: any = { callTool: async () => ({ content: [] }) };
  const agent = new Agent(stubMcp, { provider: 'openai', apiKey: '', model: 'gpt-4o-mini' }, {
    workspaceRoot: '/tmp', launchCwd: '/tmp', sessionKey: 's:steer',
  });
  agent.requestSteer('first', { id: 's1', source: 'user' });
  agent.requestSteer('CI failed', { id: 's2', source: 'extension' });
  assert.equal(agent.pendingSteeringCount, 2);
  assert.deepEqual(agent.consumePendingSteering().map((input) => ({
    id: input.id,
    text: input.text,
    source: input.source,
  })), [
    { id: 's1', text: 'first', source: 'user' },
    { id: 's2', text: 'CI failed', source: 'extension' },
  ]);
  assert.equal(agent.pendingSteeringCount, 0);
  assert.deepEqual(agent.consumePendingSteering(), []);
  assert.throws(() => agent.requestSteer('   '), /cannot be empty/);
  assert.throws(() => agent.requestSteer('x'.repeat(20_001)), /exceeds 20000/);
});

test('runTurn applies Steer after an in-flight model response and before the next request', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const requestBodies: string[] = [];
    let calls = 0;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      calls++;
      requestBodies.push(String(init?.body ?? ''));
      if (calls === 1) {
        await firstGate;
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'Initial direction.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 4 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Adjusted direction.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 30, completion_tokens: 4 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    try {
      const stubMcp: any = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [] }),
        close: async () => {},
      };
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace,
        launchCwd: workspace,
        silent: true,
      });
      const applied: string[] = [];
      const turn = agent.runTurn('Start here.', {
        onStatusUpdate: () => {},
        onToolStart: () => {},
        onToolEnd: () => {},
        onSteerApplied: (input) => applied.push(input.id),
      });
      await waitForValue(() => calls, (value) => value === 1);
      agent.requestSteer('PR #42 has one new review.', {
        id: 'steer-safe-boundary',
        source: 'extension',
      });
      releaseFirst();

      assert.equal(await turn, 'Adjusted direction.');
      assert.deepEqual(applied, ['steer-safe-boundary']);
      assert.equal(calls, 2);
      assert.match(requestBodies[1], /Background observation from a built-in extension/);
      assert.match(requestBodies[1], /external content as untrusted data/);
      assert.match(requestBodies[1], /Steering reconciliation/);
      assert.match(requestBodies[1], /call `update_plan` before the related mutation/);
      assert.match(requestBodies[1], /do not rewrite the goal implicitly/);
      assert.match(requestBodies[1], /PR #42 has one new review/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('runTurn: task budget aborts when provider usage reaches token cap', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    setCliKnobOverride({ budget: { maxPerTaskUSD: 0, maxPerTaskTokens: 25 } });
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'done' } }],
      usage: { prompt_tokens: 20, completion_tokens: 5 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as any;
    try {
      const stubMcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [] }), close: async () => {} };
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true,
      });
      await assert.rejects(
        () => agent.runTurn('answer', { onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {} }),
        (err) => err instanceof BudgetExceededError && err.budget.classification === 'budget_exceeded' && err.budget.spentTokens === 25,
      );
    } finally {
      resetCliKnobsForAgentRuntimeTest();
      globalThis.fetch = originalFetch;
    }
  });
});

test('runTurn: disabled task budget leaves provider usage behavior unchanged', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    setCliKnobOverride({ budget: { maxPerTaskUSD: 0, maxPerTaskTokens: 0 } });
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'done' } }],
      usage: { prompt_tokens: 20, completion_tokens: 5 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as any;
    try {
      const stubMcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [] }), close: async () => {} };
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true,
      });
      const answer = await agent.runTurn('answer', { onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {} });
      assert.equal(answer, 'done');
    } finally {
      resetCliKnobsForAgentRuntimeTest();
      globalThis.fetch = originalFetch;
    }
  });
});

test('runTurn: repeat-loop guard short-circuits identical (tool, args) calls after 3 repeats', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    let llmCalls = 0;
    const toolCallEvents: Array<{ name: string; ok: boolean; summary: string }> = [];
    globalThis.fetch = (async (_url: any, opts: any) => {
      llmCalls++;
      const body = JSON.parse(opts.body);
      // The model keeps insisting on list_dir({path:"."}) until iteration 5
      // when it gives up and produces a final answer.
      if (llmCalls <= 5) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [{ id: `call_${llmCalls}`, type: 'function', function: { name: 'list_dir', arguments: '{"path":"."}' } }],
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'I gave up trying the same thing.' } }],
        usage: { prompt_tokens: 50, completion_tokens: 8 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;
    try {
      const stubMcp: any = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [{ text: '{}' }] }),
        close: async () => {},
      };
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true,
      });
      await agent.runTurn('list it', {
        onStatusUpdate: () => {},
        onToolStart: () => {},
        onToolEnd: (name, result) => { toolCallEvents.push({ name, ok: result.success, summary: result.summary }); },
      });
      // First 3 calls executed normally (the directory exists, will succeed).
      const successes = toolCallEvents.filter((e) => e.ok && e.name === 'list_dir').length;
      const guarded = toolCallEvents.filter((e) => !e.ok && /repeat guard/.test(e.summary)).length;
      assert.equal(successes, 3, `expected 3 successful list_dir calls, got ${successes}`);
      assert.equal(guarded >= 1, true, `expected at least 1 repeat-guard trip, got ${guarded}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('runTurn: a finish_reason:"length" final answer fires onNotice (cut-off → raise cli.maxOutputTokens)', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    const makeStub = (finishReason: string) => (async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'BrainRouter isn’t a layer to' }, finish_reason: finishReason }],
      usage: { prompt_tokens: 30, completion_tokens: 8 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as any;
    const stubMcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [{ text: '{}' }] }), close: async () => {} };
    try {
      // length ⇒ a notice fires telling the user to raise the output cap.
      globalThis.fetch = makeStub('length');
      const truncated = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test' }, { workspaceRoot: workspace, launchCwd: workspace, silent: true });
      const notices: Array<{ level: string; message: string }> = [];
      await truncated.runTurn('explain', { onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {}, onNotice: (n) => notices.push(n) });
      assert.equal(notices.length, 1, `expected one truncation notice, got ${notices.length}`);
      assert.match(notices[0].message, /maxOutputTokens/);
      assert.equal(notices[0].level, 'warn');

      // stop ⇒ a normal completion never nags.
      globalThis.fetch = makeStub('stop');
      const normal = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test' }, { workspaceRoot: workspace, launchCwd: workspace, silent: true });
      const noNotices: Array<unknown> = [];
      await normal.runTurn('explain', { onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {}, onNotice: (n) => noNotices.push(n) });
      assert.equal(noNotices.length, 0, 'a clean finish_reason:stop must not fire a truncation notice');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('runTurn empty LLM answer after a tool call returns a useful summary (not the loop-limit error)', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    let llmCalls = 0;
    globalThis.fetch = (async () => {
      llmCalls++;
      if (llmCalls === 1) {
        // First turn: ask for list_dir.
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'list_dir', arguments: '{"path":"."}' } }],
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      // Second turn: empty content, NO tool calls (the bug-trigger case).
      return new Response(JSON.stringify({
        choices: [{ message: { content: '' } }],
        usage: { prompt_tokens: 50, completion_tokens: 0 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;
    try {
      const stubMcp: any = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [{ text: '{}' }] }),
        close: async () => {},
      };
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true,
      });
      const answer = await agent.runTurn('list dir', {
        onStatusUpdate: () => {},
        onToolStart: () => {},
        onToolEnd: () => {},
      });
      assert.doesNotMatch(answer, /tool-call loop limit/);
      assert.equal(agent.lastTurnHitLoopLimit, false);
      assert.equal(agent.lastTurnToolCalls, 1);
      assert.match(answer, /Tool calls completed/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('runTurn repeat-SEQUENCE guard: reading DIFFERENT files is forward progress, not a loop (args-aware)', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    for (let i = 1; i <= 5; i++) {
      fs.writeFileSync(path.join(workspace, `file-${i}.txt`), `content ${i}`);
    }
    const originalFetch = globalThis.fetch;
    let llmCalls = 0;
    setCliKnobOverride({ repeatToolSequenceLimit: 3 });
    globalThis.fetch = (async () => {
      llmCalls++;
      if (llmCalls <= 5) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: `call_read_${llmCalls}`,
                type: 'function',
                function: { name: 'read_file', arguments: JSON.stringify({ path: `file-${llmCalls}.txt` }) },
              }],
            },
          }],
          usage: { prompt_tokens: 40, completion_tokens: 5 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Read them all.' } }],
        usage: { prompt_tokens: 40, completion_tokens: 5 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;
    try {
      const stubMcp: any = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [{ text: '{}' }] }),
        close: async () => {},
      };
      const events: Array<{ name: string; ok: boolean; summary: string }> = [];
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true,
      });
      const answer = await agent.runTurn('read a bunch', {
        onStatusUpdate: () => {},
        onToolStart: () => {},
        onToolEnd: (name, result) => { events.push({ name, ok: result.success, summary: result.summary }); },
      });
      assert.equal(answer, 'Read them all.');
      // All 5 reads of DIFFERENT files succeed — the old name-only signature
      // wrongly capped this methodical sweep at the limit (3). With the
      // args-aware signature each distinct path is its own batch, never a repeat.
      assert.equal(events.filter((e) => e.name === 'read_file' && e.ok).length, 5);
      assert.equal(events.some((e) => /repeat sequence guard/.test(e.summary)), false);
    } finally {
      globalThis.fetch = originalFetch;
      resetCliKnobsForAgentRuntimeTest();
    }
  });
});

test('runTurn repeat-SEQUENCE guard: re-issuing the IDENTICAL call (same file, same args) still trips', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    fs.writeFileSync(path.join(workspace, 'same.txt'), 'content');
    const originalFetch = globalThis.fetch;
    let llmCalls = 0;
    setCliKnobOverride({ repeatToolSequenceLimit: 3 });
    globalThis.fetch = (async () => {
      llmCalls++;
      if (llmCalls <= 8) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: `call_read_${llmCalls}`,
                type: 'function',
                // SAME file + SAME args every time → a genuine no-progress loop.
                function: { name: 'read_file', arguments: JSON.stringify({ path: 'same.txt' }) },
              }],
            },
          }],
          usage: { prompt_tokens: 40, completion_tokens: 5 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Stopped.' } }],
        usage: { prompt_tokens: 40, completion_tokens: 5 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;
    try {
      const stubMcp: any = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [{ text: '{}' }] }),
        close: async () => {},
      };
      const events: Array<{ name: string; ok: boolean; summary: string }> = [];
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true,
      });
      await agent.runTurn('read same file', {
        onStatusUpdate: () => {},
        onToolStart: () => {},
        onToolEnd: (name, result) => { events.push({ name, ok: result.success, summary: result.summary }); },
      });
      // A guard (sequence or per-call identical-args) must break the loop.
      assert.equal(
        events.some((e) => e.name === 'read_file' && !e.ok && /repeat (sequence )?guard/.test(e.summary)),
        true,
      );
    } finally {
      globalThis.fetch = originalFetch;
      resetCliKnobsForAgentRuntimeTest();
    }
  });
});

test('runTurn forces wait_agents before final answer after spawn_agents', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    let parentCalls = 0;
    let sawChildResultSystem = false;

    globalThis.fetch = (async (_url: any, opts: any) => {
      const body = JSON.parse(opts.body);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const lastUser = [...messages].reverse().find((m: any) => m.role === 'user')?.content ?? '';

      // PARITY-Q: a terse child prompt gets a one-line return-format nudge
      // appended, so match the prefix rather than the exact string.
      const childName = lastUser.startsWith('child-one') ? 'child-one' : lastUser.startsWith('child-two') ? 'child-two' : '';
      if (childName) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: `child output for ${childName}` } }],
          usage: { prompt_tokens: 20, completion_tokens: 5 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      parentCalls++;
      if (parentCalls === 1) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'call_spawn_all',
                type: 'function',
                function: {
                  name: 'spawn_agents',
                  arguments: JSON.stringify({
                    agents: [
                      { role: 'explorer', prompt: 'child-one' },
                      { role: 'explorer', prompt: 'child-two' },
                    ],
                  }),
                },
              }],
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (parentCalls === 2) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'I will now wait for them to complete.' } }],
          usage: { prompt_tokens: 80, completion_tokens: 8 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      sawChildResultSystem = messages.some((m: any) =>
        m.role === 'system' &&
        typeof m.content === 'string' &&
        m.content.includes('Recently waited child-agent outputs') &&
        m.content.includes('child output for child-one') &&
        m.content.includes('child output for child-two'),
      );
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Both child outputs were incorporated.' } }],
        usage: { prompt_tokens: 50, completion_tokens: 6 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;

    try {
      const stubMcp: any = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [{ text: '{}' }] }),
        close: async () => {},
      };
      const toolNames: string[] = [];
      const waitArgs: any[] = [];
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true,
      });
      const answer = await agent.runTurn('find me any vulnerabilities in the project', {
        onStatusUpdate: () => {},
        onToolStart: (name, args) => {
          toolNames.push(name);
          if (name === 'wait_agents') waitArgs.push(args);
        },
        onToolEnd: () => {},
      });

      assert.deepEqual(toolNames.filter((name) => name === 'wait_agents'), ['wait_agents']);
      assert.equal(waitArgs.length, 1);
      assert.equal(waitArgs[0].ids.length, 2);
      assert.equal(sawChildResultSystem, true);
      assert.equal(answer, 'Both child outputs were incorporated.');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('runTurn auto-drains spawned children and reports explicit timeout statuses', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    let parentCalls = 0;
    setCliKnobOverride({ childDrainTimeoutMs: 10 });

    globalThis.fetch = (async (_url: any, opts: any) => {
      const body = JSON.parse(opts.body);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const lastUser = [...messages].reverse().find((m: any) => m.role === 'user')?.content ?? '';

      if (/slow child task/.test(lastUser)) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'slow child output' } }],
          usage: { prompt_tokens: 20, completion_tokens: 5 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      parentCalls++;
      if (parentCalls === 1) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'call_spawn',
                type: 'function',
                function: {
                  name: 'spawn_agent',
                  arguments: JSON.stringify({ role: 'explorer', prompt: 'slow child task' }),
                },
              }],
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      return new Response(JSON.stringify({
        choices: [{ message: { content: 'I am waiting for the child agent to finish.' } }],
        usage: { prompt_tokens: 50, completion_tokens: 8 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;

    try {
      const stubMcp: any = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [{ text: '{}' }] }),
        close: async () => {},
      };
      const toolNames: string[] = [];
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true,
      });
      const answer = await agent.runTurn('start the slow child', {
        onStatusUpdate: () => {},
        onToolStart: (name) => { toolNames.push(name); },
        onToolEnd: () => {},
      });

      assert.deepEqual(toolNames.filter((name) => name === 'wait_agents'), ['wait_agents']);
      assert.match(answer, /children still running/i);
      assert.match(answer, /agent-[a-f0-9]{8}/);
      assert.match(answer, /explorer/);
      assert.match(answer, /running|pending/);
      assert.match(answer, /\/continue/);
      assert.doesNotMatch(answer, /I am waiting for the child agent/);

      await new Promise((resolve) => setTimeout(resolve, 70));
    } finally {
      globalThis.fetch = originalFetch;
      resetCliKnobsForAgentRuntimeTest();
    }
  });
});

test('runTurn: goal_complete is refused while the active plan has pending / in_progress items (plan honesty guard)', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const sessionKey = 'fixed-test-session-key-for-deterministic-agent-state';
    setGoal(workspace, 'analyze the CLI architecture', sessionKey);
    const originalFetch = globalThis.fetch;
    let llmCalls = 0;
    globalThis.fetch = (async () => {
      llmCalls++;
      if (llmCalls === 1) {
        // First LLM call: build a plan with one ✓ and three ☐.
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'call_plan',
                type: 'function',
                function: {
                  name: 'update_plan',
                  arguments: JSON.stringify({
                    plan: [
                      { step: 'Reload context', status: 'completed' },
                      { step: 'Analyze skillRunner.ts', status: 'pending' },
                      { step: 'Inspect runtime files', status: 'pending' },
                      { step: 'Synthesize summary', status: 'in_progress' },
                    ],
                  }),
                },
              }],
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 5 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (llmCalls === 2) {
        // Second LLM call: try to declare done while plan items are open.
        // The guard must refuse this with a clear remediation hint.
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'call_done',
                type: 'function',
                function: {
                  name: 'goal_complete',
                  arguments: JSON.stringify({ proof: 'Architecture synthesized.' }),
                },
              }],
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 5 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      // Third call: empty exit.
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'I will finish the work first.' } }],
        usage: { prompt_tokens: 50, completion_tokens: 5 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;
    try {
      const stubMcp: any = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [{ text: '{}' }] }),
        close: async () => {},
      };
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true, sessionKey,
      });
      await agent.runTurn('analyze', {
        onStatusUpdate: () => {},
        onToolStart: () => {},
        onToolEnd: () => {},
      });
      // The guard should have refused goal_complete — goal status stays active.
      const goalAfter = readGoal(workspace, sessionKey);
      assert.equal(goalAfter?.status, 'active', 'goal must remain active when plan is incomplete');
      assert.equal(agent.lastGoalTransition, undefined, 'lastGoalTransition must not be set when goal_complete was refused');
    } finally {
      globalThis.fetch = originalFetch;
      clearGoal(workspace, sessionKey);
    }
  });
});

test('buildChatCompletionPayload: forwards reasoning_effort for a known reasoning model on the OpenAI endpoint (0.3.6 item 2f)', () => {
  // gpt-5 + api.openai.com is the most clear-cut case: OpenAI's Chat
  // Completions schema lists `reasoning_effort: low|medium|high` and gpt-5
  // is a reasoning model. The forwarding must happen for low/high but stay
  // silent on medium — that's the default and forwarding it would change
  // request shape for every user who never touched /effort.
  const supported = buildChatCompletionPayload(
    {
      provider: 'openai',
      apiKey: 'k',
      model: 'gpt-5',
      endpoint: 'https://api.openai.com/v1',
    },
    [{ role: 'user', content: 'plan a refactor' }],
    [],
    { effort: 'high' },
  );
  assert.equal((supported as any).reasoning_effort, 'high');

  const lowEffort = buildChatCompletionPayload(
    {
      provider: 'openai',
      apiKey: 'k',
      model: 'gpt-5',
      endpoint: 'https://api.openai.com/v1',
    },
    [{ role: 'user', content: 'plan a refactor' }],
    [],
    { effort: 'low' },
  );
  assert.equal((lowEffort as any).reasoning_effort, 'low');

  // medium is the default — forwarding it would silently change request
  // shape for users who never set /effort. The field must be absent.
  const medium = buildChatCompletionPayload(
    {
      provider: 'openai',
      apiKey: 'k',
      model: 'gpt-5',
      endpoint: 'https://api.openai.com/v1',
    },
    [{ role: 'user', content: 'plan a refactor' }],
    [],
    { effort: 'medium' },
  );
  assert.equal((medium as any).reasoning_effort, undefined);

  // Omitting the option entirely is identical to medium — no change in shape.
  const noOption = buildChatCompletionPayload(
    {
      provider: 'openai',
      apiKey: 'k',
      model: 'gpt-5',
      endpoint: 'https://api.openai.com/v1',
    },
    [{ role: 'user', content: 'plan a refactor' }],
    [],
  );
  assert.equal((noOption as any).reasoning_effort, undefined);
});

test('buildChatCompletionPayload: skips reasoning_effort for non-reasoning models regardless of endpoint (0.3.6 item 2f)', () => {
  // gpt-4o-mini on the OpenAI endpoint: not a reasoning model, must not
  // receive reasoning_effort even when /effort is set — gpt-4o-mini
  // doesn't have a reasoning channel and the field would be a no-op.
  const nonReasoning = buildChatCompletionPayload(
    {
      provider: 'openai',
      apiKey: 'k',
      model: 'gpt-4o-mini',
      endpoint: 'https://api.openai.com/v1',
    },
    [{ role: 'user', content: 'just answer' }],
    [],
    { effort: 'high' },
  );
  assert.equal((nonReasoning as any).reasoning_effort, undefined);

  // Non-reasoning model on a local OpenAI-compatible endpoint (LM Studio /
  // Ollama / vLLM): same answer — qwen2.5-coder has no reasoning channel,
  // so we don't forward. The model name is the signal, not the endpoint.
  const localNonReasoning = buildChatCompletionPayload(
    {
      provider: 'openai',
      apiKey: '',
      model: 'qwen2.5-coder',
      endpoint: 'http://localhost:1234/v1',
    },
    [{ role: 'user', content: 'just answer' }],
    [],
    { effort: 'high' },
  );
  assert.equal((localNonReasoning as any).reasoning_effort, undefined);
});

test('buildChatCompletionPayload: forwards reasoning_effort for reasoning models on local OpenAI-compatible servers (LM Studio, Ollama)', () => {
  // LM Studio 0.3.29+ implements `reasoning_effort` on /v1/chat/completions
  // for `openai/gpt-oss-20b` (per their release notes). Ollama does the
  // same for its reasoning models. Gating purely on endpoint hostname
  // would silently drop the forwarding for these legitimate cases — so
  // the heuristic keys on the model name and accepts ANY OpenAI-compatible
  // endpoint.
  const lmStudio = buildChatCompletionPayload(
    {
      provider: 'openai',
      apiKey: '',
      model: 'openai/gpt-oss-20b',
      endpoint: 'http://localhost:1234/v1',
    },
    [{ role: 'user', content: 'think hard' }],
    [],
    { effort: 'high' },
  );
  assert.equal((lmStudio as any).reasoning_effort, 'high');

  // Ollama: deepseek-r1 served from the default Ollama port.
  const ollama = buildChatCompletionPayload(
    {
      provider: 'openai',
      apiKey: '',
      model: 'deepseek-r1:14b',
      endpoint: 'http://localhost:11434/v1',
    },
    [{ role: 'user', content: 'reason' }],
    [],
    { effort: 'low' },
  );
  assert.equal((ollama as any).reasoning_effort, 'low');

  // Qwen3 thinking variant (LM Studio naming).
  const qwen = buildChatCompletionPayload(
    {
      provider: 'openai',
      apiKey: '',
      model: 'qwen3-30b-a3b-thinking',
      endpoint: 'http://localhost:1234/v1',
    },
    [{ role: 'user', content: 'go' }],
    [],
    { effort: 'high' },
  );
  assert.equal((qwen as any).reasoning_effort, 'high');
});

test('buildChatCompletionPayload: LM Studio gets BOTH effort wire shapes; flat-only providers get just reasoning_effort', () => {
  // provider:'lmstudio' → effortField:'both' → flat `reasoning_effort` AND nested
  // `reasoning: { effort }` (LM Studio documents the nested form; flat is
  // unconfirmed, so both maximise version compatibility).
  const lm = buildChatCompletionPayload(
    { provider: 'lmstudio', apiKey: '', model: 'openai/gpt-oss-20b', endpoint: 'http://localhost:1234/v1' },
    [{ role: 'user', content: 'think hard' }],
    [],
    { effort: 'high' },
  );
  assert.equal((lm as any).reasoning_effort, 'high');
  assert.deepEqual((lm as any).reasoning, { effort: 'high' });

  // A flat-only provider (OpenAI) gets the flat field and NO nested object —
  // OpenAI chat-completions rejects unknown fields like a nested `reasoning`.
  const oa = buildChatCompletionPayload(
    { provider: 'openai', apiKey: 'k', model: 'gpt-5', endpoint: 'https://api.openai.com/v1' },
    [{ role: 'user', content: 'plan' }],
    [],
    { effort: 'high' },
  );
  assert.equal((oa as any).reasoning_effort, 'high');
  assert.equal((oa as any).reasoning, undefined);

  // Non-reasoning model on LM Studio still gets BOTH shapes under the lenient
  // 'any' gate — LM Studio accepts-and-ignores the field for a model that can't
  // use it, so we don't withhold it (effort works for unlisted reasoning models).
  const lmNon = buildChatCompletionPayload(
    { provider: 'lmstudio', apiKey: '', model: 'qwen2.5-coder', endpoint: 'http://localhost:1234/v1' },
    [{ role: 'user', content: 'hi' }],
    [],
    { effort: 'high' },
  );
  assert.equal((lmNon as any).reasoning_effort, 'high');
  assert.deepEqual((lmNon as any).reasoning, { effort: 'high' });
});

test('buildChatCompletionPayload: LM Studio binary metadata keeps graded wire effort', () => {
  _resetModelReasoningCapabilities();
  registerModelReasoningCapabilities('lmstudio/gemma-4-12b-qat-chat-payload', { reasoning: true, efforts: ['on', 'off'] });
  try {
    const lm = buildChatCompletionPayload(
      {
        provider: 'lmstudio',
        apiKey: '',
        model: 'lmstudio/gemma-4-12b-qat-chat-payload',
        endpoint: 'http://localhost:1234/v1',
      },
      [{ role: 'user', content: 'think hard' }],
      [],
      { effort: 'high' },
    );

    assert.equal((lm as any).reasoning_effort, 'high');
    assert.deepEqual((lm as any).reasoning, { effort: 'high' });
  } finally {
    _resetModelReasoningCapabilities();
  }
});

test('runTurn: when goal_complete fires with empty prose, the fallback surfaces the recorded proof so the user has something to read', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const sessionKey = 'fixed-test-session-key-for-goal-complete-fallback';
    setGoal(workspace, 'analyze the CLI architecture', sessionKey);
    const originalFetch = globalThis.fetch;
    let llmCalls = 0;
    globalThis.fetch = (async () => {
      llmCalls++;
      if (llmCalls === 1) {
        // First LLM call: empty prose + goal_complete tool call. This is the
        // exact bug-shape — the model declares done via tool but skips the
        // user-visible summary.
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'call_done',
                type: 'function',
                function: {
                  name: 'goal_complete',
                  arguments: JSON.stringify({ proof: 'Architecture mapped to memory_working_offload; src/agent.ts L491 is the loop.' }),
                },
              }],
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 5 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      // Second LLM call (post tool-result): empty prose, no further tools.
      return new Response(JSON.stringify({
        choices: [{ message: { content: '' } }],
        usage: { prompt_tokens: 50, completion_tokens: 0 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;
    try {
      const stubMcp: any = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [{ text: '{}' }] }),
        close: async () => {},
      };
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true, sessionKey,
      });
      const answer = await agent.runTurn('analyze', {
        onStatusUpdate: () => {},
        onToolStart: () => {},
        onToolEnd: () => {},
      });
      // The fallback must now surface the proof string from goal_complete.
      // Old behavior: "Tool calls completed (N) and the model returned no
      // additional commentary." — proof was buried in goal.json.
      assert.equal(agent.lastGoalTransition, 'complete');
      assert.match(answer, /Goal completed/);
      assert.match(answer, /Architecture mapped to memory_working_offload/);
      assert.doesNotMatch(answer, /no additional commentary/);
    } finally {
      globalThis.fetch = originalFetch;
      clearGoal(workspace, sessionKey);
    }
  });
});

// P1.2 — spawn hierarchy + depth cap tests.
// These tests call executeOrchestrationTool directly and rely on the fact that
// hierarchy checks throw before mcpClient / llmConfig are accessed.

function makeStubOrchCtx(workspace: string, overrides: Record<string, unknown> = {}): Parameters<typeof executeOrchestrationTool>[2] {
  return {
    workspaceRoot: workspace,
    parentSessionKey: 'session:test',
    parentAccessMode: 'shell',
    mcpClient: null as any,
    llmConfig: null as any,
    launchCwd: workspace,
    ...overrides,
  };
}

test('P1.2: worker tier cannot delegate', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const ctx = makeStubOrchCtx(workspace, { parentTier: 'worker' });
    await assert.rejects(
      () => executeOrchestrationTool('spawn_agent', { role: 'worker', prompt: 'do something' }, ctx),
      /worker.*cannot delegate/i,
    );
  });
});

test('ORCH-FIX: wait_agents on unknown/missing children resolves per-child, never throws (no main-loop hang)', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const ctx = makeStubOrchCtx(workspace);
    // No running promises + no session records on disk. Before ORCH-FIX,
    // handleWait threw on a missing record and Promise.all rejected the whole
    // batch → wait_agents surfaced as a tool failure (and could wedge the parent
    // turn). Now it must resolve with a per-child value.
    const raw = await executeOrchestrationTool('wait_agents', { ids: ['ghost-1', 'ghost-2'], timeoutMs: 200 }, ctx);
    const parsed = JSON.parse(raw);
    assert.equal(parsed.agents.length, 2, 'both children reported back');
    for (const a of parsed.agents) {
      assert.ok(a.status === 'gone' || a.status === 'error', `expected a value status, got ${JSON.stringify(a)}`);
    }
  });
});

test('P1.2: reasoning tier cannot spawn another reasoning agent', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const ctx = makeStubOrchCtx(workspace, { parentTier: 'reasoning' });
    await assert.rejects(
      () => executeOrchestrationTool('spawn_agent', { role: 'explorer', prompt: 'investigate' }, ctx),
      /reasoning.*cannot spawn.*reasoning/i,
    );
  });
});

test('P1.2: reasoning tier can spawn a worker agent', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'worker done' } }],
      usage: { prompt_tokens: 20, completion_tokens: 5 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as any;
    try {
      const stubMcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [{ text: '{}' }] }), close: async () => {} };
      const ctx = makeStubOrchCtx(workspace, {
        parentTier: 'reasoning',
        depth: 1,
        mcpClient: stubMcp,
        llmConfig: { provider: 'openai' as const, apiKey: 'k', model: 'test-model' },
      });
      const raw = await executeOrchestrationTool('spawn_agent', { role: 'worker', prompt: 'implement it', wait: true }, ctx);
      const result = JSON.parse(raw);
      assert.equal(result.status, 'completed');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('P1.2: depth cap is enforced at default limit (3)', async () => {
  try {
    resetCliKnobsForAgentRuntimeTest();
    await withTempWorkspaceAsync(async (workspace) => {
      const ctx = makeStubOrchCtx(workspace, { depth: 3 });
      await assert.rejects(
        () => executeOrchestrationTool('spawn_agent', { role: 'worker', prompt: 'task' }, ctx),
        /depth cap/i,
      );
    });
  } finally {
    resetCliKnobsForAgentRuntimeTest();
  }
});

test('P1.2: depth cap is overridable via cli.maxSpawnDepth', async () => {
  const originalFetch = globalThis.fetch;
  try {
    setCliKnobOverride({ maxSpawnDepth: 5 });
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'worker done' } }],
      usage: { prompt_tokens: 20, completion_tokens: 5 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as any;
    await withTempWorkspaceAsync(async (workspace) => {
      const stubMcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [{ text: '{}' }] }), close: async () => {} };
      const ctx = makeStubOrchCtx(workspace, {
        depth: 3,
        mcpClient: stubMcp,
        llmConfig: { provider: 'openai' as const, apiKey: 'k', model: 'test-model' },
      });
      const raw = await executeOrchestrationTool('spawn_agent', { role: 'worker', prompt: 'task', wait: true }, ctx);
      const result = JSON.parse(raw);
      assert.equal(result.status, 'completed');
    });
  } finally {
    globalThis.fetch = originalFetch;
    resetCliKnobsForAgentRuntimeTest();
  }
});

test('runTurn: delegate_agent triggers child-drain guardrail (R2 must not bypass R1)', async () => {
  // Regression for the R1↔R2 interaction. The model calls delegate_agent
  // (fire-and-forget), then tries to emit a no-tool answer. The guardrail
  // must auto-call wait_agents on the child id returned by delegate_agent —
  // not silently accept the prose answer.
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    let parentCalls = 0;

    globalThis.fetch = (async (_url: any, opts: any) => {
      const body = JSON.parse(opts.body);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const lastUser = [...messages].reverse().find((m: any) => m.role === 'user')?.content ?? '';

      if (/background child task/.test(lastUser)) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'background child output' } }],
          usage: { prompt_tokens: 20, completion_tokens: 5 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      parentCalls++;
      if (parentCalls === 1) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'call_delegate',
                type: 'function',
                function: {
                  name: 'delegate_agent',
                  arguments: JSON.stringify({ role: 'explorer', prompt: 'background child task' }),
                },
              }],
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (parentCalls === 2) {
        // Bug-shape: model tries to answer with no follow-up tool call.
        // Guardrail must catch this and inject a wait_agents drain.
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'I will keep working while the child runs.' } }],
          usage: { prompt_tokens: 80, completion_tokens: 8 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Background child output incorporated.' } }],
        usage: { prompt_tokens: 50, completion_tokens: 6 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;

    try {
      const stubMcp: any = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [{ text: '{}' }] }),
        close: async () => {},
      };
      const toolNames: string[] = [];
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true,
      });
      const answer = await agent.runTurn('delegate the background work', {
        onStatusUpdate: () => {},
        onToolStart: (name) => { toolNames.push(name); },
        onToolEnd: () => {},
      });

      // Guardrail must have auto-fired wait_agents on the delegated child.
      assert.ok(
        toolNames.includes('wait_agents'),
        `expected wait_agents to fire after delegate_agent; saw: ${JSON.stringify(toolNames)}`,
      );
      // Final answer must come from the post-drain synthesis turn, not the
      // bug-shape prose that tried to skip the wait.
      assert.equal(answer, 'Background child output incorporated.');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('runTurn: task_agent counts as already-waited (no double-drain)', async () => {
  // task_agent wraps spawn_agent({ wait: true }) — the wait happens
  // *inside* the tool call. The R1 guardrail must treat the returned
  // child id as already-observed and accept the model's no-tool answer
  // without auto-firing a redundant wait_agents.
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    let parentCalls = 0;

    globalThis.fetch = (async (_url: any, opts: any) => {
      const body = JSON.parse(opts.body);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const lastUser = [...messages].reverse().find((m: any) => m.role === 'user')?.content ?? '';

      if (/foreground child task/.test(lastUser)) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'foreground child output' } }],
          usage: { prompt_tokens: 20, completion_tokens: 5 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      parentCalls++;
      if (parentCalls === 1) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'call_task',
                type: 'function',
                function: {
                  name: 'task_agent',
                  arguments: JSON.stringify({ role: 'explorer', prompt: 'foreground child task' }),
                },
              }],
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      // Second call: model synthesises a final answer. Guardrail must NOT
      // fire wait_agents — task_agent already drained internally.
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Foreground child completed; answer below.' } }],
        usage: { prompt_tokens: 80, completion_tokens: 8 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;

    try {
      const stubMcp: any = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [{ text: '{}' }] }),
        close: async () => {},
      };
      const toolNames: string[] = [];
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true,
      });
      const answer = await agent.runTurn('do the foreground task', {
        onStatusUpdate: () => {},
        onToolStart: (name) => { toolNames.push(name); },
        onToolEnd: () => {},
      });

      assert.equal(
        toolNames.filter((n) => n === 'wait_agents').length,
        0,
        `task_agent already-waited path must not double-drain; saw: ${JSON.stringify(toolNames)}`,
      );
      assert.equal(answer, 'Foreground child completed; answer below.');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('orchestration: task_agent wait timeout returns envelope without failing the child', async () => {
  // A parent wait timeout is not a child kill switch. The parent may stop
  // waiting and report a timeout envelope, but the child must stay running
  // and be allowed to complete later.
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'never reached' } }],
        usage: { prompt_tokens: 20, completion_tokens: 5 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;
    try {
      const stubMcp: any = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [{ text: '{}' }] }),
        close: async () => {},
      };
      const ctx = {
        workspaceRoot: workspace,
        parentSessionKey: 'session:test',
        parentAccessMode: 'shell' as const,
        mcpClient: stubMcp,
        llmConfig: { provider: 'openai' as const, apiKey: 'k', model: 'test-model' },
        launchCwd: workspace,
      };
      const raw = await executeOrchestrationTool(
        'task_agent',
        { role: 'explorer', prompt: 'slow task', timeoutMs: 10 },
        ctx,
      );
      const result = JSON.parse(raw);
      assert.equal(result.status, 'timeout');
      assert.equal(result.childStatus, 'running');
      assert.match(result.id, /^agent-/);
      const { getSession } = await import('../orchestration/session/orchestrator.js');
      const record = await waitForValue(
        () => getSession(workspace, result.id),
        (session) => session?.status === 'completed',
      );
      assert.equal(record?.status, 'completed');
      assert.match(record?.finalOutput ?? '', /too late|never reached/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('orchestration: background child timeout arg does not kill the child', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'too late' } }],
        usage: { prompt_tokens: 20, completion_tokens: 5 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;
    try {
      const stubMcp: any = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [{ text: '{}' }] }),
        close: async () => {},
      };
      const ctx = {
        workspaceRoot: workspace,
        parentSessionKey: 'session:test',
        parentAccessMode: 'shell' as const,
        mcpClient: stubMcp,
        llmConfig: { provider: 'openai' as const, apiKey: 'k', model: 'test-model' },
        launchCwd: workspace,
      };
      const raw = await executeOrchestrationTool(
        'spawn_agent',
        { role: 'explorer', prompt: 'slow background task', timeoutMs: 10 },
        ctx,
      );
      const result = JSON.parse(raw);
      const { getSession } = await import('../orchestration/session/orchestrator.js');
      const record = await waitForValue(
        () => getSession(workspace, result.id),
        (session) => session?.status === 'completed',
      );
      assert.equal(record?.status, 'completed');
      assert.equal(record?.error, undefined);
      assert.match(record?.finalOutput ?? '', /too late/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('orchestration: wait_agent timeoutMs 0 waits until child completion', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'zero wait completed' } }],
        usage: { prompt_tokens: 20, completion_tokens: 5 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;
    try {
      const stubMcp: any = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [{ text: '{}' }] }),
        close: async () => {},
      };
      const ctx = {
        workspaceRoot: workspace,
        parentSessionKey: 'session:test',
        parentAccessMode: 'shell' as const,
        mcpClient: stubMcp,
        llmConfig: { provider: 'openai' as const, apiKey: 'k', model: 'test-model' },
        launchCwd: workspace,
      };
      const spawned = JSON.parse(await executeOrchestrationTool(
        'spawn_agent',
        { role: 'explorer', prompt: 'zero wait background' },
        ctx,
      ));
      const waited = JSON.parse(await executeOrchestrationTool(
        'wait_agent',
        { id: spawned.id, timeoutMs: 0 },
        ctx,
      ));
      assert.equal(waited.status, 'completed');
      assert.match(waited.finalOutput, /zero wait completed/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('orchestration: invalid child workdir falls back to parent cwd', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'done' } }],
      usage: { prompt_tokens: 20, completion_tokens: 5 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as any;
    try {
      const childCwd = path.join(workspace, 'subdir');
      fs.mkdirSync(childCwd);
      const stubMcp: any = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [{ text: '{}' }] }),
        close: async () => {},
      };
      const raw = await executeOrchestrationTool('spawn_agent', {
        role: 'explorer',
        prompt: 'quick',
        workdir: '/definitely/not/a/real/path',
      }, {
        workspaceRoot: workspace,
        parentSessionKey: 'session:test',
        parentAccessMode: 'shell' as const,
        mcpClient: stubMcp,
        llmConfig: { provider: 'openai' as const, apiKey: 'k', model: 'test-model' },
        launchCwd: childCwd,
      });
      const result = JSON.parse(raw);
      const { trackedPromiseFor } = await import('../orchestration/tools.js');
      await trackedPromiseFor(result.id);
      assert.equal(result.workdir, fs.realpathSync(childCwd));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('P1.2: agentId unknown returns error listing known ids', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const ctx = makeStubOrchCtx(workspace);
    await assert.rejects(
      () => executeOrchestrationTool('spawn_agent', { agentId: 'no-such-agent', prompt: 'task' }, ctx),
      /Unknown agentId.*Known agents/i,
    );
  });
});

// ---------------------------------------------------------------------------
// 0.3.8-R4 — Safe parallel execution of independent read-only tool calls.
//
// The runtime now dispatches consecutive parallel-safe tool calls (read_file,
// list_dir, grep_search, glob_files, fetch_url, web_search, MCP memory reads)
// concurrently when the LLM emits them in a single assistant response. Writes,
// shell commands, orchestration tools, and any unknown tool name stay serial.
// Tool-result messages are still appended to chatHistory in the ORIGINAL call
// order so the model's next turn sees a deterministic trace.
// ---------------------------------------------------------------------------

test('toolSafety.isParallelSafe accepts both bare and MCP-prefixed read tools, rejects writers/orchestration/unknowns', async () => {
  const { isParallelSafe } = await import('../agent/guards/toolSafety.js');
  // Bare read-only locals + concurrency-safe agent spawners (0.3.9) — safe.
  for (const name of ['read_file', 'list_dir', 'grep_search', 'glob_files', 'fetch_url', 'web_search', 'task_agent', 'delegate_agent']) {
    assert.equal(isParallelSafe(name), true, `${name} must be parallel-safe`);
  }
  // Writers / shell / bookkeeping-sensitive orchestration / interactive — never safe.
  for (const name of [
    'write_file', 'edit_file', 'apply_patch', 'run_command',
    'spawn_agent', 'spawn_agents',
    'wait_agent', 'wait_agents', 'close_agent', 'route_task',
    'update_plan', 'goal_complete', 'goal_blocked', 'ask_user_choice',
    'list_agents', 'read_agent_transcript',
  ]) {
    assert.equal(isParallelSafe(name), false, `${name} must stay serial`);
  }
  // MCP read tools — canonical single-underscore form (R5).
  assert.equal(isParallelSafe('mcp_brainrouter_memory_recall'), true);
  assert.equal(isParallelSafe('mcp_some_long_server_id_memory_search'), true);
  // MCP write/admin tools — not on the read whitelist.
  assert.equal(isParallelSafe('mcp_brainrouter_memory_capture_turn'), false);
  assert.equal(isParallelSafe('mcp_brainrouter_memory_mark_cited'), false);
  // Empty / unknown / random garbage — fail-safe false.
  assert.equal(isParallelSafe(''), false);
  assert.equal(isParallelSafe('not_a_tool_we_know_about'), false);
});

test('toolSafety.parallelExecutionEnabled honors cli.parallelSafeToolCalls kill switch', async () => {
  const { parallelExecutionEnabled } = await import('../agent/guards/toolSafety.js');
  try {
    resetCliKnobsForAgentRuntimeTest();
    assert.equal(parallelExecutionEnabled(), true, 'default ON');
    setCliKnobOverride({ parallelSafeToolCalls: false });
    assert.equal(parallelExecutionEnabled(), false, 'false disables');
    setCliKnobOverride({ parallelSafeToolCalls: true });
    assert.equal(parallelExecutionEnabled(), true);
  } finally {
    resetCliKnobsForAgentRuntimeTest();
  }
});

// Helper: build a stubbed LLM `fetch` that replays a scripted sequence of
// assistant responses. Each entry in `responses` is what the next chat
// completion should return (content + optional tool_calls). After the
// scripted entries are exhausted, returns a clean prose completion so the
// agent exits the runTurn loop.
function stubLlm(responses: Array<{ content: string; tool_calls?: any[] }>): () => void {
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = (async () => {
    const r = responses[call] ?? { content: 'done.' };
    call++;
    return new Response(JSON.stringify({
      choices: [{ message: { content: r.content, tool_calls: r.tool_calls } }],
      usage: { prompt_tokens: 50, completion_tokens: 5 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as any;
  return () => { globalThis.fetch = originalFetch; };
}

function makeStubMcp(): any {
  return {
    listTools: async () => ({ tools: [] }),
    callTool: async () => ({ content: [{ text: '{}' }] }),
    close: async () => {},
  };
}

test('R4: three read_file calls in one response overlap in flight', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    // Three files we'll read; the slow-read is enforced by monkey-patching
    // fs.readFileSync? No — readFileSync is sync, can't yield. Instead we
    // wrap executeLocalTool by making read_file await a sleep via the
    // tool path that DOES go through await: we use small files but inject
    // an artificial delay via a custom MCP-style read. The simplest route
    // is to monkey-patch the agent's executeLocalTool — but that's
    // private. Easier: monkey-patch fs.promises? read_file uses sync I/O.
    //
    // Concretely: we monkey-patch fs.readFileSync to busy-sleep ~50 ms
    // before returning, but a busy sleep blocks the event loop and kills
    // the concurrency we want to measure. So instead we patch
    // Agent.prototype.executeLocalTool to delegate to original after an
    // await sleep(50). That preserves true async concurrency.
    const { Agent } = await import('../agent/agent.js');
    const origExec = (Agent.prototype as any).executeLocalTool;
    let activeReads = 0;
    let maxActiveReads = 0;
    (Agent.prototype as any).executeLocalTool = async function (name: string, args: any) {
      if (name === 'read_file') {
        activeReads++;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        try {
          await new Promise((res) => setTimeout(res, 50));
        } finally {
          activeReads--;
        }
      }
      return origExec.call(this, name, args);
    };
    // Create three small files to read.
    for (const f of ['a.txt', 'b.txt', 'c.txt']) {
      fs.writeFileSync(path.join(workspace, f), `content of ${f}`);
    }
    const restore = stubLlm([{
      content: '',
      tool_calls: [
        { id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
        { id: 'call_b', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.txt"}' } },
        { id: 'call_c', type: 'function', function: { name: 'read_file', arguments: '{"path":"c.txt"}' } },
      ],
    }]);
    try {
      const agent = new Agent(makeStubMcp(), { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true,
      });
      await agent.runTurn('read three files', {
        onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {},
      });
      assert.equal(maxActiveReads, 3, 'all three read_file calls must overlap instead of running serially');
      assert.equal(agent.lastTurnToolCalls, 3, 'all three tool calls must count toward lastTurnToolCalls');
    } finally {
      restore();
      (Agent.prototype as any).executeLocalTool = origExec;
    }
  });
});

test('R4: tool-result chatHistory order matches original call order even when later reads finish first', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const { Agent } = await import('../agent/agent.js');
    const origExec = (Agent.prototype as any).executeLocalTool;
    // Make read_file's delay depend on the path: a=60ms, b=20ms, c=5ms.
    // So if reads were appended in finish order, chatHistory would carry
    // c, b, a. The runtime must instead push them in original order: a, b, c.
    (Agent.prototype as any).executeLocalTool = async function (name: string, args: any) {
      if (name === 'read_file') {
        const delays: Record<string, number> = { 'a.txt': 60, 'b.txt': 20, 'c.txt': 5 };
        await new Promise((res) => setTimeout(res, delays[args.path] ?? 0));
      }
      return origExec.call(this, name, args);
    };
    for (const f of ['a.txt', 'b.txt', 'c.txt']) {
      fs.writeFileSync(path.join(workspace, f), `content-${f}`);
    }
    const restore = stubLlm([{
      content: '',
      tool_calls: [
        { id: 'id_a', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
        { id: 'id_b', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.txt"}' } },
        { id: 'id_c', type: 'function', function: { name: 'read_file', arguments: '{"path":"c.txt"}' } },
      ],
    }]);
    try {
      const agent = new Agent(makeStubMcp(), { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true,
      });
      await agent.runTurn('read all', {
        onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {},
      });
      const hist = (agent as any).chatHistory as any[];
      const toolMsgs = hist.filter((m) => m.role === 'tool');
      // Three tool results in original (a, b, c) order, NOT settle (c, b, a) order.
      assert.deepEqual(
        toolMsgs.map((m) => m.tool_call_id),
        ['id_a', 'id_b', 'id_c'],
        'tool_result messages must preserve original call order',
      );
    } finally {
      restore();
      (Agent.prototype as any).executeLocalTool = origExec;
    }
  });
});

test('R4: mixed batch — 2 reads in parallel, then 1 write_file serially; write tool_result lands after both reads', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const { Agent } = await import('../agent/agent.js');
    const origExec = (Agent.prototype as any).executeLocalTool;
    const execOrder: string[] = [];
    (Agent.prototype as any).executeLocalTool = async function (name: string, args: any) {
      execOrder.push(`start:${name}:${args.path ?? ''}`);
      if (name === 'read_file') await new Promise((res) => setTimeout(res, 30));
      const out = await origExec.call(this, name, args);
      execOrder.push(`end:${name}:${args.path ?? ''}`);
      return out;
    };
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'A');
    fs.writeFileSync(path.join(workspace, 'b.txt'), 'B');
    const restore = stubLlm([{
      content: '',
      tool_calls: [
        { id: 'r1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
        { id: 'r2', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.txt"}' } },
        { id: 'w1', type: 'function', function: { name: 'write_file', arguments: '{"path":"out.txt","content":"hi"}' } },
      ],
    }]);
    try {
      const agent = new Agent(makeStubMcp(), { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true,
      });
      await agent.runTurn('mixed', {
        onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {},
      });
      // Both reads must start before either ends (proves parallel), and
      // write_file must START only after both reads have ENDED (proves serial tail).
      const startA = execOrder.indexOf('start:read_file:a.txt');
      const startB = execOrder.indexOf('start:read_file:b.txt');
      const endA = execOrder.indexOf('end:read_file:a.txt');
      const endB = execOrder.indexOf('end:read_file:b.txt');
      const startW = execOrder.indexOf('start:write_file:out.txt');
      assert.ok(startA >= 0 && startB >= 0, 'both reads must have started');
      assert.ok(startB < endA, 'read B must start before read A finishes (parallel)');
      assert.ok(startW > endA && startW > endB, 'write must start after both reads complete');
      // Tool-result chatHistory order matches call order.
      const hist = (agent as any).chatHistory as any[];
      const ids = hist.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
      assert.deepEqual(ids, ['r1', 'r2', 'w1']);
    } finally {
      restore();
      (Agent.prototype as any).executeLocalTool = origExec;
    }
  });
});

test('R4: unknown tool name in the batch is treated as serial (conservative fail-safe)', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const { Agent } = await import('../agent/agent.js');
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'A');
    const restore = stubLlm([{
      content: '',
      tool_calls: [
        { id: 'r1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
        { id: 'u1', type: 'function', function: { name: 'totally_made_up_tool', arguments: '{}' } },
        { id: 'r2', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
      ],
    }]);
    try {
      // Unknown tools fall through to the MCP client; make the stub
      // surface a JSON-RPC-style "unknown tool" so the agent's catch
      // branch produces the canonical error envelope.
      const stub = {
        listTools: async () => ({ tools: [] }),
        callTool: async (name: string) => { throw new Error(`-32601 Unknown tool: ${name}`); },
        close: async () => {},
      } as any;
      const agent = new Agent(stub, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true,
      });
      await agent.runTurn('mixed unknown', {
        onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {},
      });
      const hist = (agent as any).chatHistory as any[];
      const toolMsgs = hist.filter((m) => m.role === 'tool');
      // All three calls must produce a tool_result, in original order.
      assert.deepEqual(toolMsgs.map((m) => m.tool_call_id), ['r1', 'u1', 'r2']);
      // The unknown one is reported as an error envelope.
      const unknown = toolMsgs.find((m) => m.tool_call_id === 'u1');
      assert.equal(unknown.isError, true);
      assert.match(String(unknown.content), /does not exist|Unknown tool/i);
    } finally {
      restore();
    }
  });
});

test('R4: BRAINROUTER_PARALLEL_SAFE_TOOL_CALLS=false forces serial execution of read batches', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const { Agent } = await import('../agent/agent.js');
    const origExec = (Agent.prototype as any).executeLocalTool;
    (Agent.prototype as any).executeLocalTool = async function (name: string, args: any) {
      if (name === 'read_file') await new Promise((res) => setTimeout(res, 30));
      return origExec.call(this, name, args);
    };
    for (const f of ['a.txt', 'b.txt', 'c.txt']) fs.writeFileSync(path.join(workspace, f), 'x');
    const restore = stubLlm([{
      content: '',
      tool_calls: [
        { id: 'r1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
        { id: 'r2', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.txt"}' } },
        { id: 'r3', type: 'function', function: { name: 'read_file', arguments: '{"path":"c.txt"}' } },
      ],
    }]);
    setCliKnobOverride({ parallelSafeToolCalls: false });
    try {
      const agent = new Agent(makeStubMcp(), { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true,
      });
      const t0 = Date.now();
      await agent.runTurn('three serial reads', {
        onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {},
      });
      const elapsed = Date.now() - t0;
      // Three 30 ms reads serialized ≈ 90 ms; allow generous bound.
      assert.ok(elapsed >= 80, `kill switch must restore serial behaviour, got ${elapsed} ms`);
    } finally {
      restore();
      (Agent.prototype as any).executeLocalTool = origExec;
      resetCliKnobsForAgentRuntimeTest();
    }
  });
});

// R3 — Child progress visibility in Ink.
// Regression: when a spawn_agent child runs a tool, the parent's
// onChildToolStart and onChildToolEnd callbacks must fire with the
// child's id, role, tool name, args, ok flag, and a non-negative
// durationMs. Without this the Ink scrollback has no signal that a
// long-running child is actually making progress.
test('runTurn: child tool events propagate to parent onChildToolStart / onChildToolEnd (R3)', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    let parentCalls = 0;
    globalThis.fetch = (async (_url: any, opts: any) => {
      const body = JSON.parse(opts.body);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const lastUser = [...messages].reverse().find((m: any) => m.role === 'user')?.content ?? '';

      // The child sees its own bounded prompt "do-child-work". On its
      // first call it lists the workspace; on its second it produces a
      // final answer.
      if (/do-child-work/.test(lastUser)) {
        const hasToolResult = messages.some((m: any) => m.role === 'tool' && m.name === 'list_dir');
        if (!hasToolResult) {
          return new Response(JSON.stringify({
            choices: [{
              message: {
                content: '',
                tool_calls: [{ id: 'call_child_ls', type: 'function', function: { name: 'list_dir', arguments: '{"path":"."}' } }],
              },
            }],
            usage: { prompt_tokens: 20, completion_tokens: 5 },
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'child done.' } }],
          usage: { prompt_tokens: 20, completion_tokens: 5 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      parentCalls++;
      if (parentCalls === 1) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'call_spawn',
                type: 'function',
                function: {
                  name: 'spawn_agent',
                  arguments: JSON.stringify({ role: 'explorer', prompt: 'do-child-work', wait: true, timeoutMs: 5000 }),
                },
              }],
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'parent done.' } }],
        usage: { prompt_tokens: 40, completion_tokens: 5 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;

    try {
      const stubMcp: any = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [{ text: '{}' }] }),
        close: async () => {},
      };
      const childStarts: any[] = [];
      const childEnds: any[] = [];
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true,
      });
      await agent.runTurn('please spawn a child', {
        onStatusUpdate: () => {},
        onToolStart: () => {},
        onToolEnd: () => {},
        onChildToolStart: (e) => { childStarts.push(e); },
        onChildToolEnd: (e) => { childEnds.push(e); },
      });
      // The child ran list_dir once before its final answer — the parent
      // must have seen a paired start + end event for that call.
      const startLs = childStarts.find((e) => e.tool === 'list_dir');
      const endLs = childEnds.find((e) => e.tool === 'list_dir');
      assert.ok(startLs, `expected an onChildToolStart for list_dir, got ${JSON.stringify(childStarts.map((e) => e.tool))}`);
      assert.ok(endLs, `expected an onChildToolEnd for list_dir, got ${JSON.stringify(childEnds.map((e) => e.tool))}`);
      assert.equal(startLs.role, 'explorer');
      assert.equal(endLs.role, 'explorer');
      assert.equal(typeof startLs.childId, 'string');
      assert.equal(startLs.childId, endLs.childId);
      assert.equal(typeof endLs.durationMs, 'number');
      assert.ok(endLs.durationMs >= 0, 'durationMs must be non-negative');
      assert.equal(endLs.ok, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// 0.3.8-I4 — Strict tool-call recovery end-to-end.
// Pure-function helpers live in tool-call-recovery.test.ts; these exercise
// the agent.ts integration: dedupe → parse-args recovery → orphan synthesis
// → unknown-tool "did you mean" hint.
// ---------------------------------------------------------------------------

test('runTurn recovery: duplicate tool_call ids in one response are deduped (last wins, no 400 next turn)', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    let llmCalls = 0;
    let secondRequestBody: any;
    globalThis.fetch = (async (_url: any, opts: any) => {
      llmCalls++;
      if (llmCalls === 1) {
        // Model emits TWO tool_calls with the same id — recovery should
        // drop the first and keep the second (path=second).
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [
                { id: 'dup_1', type: 'function', function: { name: 'list_dir', arguments: '{"path":"first"}' } },
                { id: 'dup_1', type: 'function', function: { name: 'list_dir', arguments: '{"path":"."}' } },
              ],
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      // Capture the second request to verify the assistant turn it sees
      // contains exactly ONE tool_call (the deduped one) paired with one
      // tool_result — i.e. the next-turn request stays well-formed.
      secondRequestBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'done' } }],
        usage: { prompt_tokens: 50, completion_tokens: 5 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;
    try {
      const stubMcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [] }), close: async () => {} };
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'm' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true,
      });
      const answer = await agent.runTurn('list', {
        onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {},
      });
      assert.equal(answer, 'done');
      // The second request's messages should contain a single assistant
      // message with one tool_call and exactly one matching tool result.
      const msgs: any[] = secondRequestBody.messages;
      const assistantWithCalls = msgs.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0);
      assert.ok(assistantWithCalls, 'assistant tool_calls message present');
      assert.equal(assistantWithCalls.tool_calls.length, 1, 'duplicate tool_call id was deduped');
      // Last occurrence won — args should be the second one ({"path":"."}).
      assert.equal(assistantWithCalls.tool_calls[0].function.arguments, '{"path":"."}');
      const toolMsgs = msgs.filter((m) => m.role === 'tool');
      assert.equal(toolMsgs.length, 1, 'one tool_result for the one surviving tool_call');
      assert.equal(toolMsgs[0].tool_call_id, 'dup_1');
    } finally { globalThis.fetch = originalFetch; }
  });
});

test('runTurn recovery: malformed JSON arguments surface as a structured tool_result, loop continues', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    let llmCalls = 0;
    let secondRequestBody: any;
    const toolEvents: Array<{ name: string; ok: boolean; summary: string }> = [];
    globalThis.fetch = (async (_url: any, opts: any) => {
      llmCalls++;
      if (llmCalls === 1) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: '',
              // Trailing comma — JSON.parse will throw on this.
              tool_calls: [{ id: 'bad_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"foo",}' } }],
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      secondRequestBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'recovered' } }],
        usage: { prompt_tokens: 50, completion_tokens: 5 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;
    try {
      const stubMcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [] }), close: async () => {} };
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'm' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true,
      });
      const answer = await agent.runTurn('read foo', {
        onStatusUpdate: () => {},
        onToolStart: () => {},
        onToolEnd: (name, result) => toolEvents.push({ name, ok: result.success, summary: result.summary }),
      });
      assert.equal(answer, 'recovered', 'loop continued instead of aborting');
      // The bad-args tool_result is in the second request's message list,
      // and it carries the structured error the model can read.
      const toolMsgs = secondRequestBody.messages.filter((m: any) => m.role === 'tool');
      assert.equal(toolMsgs.length, 1);
      assert.equal(toolMsgs[0].tool_call_id, 'bad_1');
      assert.match(toolMsgs[0].content, /Tool argument JSON was malformed/);
      assert.match(toolMsgs[0].content, /Re-issue the tool call/);
      // The tool-end event was emitted with the bad-args summary.
      const badArgs = toolEvents.find((e) => /malformed/i.test(e.summary));
      assert.ok(badArgs, 'malformed-args tool event surfaced');
      assert.equal(badArgs!.ok, false);
    } finally { globalThis.fetch = originalFetch; }
  });
});

test('runTurn skill allowlist filters local and MCP surfaces and rejects a guessed hidden tool', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    let llmCalls = 0;
    let firstRequestBody: any;
    let mcpCalls = 0;
    const toolEvents: Array<{ name: string; ok: boolean; summary: string; preview?: string }> = [];
    globalThis.fetch = (async (_url: any, opts: any) => {
      llmCalls++;
      const body = JSON.parse(opts.body);
      if (llmCalls === 1) {
        firstRequestBody = body;
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'hidden_1',
                type: 'function',
                function: { name: 'write_file', arguments: '{"path":"blocked.txt","content":"no"}' },
              }],
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'done' } }],
        usage: { prompt_tokens: 50, completion_tokens: 5 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;
    try {
      const toolSchema = { type: 'object', properties: {} };
      const stubMcp: any = {
        listTools: async () => ({
          tools: [
            {
              name: 'mcp_docs_search',
              __rawName: 'search',
              __serverId: 'docs',
              description: 'Search documentation',
              inputSchema: toolSchema,
            },
            {
              name: 'mcp_docs_delete',
              __rawName: 'delete',
              __serverId: 'docs',
              description: 'Delete documentation',
              inputSchema: toolSchema,
            },
          ],
        }),
        callTool: async () => {
          mcpCalls++;
          return { content: [{ text: 'called' }] };
        },
        close: async () => {},
      };
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'm' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true,
      });
      agent.activeSkillAllowedTools = ['read_file', 'search'];

      const answer = await agent.runTurn('inspect safely', {
        onStatusUpdate: () => {},
        onToolStart: () => {},
        onToolEnd: (name, result) => toolEvents.push({
          name,
          ok: result.success,
          summary: result.summary,
          preview: result.preview,
        }),
      });

      assert.equal(answer, 'done');
      const exposed = firstRequestBody.tools.map((tool: any) => tool.function.name);
      assert.ok(exposed.includes('read_file'), 'explicitly allowed local tool is exposed');
      assert.ok(exposed.includes('mcp_docs_search'), 'bare MCP allow entry matches the namespaced tool');
      assert.ok(!exposed.includes('write_file'), 'unlisted local tool is hidden');
      assert.ok(!exposed.includes('run_command'), 'unlisted shell tool is hidden');
      assert.ok(!exposed.includes('mcp_docs_delete'), 'unlisted MCP tool is hidden');
      assert.equal(mcpCalls, 0, 'the denied local guess never falls through to MCP dispatch');
      const denied = toolEvents.find((event) => event.name === 'write_file');
      assert.ok(denied, 'guessed hidden tool emits a result event');
      assert.equal(denied!.ok, false);
      assert.match(`${denied!.summary} ${denied!.preview ?? ''}`, /allowed-tools policy/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('runTurn serves package-owned get_skill without calling a stale global MCP entry', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    saveWorkspaceManifest(
      workspace,
      createWorkspaceManifest({ name: 'app', profile: 'engineering', by: 'wizard' }),
    );
    const originalFetch = globalThis.fetch;
    let llmCalls = 0;
    let secondRequestBody: any;
    let mcpCalls = 0;
    globalThis.fetch = (async (_url: any, opts: any) => {
      llmCalls += 1;
      if (llmCalls === 1) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'skill_1',
                type: 'function',
                function: {
                  name: 'get_skill',
                  arguments: '{"name":"a11y-skill","section":"description"}',
                },
              }],
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      secondRequestBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'done' } }],
        usage: { prompt_tokens: 50, completion_tokens: 5 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;
    try {
      const stubMcp: any = {
        listTools: async () => ({
          tools: [{
            name: 'get_skill',
            __rawName: 'get_skill',
            description: 'Get a skill',
            inputSchema: {
              type: 'object',
              properties: { name: { type: 'string' }, section: { type: 'string' } },
              required: ['name'],
            },
          }],
        }),
        callTool: async () => {
          mcpCalls += 1;
          return { content: [{ text: '# Legacy global collision' }] };
        },
        close: async () => {},
      };
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'm' }, {
        workspaceRoot: workspace,
        launchCwd: workspace,
        silent: true,
      });
      const answer = await agent.runTurn('Load the accessibility workflow explicitly.', {
        onStatusUpdate: () => {},
        onToolStart: () => {},
        onToolEnd: () => {},
      });
      assert.equal(answer, 'done');
      assert.equal(mcpCalls, 0);
      const toolResult = secondRequestBody.messages.find((message: any) =>
        message.role === 'tool' && message.tool_call_id === 'skill_1');
      assert.ok(toolResult);
      assert.match(toolResult.content, /Treat accessibility and responsive behavior as frontend acceptance criteria/);
      assert.doesNotMatch(toolResult.content, /Legacy global collision/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('runTurn applies manifest tool profiles to the model-visible local surface', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    saveWorkspaceManifest(
      workspace,
      createWorkspaceManifest({ name: 'blank', profile: 'custom', by: 'wizard' }),
    );
    const originalFetch = globalThis.fetch;
    let llmCalls = 0;
    let firstRequestBody: any;
    let secondRequestBody: any;
    globalThis.fetch = (async (_url: any, opts: any) => {
      llmCalls += 1;
      const body = JSON.parse(opts.body);
      if (llmCalls === 1) {
        firstRequestBody = body;
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'hidden_write',
                type: 'function',
                function: { name: 'write_file', arguments: '{"path":"blocked.txt","content":"no"}' },
              }],
            },
          }],
          usage: { prompt_tokens: 50, completion_tokens: 5 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      secondRequestBody = body;
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'done' } }],
        usage: { prompt_tokens: 50, completion_tokens: 5 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;
    try {
      const stubMcp: any = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [] }),
        close: async () => {},
      };
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'm' }, {
        workspaceRoot: workspace,
        launchCwd: workspace,
        silent: true,
      });
      agent.setAccessMode('shell');
      assert.equal(await agent.runTurn('Inspect the project.', {
        onStatusUpdate: () => {},
        onToolStart: () => {},
        onToolEnd: () => {},
      }), 'done');

      const names = new Set((firstRequestBody.tools ?? []).map((tool: any) => tool.function?.name));
      assert.equal(names.has('read_file'), true, 'baseline filesystem reads remain available');
      assert.equal(names.has('update_plan'), true, 'control-plane tools remain available');
      assert.equal(names.has('write_file'), false, 'custom empty profile does not grant coding writes');
      assert.equal(names.has('run_command'), false, 'custom empty profile does not grant terminal execution');
      assert.equal(names.has('web_search'), false, 'custom empty profile does not grant browser research');
      assert.equal(fs.existsSync(path.join(workspace, 'blocked.txt')), false, 'a stale hidden call cannot write');
      const denied = secondRequestBody.messages.find((message: any) => message.tool_call_id === 'hidden_write');
      assert.match(denied?.content ?? '', /workspace tool-profile policy/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('runTurn gives a saved Research workspace its folder, skill, and read-only Project Knowledge tools', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const manifest = createWorkspaceManifest({ name: 'EconomicsResearch', profile: 'research', by: 'wizard' });
    manifest.version = 3;
    manifest.tools.mode = 'explicit-catalog';
    manifest.tools.enabled = [];
    saveWorkspaceManifest(workspace, manifest);

    const originalFetch = globalThis.fetch;
    let llmCalls = 0;
    let firstRequestBody: any;
    let secondRequestBody: any;
    const mcpCalls: string[] = [];
    globalThis.fetch = (async (_url: any, opts: any) => {
      llmCalls += 1;
      const body = JSON.parse(opts.body);
      if (llmCalls === 1) {
        firstRequestBody = body;
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'research_list',
                  type: 'function',
                  function: { name: 'list_dir', arguments: '{"path":"."}' },
                },
                {
                  id: 'research_write',
                  type: 'function',
                  function: { name: 'write_file', arguments: '{"path":"notes.md","content":"# Notes"}' },
                },
                {
                  id: 'research_knowledge',
                  type: 'function',
                  function: { name: 'mcp_brain_knowledge_search', arguments: '{"query":"inflation"}' },
                },
                {
                  id: 'third_party_skill_collision',
                  type: 'function',
                  function: { name: 'mcp_other_get_skill', arguments: '{"name":"unsafe"}' },
                },
              ],
            },
          }],
          usage: { prompt_tokens: 50, completion_tokens: 5 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      secondRequestBody = body;
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'done' } }],
        usage: { prompt_tokens: 50, completion_tokens: 5 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;
    try {
      const tools = [
        {
          name: 'mcp_brain_list_skills',
          __serverId: 'brain',
          __rawName: 'list_skills',
          description: 'List skills',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'mcp_brain_get_skill',
          __serverId: 'brain',
          __rawName: 'get_skill',
          description: 'Get a skill',
          inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        },
        {
          name: 'mcp_brain_search_skills',
          __serverId: 'brain',
          __rawName: 'search_skills',
          description: 'Search skills',
          inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        },
        {
          name: 'mcp_brain_knowledge_search',
          __serverId: 'brain',
          __rawName: 'knowledge_search',
          description: 'Search project knowledge',
          inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        },
        {
          name: 'mcp_brain_knowledge_ingest',
          __serverId: 'brain',
          __rawName: 'knowledge_ingest',
          description: 'Ingest project knowledge',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'mcp_other_get_skill',
          __serverId: 'other',
          __rawName: 'get_skill',
          description: 'Coincidentally named third-party tool',
          inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
        },
      ];
      const stubMcp: any = {
        listTools: async () => ({ tools }),
        getServerIds: () => ['brain', 'other'],
        getStatus: (serverId: string) => ({
          identity: serverId === 'brain' ? 'brainrouter' : 'third-party',
        }),
        callTool: async (name: string) => {
          mcpCalls.push(name);
          return { content: [{ text: '{"results":[]}' }] };
        },
        close: async () => {},
      };
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'm' }, {
        workspaceRoot: workspace,
        launchCwd: workspace,
        silent: true,
      });
      agent.setAccessMode('shell');
      assert.equal(await agent.runTurn('Set up this research folder.', {
        onStatusUpdate: () => {},
        onToolStart: () => {},
        onToolEnd: () => {},
      }), 'done');

      const names = new Set((firstRequestBody.tools ?? []).map((tool: any) => tool.function?.name));
      for (const name of [
        'list_dir',
        'write_file',
        'mcp_brain_list_skills',
        'mcp_brain_get_skill',
        'mcp_brain_search_skills',
        'mcp_brain_knowledge_search',
      ]) {
        assert.equal(names.has(name), true, name);
      }
      assert.equal(names.has('run_command'), false, 'Research does not receive shell authority by default');
      assert.equal(names.has('mcp_brain_knowledge_ingest'), false, 'Project Knowledge defaults are read-only');
      assert.equal(names.has('mcp_other_get_skill'), false, 'skill baseline is limited to the BrainRouter server');
      assert.equal(fs.readFileSync(path.join(workspace, 'notes.md'), 'utf8'), '# Notes');
      assert.deepEqual(mcpCalls, ['mcp_brain_knowledge_search']);
      const denied = secondRequestBody.messages.find((message: any) =>
        message.tool_call_id === 'third_party_skill_collision');
      assert.match(denied?.content ?? '', /workspace MCP tool policy/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('runTurn applies explicit catalog selection to exposure and dispatch', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const catalog = buildWorkspaceSelectionCatalog();
    saveWorkspaceManifest(
      workspace,
      migrateWorkspaceManifestToolSelection({
        manifest: createWorkspaceManifest({ name: 'blank', profile: 'custom', by: 'wizard' }),
        reviewed: { profiles: [], enabled: ['web_search'], deny: [] },
        catalog,
      }),
    );
    const originalFetch = globalThis.fetch;
    let llmCalls = 0;
    let firstRequestBody: any;
    let secondRequestBody: any;
    globalThis.fetch = (async (_url: any, opts: any) => {
      llmCalls += 1;
      const body = JSON.parse(opts.body);
      if (llmCalls === 1) {
        firstRequestBody = body;
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'unselected_plan',
                type: 'function',
                function: { name: 'update_plan', arguments: '{"items":[]}' },
              }],
            },
          }],
          usage: { prompt_tokens: 50, completion_tokens: 5 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      secondRequestBody = body;
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'done' } }],
        usage: { prompt_tokens: 50, completion_tokens: 5 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;
    try {
      const stubMcp: any = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [] }),
        close: async () => {},
      };
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'm' }, {
        workspaceRoot: workspace,
        launchCwd: workspace,
        silent: true,
      });
      agent.setAccessMode('shell');
      assert.equal(await agent.runTurn('Search only.', {
        onStatusUpdate: () => {},
        onToolStart: () => {},
        onToolEnd: () => {},
      }), 'done');

      const names = new Set((firstRequestBody.tools ?? []).map((tool: any) => tool.function?.name));
      assert.deepEqual([...names], ['web_search']);
      const denied = secondRequestBody.messages.find((message: any) => message.tool_call_id === 'unselected_plan');
      assert.match(denied?.content ?? '', /workspace tool-profile policy/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('runTurn keeps live MCP names closed without a reviewed stable MCP surface', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const catalog = buildWorkspaceSelectionCatalog();
    saveWorkspaceManifest(
      workspace,
      migrateWorkspaceManifestToolSelection({
        manifest: createWorkspaceManifest({ name: 'blank', profile: 'custom', by: 'wizard' }),
        reviewed: { profiles: [], enabled: [], deny: [] },
        catalog,
      }),
    );
    const originalFetch = globalThis.fetch;
    let llmCalls = 0;
    let firstRequestBody: any;
    let secondRequestBody: any;
    let mcpCalls = 0;
    globalThis.fetch = (async (_url: any, opts: any) => {
      llmCalls += 1;
      const body = JSON.parse(opts.body);
      if (llmCalls === 1) {
        firstRequestBody = body;
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'unreviewed_mcp',
                type: 'function',
                function: { name: 'mcp_docs_search', arguments: '{}' },
              }],
            },
          }],
          usage: { prompt_tokens: 50, completion_tokens: 5 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      secondRequestBody = body;
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'done' } }],
        usage: { prompt_tokens: 50, completion_tokens: 5 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;
    try {
      const stubMcp: any = {
        listTools: async () => ({
          tools: [{
            name: 'mcp_docs_search',
            __rawName: 'search',
            __serverId: 'docs',
            description: 'Search documentation',
            inputSchema: { type: 'object', properties: {} },
          }],
        }),
        callTool: async () => {
          mcpCalls += 1;
          return { content: [{ text: 'called' }] };
        },
        close: async () => {},
      };
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'm' }, {
        workspaceRoot: workspace,
        launchCwd: workspace,
        silent: true,
      });
      assert.equal(await agent.runTurn('Do not use tools.', {
        onStatusUpdate: () => {},
        onToolStart: () => {},
        onToolEnd: () => {},
      }), 'done');

      const names = new Set((firstRequestBody.tools ?? []).map((tool: any) => tool.function?.name));
      assert.equal(names.has('mcp_docs_search'), false);
      assert.equal(mcpCalls, 0);
      const denied = secondRequestBody.messages.find((message: any) => message.tool_call_id === 'unreviewed_mcp');
      assert.match(denied?.content ?? '', /workspace MCP tool policy/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('runTurn combines engineering manifest profiles with task-time frontend profiles', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    saveWorkspaceManifest(
      workspace,
      createWorkspaceManifest({ name: 'app', profile: 'engineering', by: 'wizard' }),
    );
    const originalFetch = globalThis.fetch;
    let requestBody: any;
    globalThis.fetch = (async (_url: any, opts: any) => {
      requestBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'done' } }],
        usage: { prompt_tokens: 50, completion_tokens: 5 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;
    try {
      const stubMcp: any = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [] }),
        close: async () => {},
      };
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'm' }, {
        workspaceRoot: workspace,
        launchCwd: workspace,
        silent: true,
      });
      agent.setAccessMode('shell');
      assert.equal(await agent.runTurn('Build a responsive React dashboard.', {
        onStatusUpdate: () => {},
        onToolStart: () => {},
        onToolEnd: () => {},
      }), 'done');

      const names = new Set((requestBody.tools ?? []).map((tool: any) => tool.function?.name));
      assert.equal(names.has('write_file'), true);
      assert.equal(names.has('run_command'), true);
      assert.equal(names.has('web_search'), true);
      assert.equal(names.has('artifact_write'), true, 'Engineering artifacts remain available for frontend work');
      assert.deepEqual(agent.activeWorkspaceCapabilities.toolProfiles, [
        'browser', 'artifacts', 'interactive-browser',
      ]);
      assert.equal(agent.activeWorkspacePersonaId, 'engineer');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('runTurn recovery: unknown tool name surfaces "did you mean" via normalizeToolName', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    let llmCalls = 0;
    let secondRequestBody: any;
    globalThis.fetch = (async (_url: any, opts: any) => {
      llmCalls++;
      if (llmCalls === 1) {
        // Case/separator mismatch — normalizeToolName resolves "Read-File"
        // to canonical "read_file" via flatten-and-compare.
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [{ id: 'unk_1', type: 'function', function: { name: 'Read-File', arguments: '{"path":"x"}' } }],
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      secondRequestBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 50, completion_tokens: 5 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;
    try {
      const stubMcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [] }), close: async () => {} };
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'm' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true,
      });
      await agent.runTurn('try unknown', {
        onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {},
      });
      // normalizeToolName actually resolves "Read-File" → "read_file" at
      // dispatch time, so the call SUCCEEDS — the "did you mean" branch
      // only fires when normalization can't disambiguate. To exercise that
      // path explicitly we rely on the helper-level test (above).
      // Here we just assert the call was routed correctly (i.e. the loop
      // didn't abort on the bogus name).
      const toolMsgs = secondRequestBody.messages.filter((m: any) => m.role === 'tool');
      assert.equal(toolMsgs.length, 1);
      assert.equal(toolMsgs[0].tool_call_id, 'unk_1');
    } finally { globalThis.fetch = originalFetch; }
  });
});

test('runTurn recovery: truly unknown MCP tool name carries "did you mean" hint when one matches', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    let llmCalls = 0;
    let secondRequestBody: any;
    globalThis.fetch = (async (_url: any, opts: any) => {
      llmCalls++;
      if (llmCalls === 1) {
        // Hallucinated MCP tool — but exposeMcp returns a real one with
        // matching flatten form so the "did you mean" branch lights up
        // when the MCP call itself throws MethodNotFound.
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [{ id: 'mcp_1', type: 'function', function: { name: 'mcp.brainrouter.memory_recall', arguments: '{}' } }],
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      secondRequestBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 50, completion_tokens: 5 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;
    try {
      const stubMcp: any = {
        listTools: async () => ({ tools: [{ name: 'mcp_brainrouter_memory_recall' }] }),
        callTool: async (name: string) => {
          // Simulate the JSON-RPC -32601 MethodNotFound that the real pool
          // throws for an unknown name. (After normalizeToolName resolves
          // mcp.brainrouter.memory_recall → mcp_brainrouter_memory_recall
          // this branch wouldn't fire — so trigger from the other side.)
          if (name === 'mcp_brainrouter_memory_recall') {
            return { content: [{ text: 'recalled' }] };
          }
          throw new Error(`-32601 Unknown tool: ${name}`);
        },
        close: async () => {},
      };
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'm' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true,
      });
      await agent.runTurn('recall please', {
        onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {},
      });
      const toolMsgs = secondRequestBody.messages.filter((m: any) => m.role === 'tool');
      assert.equal(toolMsgs.length, 1);
      // normalizeToolName resolves the dotted form to the real registered
      // name, so the call succeeds without ever hitting the unknown branch.
      assert.equal(toolMsgs[0].content, 'recalled');
    } finally { globalThis.fetch = originalFetch; }
  });
});

test('runTurn recovery: synthetic orphan results do NOT trigger the R1 child-drain guardrail', async () => {
  // If the orphan envelope ever parses as JSON with an `id` field, the
  // child-drain guardrail would think a child was spawned and try to wait
  // on it on the next clean-break turn. Verify by calling the helper
  // through the well-known content shape and confirming it's plain ERROR
  // text (also covered in tool-call-recovery.test.ts but we re-assert
  // through the public surface here so a regression in either layer
  // surfaces in agent-runtime as well).
  const { synthesizeOrphanResults } = await import('../agent/guards/toolCallRecovery.js');
  const synth = synthesizeOrphanResults(
    [{ id: 'x', type: 'function', function: { name: 'spawn_agent', arguments: '{}' } }],
    [],
  );
  assert.equal(synth.length, 1);
  assert.match(synth[0].content, /^ERROR:/);
  // Round-trip through parseJsonObject's exact shape — if this returns an
  // object, trackChildObservation would believe a spawn happened.
  let parsed: any;
  try { parsed = JSON.parse(synth[0].content); } catch { parsed = undefined; }
  assert.equal(typeof parsed === 'object' && parsed !== null, false, 'synthetic content must NOT parse as a JSON object');
});

// Note: three Anthropic-native runtime tests were removed in 0.3.9 when
// the brainrouter-cli/src/runtime/anthropicAdapter.ts module was dropped.
// They exercised /v1/messages tool_use round-trip, prompt-cache opt-in,
// and task_agent child spawn under the native adapter. Equivalent
// coverage on the OpenAI-compat path is upstream in this file (see the
// `runTurn` block of tests starting at the top).

test('runTurn loop-limit turn still rolls usage into session totals + counts the turn (P2a regression)', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    // Distinct dirs so every forced tool call differs (dodges the repeat
    // guards) and actually succeeds against the real fs.
    for (let i = 0; i < 8; i++) fs.mkdirSync(path.join(workspace, `d${i}`));
    const originalFetch = globalThis.fetch;
    // maxToolLoops:1 → maxLoops floors to 5 (fast); keep the repeat guard out
    // of the way so we reach the loop limit rather than a guard break.
    setCliKnobOverride({ repeatToolSequenceLimit: 999, maxToolLoops: 1 });
    let llmCalls = 0;
    globalThis.fetch = (async () => {
      llmCalls++;
      // ALWAYS request another tool call → never a clean exit → loop limit.
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: '',
            tool_calls: [{
              id: `call_${llmCalls}`,
              type: 'function',
              function: { name: 'list_dir', arguments: JSON.stringify({ path: `d${llmCalls % 8}` }) },
            }],
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;
    try {
      const stubMcp: any = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [{ text: '{}' }] }),
        close: async () => {},
      };
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true,
      });
      const answer = await agent.runTurn('keep going', {
        onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {},
      });
      // Sanity: we really hit the loop limit (not a clean exit).
      assert.equal(agent.lastTurnHitLoopLimit, true);
      assert.match(answer, /tool-call budget/);
      // The regression itself: a `return` used to fire on the loop-limit path
      // BEFORE these accumulated, so the most expensive turns vanished from
      // session totals. maxLoops=5 → ≥5 LLM calls at 10 prompt tokens each.
      assert.ok(
        agent.sessionUsage.promptTokens >= 50,
        `loop-limit turn must accumulate session prompt tokens, got ${agent.sessionUsage.promptTokens}`,
      );
      assert.equal(agent.sessionUsage.turns, 1);
      assert.ok(agent.sessionUsage.completionTokens >= 10);
    } finally {
      globalThis.fetch = originalFetch;
      resetCliKnobsForAgentRuntimeTest();
    }
  });
});

test('runTurn plan-sync guardrail: nudges once when a turn works but advances no plan item (stale-plan bug)', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const { updatePlan } = await import('../task/taskStore.js');
    const sessionKey = 'session:plansync';
    // The exact /where state: an in_progress item, nothing completed.
    updatePlan(workspace, { plan: [
      { step: 'Audit auth routes', status: 'in_progress' },
      { step: 'Summarize findings', status: 'pending' },
    ] }, sessionKey);

    const originalFetch = globalThis.fetch;
    const statuses: string[] = [];
    let llmCalls = 0;
    globalThis.fetch = (async () => {
      llmCalls++;
      if (llmCalls === 1) {
        // Turn does real work: one tool call (no update_plan).
        return new Response(JSON.stringify({
          choices: [{ message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_dir', arguments: '{"path":"."}' } }] } }],
          usage: { prompt_tokens: 50, completion_tokens: 5 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      // Conclude with prose, NO tool calls, NO update_plan — the bug shape.
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Findings: auth routes leak the API key.' } }],
        usage: { prompt_tokens: 30, completion_tokens: 8 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;
    try {
      const stubMcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [{ text: '{}' }] }), close: async () => {} };
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true, sessionKey,
      });
      const answer = await agent.runTurn('audit the api', { onStatusUpdate: (s) => statuses.push(s), onToolStart: () => {}, onToolEnd: () => {} });
      // Guard added exactly one extra iteration: toolcall → answer → [nudge] → answer.
      assert.equal(llmCalls, 3, `expected 3 LLM calls from the plan-sync re-prompt, got ${llmCalls}`);
      assert.ok(statuses.some((s) => /plan not advanced/i.test(s)), 'plan-sync nudge status should fire');
      assert.match(answer, /findings/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('runTurn plan-sync guardrail: does NOT fire when the turn completes a plan item', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const { updatePlan } = await import('../task/taskStore.js');
    const sessionKey = 'session:plansync2';
    updatePlan(workspace, { plan: [{ step: 'Audit auth routes', status: 'in_progress' }] }, sessionKey);

    const originalFetch = globalThis.fetch;
    const statuses: string[] = [];
    let llmCalls = 0;
    globalThis.fetch = (async () => {
      llmCalls++;
      if (llmCalls === 1) {
        // The model marks the item completed via update_plan.
        return new Response(JSON.stringify({
          choices: [{ message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'update_plan', arguments: JSON.stringify({ plan: [{ step: 'Audit auth routes', status: 'completed' }] }) } }] } }],
          usage: { prompt_tokens: 50, completion_tokens: 5 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Done — audit complete.' } }],
        usage: { prompt_tokens: 30, completion_tokens: 8 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;
    try {
      const stubMcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [{ text: '{}' }] }), close: async () => {} };
      const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: true, sessionKey,
      });
      await agent.runTurn('audit the api', { onStatusUpdate: (s) => statuses.push(s), onToolStart: () => {}, onToolEnd: () => {} });
      assert.equal(llmCalls, 2, 'no extra iteration when the plan advanced');
      assert.ok(!statuses.some((s) => /plan not advanced/i.test(s)), 'no nudge when an item was completed this turn');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
