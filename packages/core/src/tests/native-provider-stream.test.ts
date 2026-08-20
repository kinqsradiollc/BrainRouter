// ADR-041 A41-5 — provider-native SSE streaming parsers. Pure over an async
// iterable of raw body-text chunks, so they run against captured SSE with no
// network. Chunk boundaries are exercised at arbitrary offsets to prove the
// cross-chunk line buffer.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sseEvents,
  parseAnthropicMessageStream,
  parseGeminiStream,
} from '../agent/transport/nativeProviderStream.js';

async function* fromChunks(chunks: string[]): AsyncGenerator<string> {
  for (const c of chunks) yield c;
}

/** Re-slice one string into fixed-size chunks to stress the cross-chunk buffer. */
function sliced(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

const ANTHROPIC_TEXT = [
  'event: message_start',
  'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
].join('\n');

test('A41-5 — Anthropic text stream: live deltas + accumulated content + usage', async () => {
  const deltas: string[] = [];
  const out = await parseAnthropicMessageStream(fromChunks([ANTHROPIC_TEXT]), { onTextDelta: (t) => deltas.push(t) }, 'https://x', 'm');
  assert.deepEqual(deltas, ['Hello', ' world']);
  assert.equal(out.content, 'Hello world');
  assert.equal(out.toolCalls, undefined);
  assert.equal(out.usage?.prompt_tokens, 10);
  assert.equal(out.usage?.completion_tokens, 5);
  assert.ok(typeof out.finishReason === 'string' && out.finishReason.length > 0);
});

test('A41-5 — Anthropic stream survives arbitrary chunk boundaries', async () => {
  for (const size of [1, 3, 17, 64]) {
    const deltas: string[] = [];
    const out = await parseAnthropicMessageStream(fromChunks(sliced(ANTHROPIC_TEXT, size)), { onTextDelta: (t) => deltas.push(t) }, 'https://x', 'm');
    assert.equal(out.content, 'Hello world', `size ${size}`);
    assert.deepEqual(deltas, ['Hello', ' world'], `size ${size}`);
  }
});

test('A41-5 — Anthropic tool_use: input_json_delta pieces reassemble into arguments', async () => {
  const sse = [
    'data: {"type":"message_start","message":{"usage":{"input_tokens":4}}}',
    '',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather"}}',
    '',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":"}}',
    '',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"NYC\\"}"}}',
    '',
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}',
    '',
  ].join('\n');
  const out = await parseAnthropicMessageStream(fromChunks([sse]), {}, 'https://x', 'm');
  assert.equal(out.content, '');
  assert.equal(out.toolCalls?.length, 1);
  assert.equal(out.toolCalls?.[0]!.id, 'toolu_1');
  assert.equal(out.toolCalls?.[0]!.function.name, 'get_weather');
  assert.equal(out.toolCalls?.[0]!.function.arguments, '{"city":"NYC"}');
});

test('A41-5 — Anthropic thinking_delta routes to onReasoningDelta, not content', async () => {
  const sse = [
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"pondering"}}',
    '',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"answer"}}',
    '',
  ].join('\n');
  const reasoning: string[] = [];
  const text: string[] = [];
  const out = await parseAnthropicMessageStream(fromChunks([sse]), { onReasoningDelta: (t) => reasoning.push(t), onTextDelta: (t) => text.push(t) }, 'https://x', 'm');
  assert.deepEqual(reasoning, ['pondering']);
  assert.deepEqual(text, ['answer']);
  assert.equal(out.content, 'answer');
});

test('A41-5 — Anthropic error event throws (caller falls back)', async () => {
  const sse = 'data: {"type":"error","error":{"message":"overloaded"}}\n\n';
  await assert.rejects(() => parseAnthropicMessageStream(fromChunks([sse]), {}, 'https://x', 'm'), /overloaded/);
});

const GEMINI_SSE = [
  'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Hel"}]}}]}',
  '',
  'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"lo"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":8,"candidatesTokenCount":2,"totalTokenCount":10}}',
  '',
].join('\n');

test('A41-5 — Gemini text stream: live deltas + content + usageMetadata', async () => {
  const deltas: string[] = [];
  const out = await parseGeminiStream(fromChunks([GEMINI_SSE]), { onTextDelta: (t) => deltas.push(t) }, 'https://x', 'm');
  assert.deepEqual(deltas, ['Hel', 'lo']);
  assert.equal(out.content, 'Hello');
  assert.equal(out.usage?.prompt_tokens, 8);
  assert.equal(out.usage?.completion_tokens, 2);
  assert.equal(out.usage?.total_tokens, 10);
});

test('A41-5 — Gemini functionCall becomes a tool call with a synthesized id', async () => {
  const sse = 'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"lookup","args":{"q":"x"}}}]},"finishReason":"STOP"}]}\n\n';
  const out = await parseGeminiStream(fromChunks([sse]), {}, 'https://x', 'm');
  assert.equal(out.toolCalls?.length, 1);
  assert.equal(out.toolCalls?.[0]!.function.name, 'lookup');
  assert.equal(out.toolCalls?.[0]!.function.arguments, '{"q":"x"}');
  assert.ok((out.toolCalls?.[0]!.id ?? '').startsWith('call_'));
});

test('A41-5 — Gemini survives arbitrary chunk boundaries', async () => {
  for (const size of [1, 5, 40]) {
    const out = await parseGeminiStream(fromChunks(sliced(GEMINI_SSE, size)), {}, 'https://x', 'm');
    assert.equal(out.content, 'Hello', `size ${size}`);
  }
});

test('A41-5 — a mid-stream abort propagates out of the parser (caller maps it to InterruptError)', async () => {
  async function* abortsMidway(): AsyncGenerator<string> {
    yield 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n';
    const e: any = new Error('aborted'); e.name = 'AbortError';
    throw e;
  }
  const painted: string[] = [];
  await assert.rejects(
    () => parseAnthropicMessageStream(abortsMidway(), { onTextDelta: (t) => painted.push(t) }, 'https://x', 'm'),
    (e: any) => e?.name === 'AbortError',
  );
  assert.deepEqual(painted, ['partial'], 'deltas up to the abort still fired');
});

test('A41-5 — sseEvents joins multi-line data and skips heartbeat comments', async () => {
  const raw = ': keep-alive\ndata: line1\ndata: line2\n\ndata: [DONE]\n\n';
  const events: Array<{ event: string; data: string }> = [];
  for await (const e of sseEvents(fromChunks([raw]))) events.push(e);
  assert.deepEqual(events, [{ event: '', data: 'line1\nline2' }, { event: '', data: '[DONE]' }]);
});
