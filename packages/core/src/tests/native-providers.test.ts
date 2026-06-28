import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAnthropicMessagesPayload,
  normalizeAnthropicOutput,
  buildGeminiGeneratePayload,
  normalizeGeminiOutput,
  sanitizeGeminiSchema,
  nativeRequestSpec,
  isNativeRequestFormat,
  ANTHROPIC_VERSION,
  ANTHROPIC_DEFAULT_MAX_TOKENS,
  type NativeBuildInput,
} from '../agent/nativeProviders.js';
import { resolveRequestFormat } from '../agent/agent.js';
import { _resetCliKnobsCache, resolveCliKnobs, setCliKnobOverride } from '../config/config.js';

// A representative agentic turn in OpenAI-clean shape (post-mapping): a user
// prompt, an assistant tool call, and the tool's result coming back.
function sampleInput(overrides: Partial<NativeBuildInput> = {}): NativeBuildInput {
  return {
    model: 'claude-x',
    system: 'You are a careful engineer.',
    messages: [
      { role: 'user', content: 'List the repo files.' },
      { role: 'assistant', content: 'On it.', tool_calls: [{ id: 'call_1', function: { name: 'list_files', arguments: '{"path":"."}' } }] },
      { role: 'tool', tool_call_id: 'call_1', name: 'list_files', content: 'a.ts\nb.ts' },
    ],
    tools: [{ name: 'list_files', description: 'List files', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
    toolChoice: undefined,
    maxTokens: undefined,
    ...overrides,
  };
}

// ── Anthropic payload ──────────────────────────────────────────────────────

test('anthropic: system extracted, roles + content blocks translated', () => {
  const p = buildAnthropicMessagesPayload(sampleInput());
  assert.equal(p.model, 'claude-x');
  assert.equal(p.system, 'You are a careful engineer.');
  assert.equal(p.max_tokens, ANTHROPIC_DEFAULT_MAX_TOKENS);

  assert.deepEqual(p.messages[0], { role: 'user', content: [{ type: 'text', text: 'List the repo files.' }] });
  // assistant: a text block then a tool_use block with PARSED input (object, not string).
  assert.equal(p.messages[1].role, 'assistant');
  assert.deepEqual(p.messages[1].content[0], { type: 'text', text: 'On it.' });
  assert.deepEqual(p.messages[1].content[1], { type: 'tool_use', id: 'call_1', name: 'list_files', input: { path: '.' } });
  // tool result is a USER message carrying a tool_result block.
  assert.deepEqual(p.messages[2], { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'a.ts\nb.ts' }] });
});

test('anthropic: tools mapped to input_schema; tool_choice auto by default, forced when requested', () => {
  const auto = buildAnthropicMessagesPayload(sampleInput());
  assert.equal(auto.tools?.[0].name, 'list_files');
  assert.equal(auto.tools?.[0].input_schema && (auto.tools[0].input_schema as any).type, 'object');
  assert.deepEqual(auto.tool_choice, { type: 'auto' });

  const forced = buildAnthropicMessagesPayload(sampleInput({ toolChoice: { type: 'function', function: { name: 'list_files' } } }));
  assert.deepEqual(forced.tool_choice, { type: 'tool', name: 'list_files' });
});

test('anthropic: max_tokens honors explicit cap; omits system when empty; drops empty assistant turn', () => {
  const capped = buildAnthropicMessagesPayload(sampleInput({ maxTokens: 2048 }));
  assert.equal(capped.max_tokens, 2048);

  const noSystem = buildAnthropicMessagesPayload(sampleInput({ system: '   ' }));
  assert.equal(noSystem.system, undefined);

  // An assistant message with neither text nor tool calls is dropped (Anthropic
  // rejects an empty content array).
  const empty = buildAnthropicMessagesPayload({
    model: 'm', system: '', tools: [],
    messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: '' }],
  });
  assert.equal(empty.messages.length, 1);
  assert.equal(empty.messages[0].role, 'user');
});

test('anthropic: consecutive tool results merge into one user message', () => {
  const p = buildAnthropicMessagesPayload({
    model: 'm', system: '', tools: [],
    messages: [
      { role: 'assistant', content: '', tool_calls: [
        { id: 'a', function: { name: 'f', arguments: '{}' } },
        { id: 'b', function: { name: 'g', arguments: '{}' } },
      ] },
      { role: 'tool', tool_call_id: 'a', name: 'f', content: 'ra' },
      { role: 'tool', tool_call_id: 'b', name: 'g', content: 'rb' },
    ],
  });
  // Two tool_use blocks in the assistant turn, then ONE user message with two
  // tool_result blocks.
  assert.equal(p.messages[0].content.length, 2);
  assert.equal(p.messages[1].role, 'user');
  assert.equal(p.messages[1].content.length, 2);
  assert.deepEqual(p.messages[1].content.map((b) => b.tool_use_id), ['a', 'b']);
});

test('anthropic: malformed tool-call arguments degrade to an empty object (never throw)', () => {
  const p = buildAnthropicMessagesPayload({
    model: 'm', system: '', tools: [],
    messages: [{ role: 'assistant', content: '', tool_calls: [{ id: 'x', function: { name: 'f', arguments: 'not json' } }] }],
  });
  assert.deepEqual(p.messages[0].content[0], { type: 'tool_use', id: 'x', name: 'f', input: {} });
});

// ── Anthropic normalize ────────────────────────────────────────────────────

test('anthropic normalize: text + tool_use → content + OpenAI-shaped toolCalls; usage + stop mapped', () => {
  const out = normalizeAnthropicOutput({
    content: [
      { type: 'text', text: 'Here you go: ' },
      { type: 'tool_use', id: 'tu_1', name: 'list_files', input: { path: '.' } },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 12, output_tokens: 7 },
  }, 'https://api.anthropic.com/v1', 'claude-x');

  assert.equal(out.content, 'Here you go: ');
  assert.deepEqual(out.toolCalls, [{ id: 'tu_1', type: 'function', function: { name: 'list_files', arguments: '{"path":"."}' } }]);
  assert.equal(out.usage?.prompt_tokens, 12);
  assert.equal(out.usage?.completion_tokens, 7);
  assert.equal(out.usage?.total_tokens, 19);
  assert.equal(out.finishReason, 'tool_calls');
});

test('anthropic normalize: max_tokens stop maps to length; end_turn → stop; no tool calls → undefined toolCalls', () => {
  assert.equal(normalizeAnthropicOutput({ content: [{ type: 'text', text: 'x' }], stop_reason: 'max_tokens' }, 'e', 'm').finishReason, 'length');
  const plain = normalizeAnthropicOutput({ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' }, 'e', 'm');
  assert.equal(plain.finishReason, 'stop');
  assert.equal(plain.toolCalls, undefined);
});

test('anthropic normalize: error envelope and missing content throw with context', () => {
  assert.throws(() => normalizeAnthropicOutput({ type: 'error', error: { message: 'overloaded' } }, 'e', 'm'), /overloaded/);
  assert.throws(() => normalizeAnthropicOutput({ stop_reason: 'end_turn' }, 'https://x', 'claude-x'), /no content/i);
});

// ── Gemini payload ─────────────────────────────────────────────────────────

test('gemini: systemInstruction + contents (assistant→model), functionCall args parsed, functionResponse wrapped', () => {
  const p = buildGeminiGeneratePayload(sampleInput({ model: 'gemini-x' }));
  assert.deepEqual(p.systemInstruction, { parts: [{ text: 'You are a careful engineer.' }] });
  assert.deepEqual(p.contents[0], { role: 'user', parts: [{ text: 'List the repo files.' }] });
  assert.equal(p.contents[1].role, 'model');
  assert.deepEqual(p.contents[1].parts[0], { text: 'On it.' });
  assert.deepEqual(p.contents[1].parts[1], { functionCall: { name: 'list_files', args: { path: '.' } } });
  // tool result → user message with functionResponse; non-JSON content wrapped as { result }.
  assert.deepEqual(p.contents[2], { role: 'user', parts: [{ functionResponse: { name: 'list_files', response: { result: 'a.ts\nb.ts' } } }] });
});

test('gemini: functionDeclarations + toolConfig AUTO by default, ANY+allowed when forced; generationConfig only when capped', () => {
  const auto = buildGeminiGeneratePayload(sampleInput());
  assert.equal(auto.tools?.[0].functionDeclarations[0].name, 'list_files');
  assert.deepEqual(auto.toolConfig, { functionCallingConfig: { mode: 'AUTO' } });
  assert.equal(auto.generationConfig, undefined);

  const forced = buildGeminiGeneratePayload(sampleInput({ toolChoice: { type: 'function', function: { name: 'list_files' } }, maxTokens: 1000 }));
  assert.deepEqual(forced.toolConfig, { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['list_files'] } });
  assert.deepEqual(forced.generationConfig, { maxOutputTokens: 1000 });
});

test('gemini: JSON-object tool result is passed through as the response struct (not double-wrapped)', () => {
  const p = buildGeminiGeneratePayload({
    model: 'g', system: '', tools: [],
    messages: [{ role: 'tool', tool_call_id: 't', name: 'f', content: '{"ok":true,"rows":2}' }],
  });
  assert.deepEqual(p.contents[0].parts[0], { functionResponse: { name: 'f', response: { ok: true, rows: 2 } } });
});

test('gemini: no system → no systemInstruction; consecutive functionResponses merge', () => {
  const p = buildGeminiGeneratePayload({
    model: 'g', system: '', tools: [],
    messages: [
      { role: 'tool', tool_call_id: 'a', name: 'f', content: 'ra' },
      { role: 'tool', tool_call_id: 'b', name: 'g', content: 'rb' },
    ],
  });
  assert.equal(p.systemInstruction, undefined);
  assert.equal(p.contents.length, 1);
  assert.equal(p.contents[0].parts.length, 2);
});

// ── Gemini normalize ───────────────────────────────────────────────────────

test('gemini normalize: text + functionCall → content + synthetic-id toolCalls; finishReason tool_calls', () => {
  const out = normalizeGeminiOutput({
    candidates: [{
      content: { role: 'model', parts: [{ text: 'sure ' }, { functionCall: { name: 'list_files', args: { path: '.' } } }] },
      finishReason: 'STOP',
    }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
  }, 'https://generativelanguage.googleapis.com/v1beta', 'gemini-x');

  assert.equal(out.content, 'sure ');
  assert.equal(out.toolCalls?.length, 1);
  assert.equal(out.toolCalls?.[0].function.name, 'list_files');
  assert.equal(out.toolCalls?.[0].function.arguments, '{"path":"."}');
  assert.match(out.toolCalls![0].id, /^call_list_files_/);
  assert.equal(out.usage?.prompt_tokens, 5);
  assert.equal(out.usage?.total_tokens, 8);
  // a function call present ⇒ tool_calls regardless of STOP.
  assert.equal(out.finishReason, 'tool_calls');
});

test('gemini normalize: MAX_TOKENS → length; plain text → stop; blocked + missing candidates throw', () => {
  assert.equal(
    normalizeGeminiOutput({ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'MAX_TOKENS' }] }, 'e', 'm').finishReason,
    'length',
  );
  assert.equal(
    normalizeGeminiOutput({ candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }] }, 'e', 'm').finishReason,
    'stop',
  );
  assert.throws(() => normalizeGeminiOutput({ promptFeedback: { blockReason: 'SAFETY' } }, 'e', 'm'), /blocked.*SAFETY/i);
  assert.throws(() => normalizeGeminiOutput({ candidates: [] }, 'https://x', 'gemini-x'), /no candidate content/i);
  assert.throws(() => normalizeGeminiOutput({ error: { message: 'bad key' } }, 'e', 'm'), /bad key/);
});

// ── Schema sanitize ────────────────────────────────────────────────────────

test('gemini sanitize: strips $schema/$ref/$defs/additionalProperties recursively, keeps structural keys', () => {
  const cleaned = sanitizeGeminiSchema({
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    additionalProperties: false,
    properties: {
      nested: { type: 'object', additionalProperties: true, properties: { x: { type: 'string' } } },
      list: { type: 'array', items: { type: 'object', $ref: '#/$defs/Foo', properties: { y: { type: 'number' } } } },
    },
    required: ['nested'],
    $defs: { Foo: { type: 'string' } },
  }) as any;

  assert.equal(cleaned.$schema, undefined);
  assert.equal(cleaned.additionalProperties, undefined);
  assert.equal(cleaned.$defs, undefined);
  assert.equal(cleaned.type, 'object');
  assert.deepEqual(cleaned.required, ['nested']);
  assert.equal(cleaned.properties.nested.additionalProperties, undefined);
  assert.equal(cleaned.properties.nested.properties.x.type, 'string');
  assert.equal(cleaned.properties.list.items.$ref, undefined);
  assert.equal(cleaned.properties.list.items.properties.y.type, 'number');
});

// ── Request spec ───────────────────────────────────────────────────────────

test('nativeRequestSpec: anthropic uses /messages + x-api-key + anthropic-version', () => {
  const spec = nativeRequestSpec('anthropic-messages', 'https://api.anthropic.com/v1', 'claude-x', 'sk-ant');
  assert.equal(spec.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(spec.headers['x-api-key'], 'sk-ant');
  assert.equal(spec.headers['anthropic-version'], ANTHROPIC_VERSION);
  assert.equal(spec.headers['Authorization'], undefined);
});

test('nativeRequestSpec: gemini strips /openai compat suffix and targets :generateContent with x-goog-api-key', () => {
  const spec = nativeRequestSpec('gemini-generate', 'https://generativelanguage.googleapis.com/v1beta/openai', 'gemini-2.5-pro', 'AIza');
  assert.equal(spec.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent');
  assert.equal(spec.headers['x-goog-api-key'], 'AIza');
  // a native base without /openai is left intact.
  assert.equal(
    nativeRequestSpec('gemini-generate', 'https://generativelanguage.googleapis.com/v1beta', 'm', 'k').url,
    'https://generativelanguage.googleapis.com/v1beta/models/m:generateContent',
  );
});

test('isNativeRequestFormat: only the two native literals', () => {
  assert.equal(isNativeRequestFormat('anthropic-messages'), true);
  assert.equal(isNativeRequestFormat('gemini-generate'), true);
  assert.equal(isNativeRequestFormat('chat-completions'), false);
  assert.equal(isNativeRequestFormat('responses'), false);
});

// ── Integration: resolver + config validation honor the native formats ──────

test.beforeEach(() => {
  _resetCliKnobsCache();
  setCliKnobOverride({ providerRequestFormat: {} });
});
test.after(() => { _resetCliKnobsCache(); });

test('resolveRequestFormat: native override is honored verbatim and bypasses the Responses gate', () => {
  setCliKnobOverride({ providerRequestFormat: { anthropic: 'anthropic-messages' } });
  assert.equal(
    resolveRequestFormat({ provider: 'anthropic', apiKey: 'k', model: 'claude-x', endpoint: 'https://api.anthropic.com/v1' }),
    'anthropic-messages',
  );
  setCliKnobOverride({ providerRequestFormat: { gemini: 'gemini-generate' } });
  assert.equal(
    resolveRequestFormat({ provider: 'gemini', apiKey: 'k', model: 'gemini-x', endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai' }),
    'gemini-generate',
  );
});

test('resolveRequestFormat: WITHOUT an opt-in, anthropic/gemini stay on the OpenAI-compat chat-completions default', () => {
  assert.equal(
    resolveRequestFormat({ provider: 'anthropic', apiKey: 'k', model: 'claude-x', endpoint: 'https://api.anthropic.com/v1' }),
    'chat-completions',
  );
  assert.equal(
    resolveRequestFormat({ provider: 'gemini', apiKey: 'k', model: 'gemini-x', endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai' }),
    'chat-completions',
  );
});

test('resolveCliKnobs: the native literals survive validation; typos still drop', () => {
  const resolved = resolveCliKnobs({
    activeServer: '', servers: {},
    cli: { providerRequestFormat: {
      anthropic: 'anthropic-messages',
      gemini: 'gemini-generate',
      bad: 'anthropic_messages', // underscore typo → dropped
    } as any },
  });
  assert.deepEqual(resolved.providerRequestFormat, { anthropic: 'anthropic-messages', gemini: 'gemini-generate' });
});
