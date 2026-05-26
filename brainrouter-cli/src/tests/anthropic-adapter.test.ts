import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldUseAnthropicNative,
  buildAnthropicRequest,
  parseAnthropicResponse,
} from '../runtime/anthropicAdapter.js';

const baseConfig = {
  provider: 'anthropic' as const,
  apiKey: 'k',
  model: 'claude-sonnet-4-5',
  endpoint: 'https://api.anthropic.com/v1',
};

test('shouldUseAnthropicNative: anthropic provider + api.anthropic.com routes native', () => {
  assert.equal(shouldUseAnthropicNative(baseConfig, {} as any), true);
});

test('shouldUseAnthropicNative: openai provider never routes native', () => {
  assert.equal(
    shouldUseAnthropicNative({ ...baseConfig, provider: 'openai' as any }, {} as any),
    false,
  );
});

test('shouldUseAnthropicNative: non-anthropic host falls through unless override set', () => {
  const cfg = { ...baseConfig, endpoint: 'https://openrouter.ai/api/v1' };
  assert.equal(shouldUseAnthropicNative(cfg, {} as any), false);
  assert.equal(shouldUseAnthropicNative(cfg, { BRAINROUTER_ANTHROPIC_NATIVE: '1' } as any), true);
});

test('buildAnthropicRequest: hoists system message and required max_tokens', () => {
  const body = buildAnthropicRequest(baseConfig, [
    { role: 'system', content: 'be helpful' },
    { role: 'user', content: 'hi' },
  ], []);
  assert.equal(body.system, 'be helpful');
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, 'user');
  assert.equal(body.max_tokens, 4096);
});

test('buildAnthropicRequest: haiku gets the smaller max_tokens default', () => {
  const body = buildAnthropicRequest({ ...baseConfig, model: 'claude-haiku-4-5' }, [
    { role: 'user', content: 'hi' },
  ], []);
  assert.equal(body.max_tokens, 2048);
});

test('buildAnthropicRequest: assistant tool_calls → tool_use blocks preserving id', () => {
  const body = buildAnthropicRequest(baseConfig, [
    { role: 'user', content: 'list it' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'toolu_01ABC',
        type: 'function',
        function: { name: 'list_dir', arguments: '{"path":"."}' },
      }],
    },
    { role: 'tool', tool_call_id: 'toolu_01ABC', name: 'list_dir', content: 'file.txt' },
  ], []);
  // [user, assistant(tool_use), user(tool_result)]
  assert.equal(body.messages.length, 3);
  const assistant = body.messages[1];
  assert.equal(assistant.role, 'assistant');
  assert.equal(assistant.content[0].type, 'tool_use');
  assert.equal(assistant.content[0].id, 'toolu_01ABC');
  assert.equal(assistant.content[0].name, 'list_dir');
  assert.deepEqual(assistant.content[0].input, { path: '.' });
  const toolUser = body.messages[2];
  assert.equal(toolUser.role, 'user');
  assert.equal(toolUser.content[0].type, 'tool_result');
  assert.equal(toolUser.content[0].tool_use_id, 'toolu_01ABC');
  assert.equal(toolUser.content[0].content, 'file.txt');
});

test('buildAnthropicRequest: consecutive tool results collapse into ONE user turn', () => {
  const body = buildAnthropicRequest(baseConfig, [
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'a', type: 'function', function: { name: 't', arguments: '{}' } },
        { id: 'b', type: 'function', function: { name: 't', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'a', name: 't', content: 'A' },
    { role: 'tool', tool_call_id: 'b', name: 't', content: 'B' },
  ], []);
  // [assistant, user(both tool_results)]
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[1].role, 'user');
  assert.equal(body.messages[1].content.length, 2);
  assert.equal(body.messages[1].content[0].tool_use_id, 'a');
  assert.equal(body.messages[1].content[1].tool_use_id, 'b');
});

test('buildAnthropicRequest: tools list converted to {name, description, input_schema}', () => {
  const body = buildAnthropicRequest(baseConfig, [
    { role: 'user', content: 'hi' },
  ], [
    { name: 'mcp_brainrouter_recall', description: 'recall', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
  ]);
  assert.equal(body.tools?.length, 1);
  assert.equal(body.tools![0].name, 'mcp_brainrouter_recall');
  assert.equal(body.tools![0].input_schema.properties.q.type, 'string');
});

test('buildAnthropicRequest: cache_control off by default, set when enabled', () => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello there' },
  ];
  const off = buildAnthropicRequest(baseConfig, messages, []);
  assert.equal(typeof off.system, 'string');
  const lastOff = off.messages[off.messages.length - 1];
  assert.equal(lastOff.content[0].cache_control, undefined);

  const on = buildAnthropicRequest(baseConfig, messages, [], { cacheEnabled: true });
  assert.ok(Array.isArray(on.system));
  assert.deepEqual((on.system as any)[0].cache_control, { type: 'ephemeral' });
  const lastOn = on.messages[on.messages.length - 1];
  assert.deepEqual(lastOn.content[lastOn.content.length - 1].cache_control, { type: 'ephemeral' });
});

test('buildAnthropicRequest: extended thinking gated by effort=high AND sonnet/opus 4', () => {
  // Sonnet 4 + high
  let body = buildAnthropicRequest({ ...baseConfig, model: 'claude-sonnet-4-5' }, [{ role: 'user', content: 'hi' }], [], { effort: 'high' });
  assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 8000 });

  // Sonnet 4 + medium → absent
  body = buildAnthropicRequest({ ...baseConfig, model: 'claude-sonnet-4-5' }, [{ role: 'user', content: 'hi' }], [], { effort: 'medium' });
  assert.equal(body.thinking, undefined);

  // Haiku 4 + high → absent (not on the supported family list)
  body = buildAnthropicRequest({ ...baseConfig, model: 'claude-haiku-4-5' }, [{ role: 'user', content: 'hi' }], [], { effort: 'high' });
  assert.equal(body.thinking, undefined);
});

test('parseAnthropicResponse: text + tool_use → ChatResponse shape with OpenAI-style toolCalls', () => {
  const parsed = parseAnthropicResponse({
    id: 'msg_01',
    type: 'message',
    role: 'assistant',
    content: [
      { type: 'text', text: 'Let me check.' },
      { type: 'tool_use', id: 'toolu_01XYZ', name: 'list_dir', input: { path: '.' } },
    ],
    usage: { input_tokens: 120, output_tokens: 7 },
  });
  assert.equal(parsed.content, 'Let me check.');
  assert.equal(parsed.toolCalls?.length, 1);
  assert.equal(parsed.toolCalls![0].id, 'toolu_01XYZ');
  assert.equal(parsed.toolCalls![0].type, 'function');
  assert.equal(parsed.toolCalls![0].function.name, 'list_dir');
  assert.deepEqual(JSON.parse(parsed.toolCalls![0].function.arguments), { path: '.' });
  // Anthropic's input_tokens/output_tokens mapped to OpenAI field names.
  assert.deepEqual(parsed.usage, { prompt_tokens: 120, completion_tokens: 7 });
});

test('parseAnthropicResponse: thinking blocks surfaced separately, not folded into content', () => {
  const parsed = parseAnthropicResponse({
    content: [
      { type: 'thinking', thinking: 'pondering...' },
      { type: 'text', text: 'answer' },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  assert.equal(parsed.content, 'answer');
  assert.equal(parsed.thinking, 'pondering...');
});

test('parseAnthropicResponse: error envelope throws', () => {
  assert.throws(() =>
    parseAnthropicResponse({ type: 'error', error: { message: 'overloaded' } }),
  /overloaded/);
});
