import test from 'node:test';
import assert from 'node:assert/strict';
import { callOpenAI, callOpenAIStream } from '../agent/transport/llmTransport.js';
import type { LLMConfig } from '../config/config.js';
import { setCliKnobOverride } from '../config/config.js';

// ADR-058 — Matilda writes tool calls into its text as DSML on EVERY wire. On the
// OpenAI-compatible path (cli.providerRequestFormat.matilda = 'chat-completions',
// or any compat relay) the transport lifts those blocks into `toolCalls` exactly
// as the native adapter does, gated on the provider's `toolCallMarkup` — a
// provider without it never has its text inspected.

const BAR = '｜';
const BLOCK = `<${BAR}DSML${BAR}tool_call> <${BAR}DSML${BAR}parameter name="tool">list_dir</${BAR}DSML${BAR}parameter> <${BAR}DSML${BAR}parameter name="params">{"path": "."}</${BAR}DSML${BAR}parameter> </${BAR}DSML${BAR}tool_call>`;
const PROSE = 'Let me start by exploring the codebase:\n\n';

const MATILDA_COMPAT: LLMConfig = { provider: 'matilda', endpoint: 'https://matilda.maincode.com/api/v1', apiKey: 'mc_live_test', model: 'matilda' };
const OPENAI: LLMConfig = { provider: 'openai', endpoint: 'https://api.openai.com/v1', apiKey: 'sk-test', model: 'gpt-5' };

function sseResponse(pieces: string[]): Response {
  const frames = pieces.map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`);
  frames.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`, 'data: [DONE]\n\n');
  return new Response(frames.join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
function jsonResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } });
}
const withFetch = async (impl: () => Response, run: () => Promise<void>): Promise<void> => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => impl()) as typeof fetch;
  try { await run(); } finally { globalThis.fetch = original; }
};
// Both providers default to another wire (OpenAI → Responses, Matilda → native); the
// person's `cli.providerRequestFormat` override is what puts them on chat-completions.
setCliKnobOverride({ providerRequestFormat: { matilda: 'chat-completions', openai: 'chat-completions' } });
test.after(() => setCliKnobOverride({ providerRequestFormat: {} }));

test('compat stream: a DSML block split across deltas becomes a tool call; the prose stays visible; the turn continues', async () => {
  await withFetch(() => sseResponse([PROSE, ...BLOCK.match(/.{1,9}/gs)!]), async () => {
    const deltas: string[] = [];
    const out = await callOpenAIStream(MATILDA_COMPAT, [{ role: 'user', content: 'look around' }], [{ type: 'function', function: { name: 'list_dir', parameters: { type: 'object' } } }], {}, { onTextDelta: (t: string) => deltas.push(t) });
    assert.equal(out.content, PROSE);
    assert.equal(deltas.join(''), out.content, 'nothing of the block was painted to the screen');
    assert.equal(out.toolCalls?.length, 1);
    assert.match(String(out.toolCalls?.[0]?.id), /^call_markup_/);
    assert.deepEqual(out.toolCalls?.[0]?.function, { name: 'list_dir', arguments: '{"path": "."}' });
    assert.equal(out.finishReason, 'tool_calls');
  });
});

test('compat non-stream: the same lift on the final message content', async () => {
  await withFetch(() => jsonResponse(PROSE + BLOCK), async () => {
    const out = await callOpenAI(MATILDA_COMPAT, [{ role: 'user', content: 'look around' }], [], {});
    assert.equal(out.content, PROSE);
    assert.equal(out.toolCalls?.[0]?.function.name, 'list_dir');
    assert.equal(out.finishReason, 'tool_calls');
  });
});

test('another provider emitting the same text is left exactly alone', async () => {
  await withFetch(() => sseResponse([PROSE, BLOCK]), async () => {
    const out = await callOpenAIStream(OPENAI, [{ role: 'user', content: 'x' }], [], {}, {});
    assert.equal(out.content, PROSE + BLOCK);
    assert.equal(out.toolCalls, undefined);
    assert.equal(out.finishReason, 'stop');
  });
  await withFetch(() => jsonResponse(PROSE + BLOCK), async () => {
    const out = await callOpenAI(OPENAI, [{ role: 'user', content: 'x' }], [], {});
    assert.equal(out.content, PROSE + BLOCK);
    assert.equal(out.toolCalls, undefined);
  });
});
