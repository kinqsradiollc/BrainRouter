import test from 'node:test';
import assert from 'node:assert/strict';
import { callOpenAIStream } from '../agent/transport/llmTransport.js';
import type { LLMConfig } from '../config/config.js';
import { matildaReaskNote } from '../provider/providers/matilda/nativeChat.js';

// ADR-058 D22 — the transport's re-ask after the platform routes a client-tool
// request to its own code sandbox: the first attempt is cut at the sandbox's
// tool_start, the second carries the model's text as the assistant turn and the
// guard-shaped note as the last user message, and its output is the answer.

const MATILDA: LLMConfig = { provider: 'matilda', endpoint: 'https://matilda.maincode.com/api/v1', apiKey: 'mc_live_test', model: 'matilda' };
const BAR = '｜';
const BLOCK = `<${BAR}DSML${BAR}tool_call><${BAR}DSML${BAR}parameter name="name" string="true">list_dir</${BAR}DSML${BAR}parameter><${BAR}DSML${BAR}parameter name="arguments" string="true">{"path":"."}</${BAR}DSML${BAR}parameter></${BAR}DSML${BAR}tool_call>`;
const TOOLS = [{ type: 'function', function: { name: 'list_dir', description: 'List a directory.', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];

function sse(events: Array<[string, unknown]>): Response {
  const text = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const SANDBOX: Array<[string, unknown]> = [
  ['token', { content: "I'll explore the workspace to understand what we're working with." }],
  ['tool_start', { tool: 'processing' }],
  ['tool_start', { tool: 'assistant', input: 'Running code' }],
  ['error', { code: 'request_budget_exceeded', error: 'The assistant ran out of steps before it could finish.' }],
];
const CLIENT_CALL: Array<[string, unknown]> = [['token', { content: BLOCK }], ['done', {}]];

async function withFetch(responses: Response[], capture: unknown[], run: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    capture.push(JSON.parse(String(init?.body)));
    const next = responses.shift();
    if (!next) throw new Error('no more fake responses');
    return next;
  }) as typeof fetch;
  try { await run(); } finally { globalThis.fetch = original; }
}

test('a sandbox detour is cut and asked once more in the guard shape; the re-ask answers the turn', async () => {
  const bodies: any[] = [];
  const activity: string[] = [];
  await withFetch([sse(SANDBOX), sse(CLIENT_CALL)], bodies, async () => {
    const out = await callOpenAIStream(MATILDA, [{ role: 'user', content: 'any improvements we can do?' }], TOOLS, {}, {
      onProviderActivity: (a: { label: string }) => activity.push(a.label),
    });
    assert.equal(out.toolCalls?.length, 1, 'the re-ask produced the client tool call');
    assert.equal(out.toolCalls?.[0]?.function.name, 'list_dir');
    assert.equal(out.finishReason, 'tool_calls');
  });
  assert.equal(bodies.length, 2, 'exactly one re-ask');
  const first = bodies[0].messages, second = bodies[1].messages;
  assert.equal(first[first.length - 1].content, 'any improvements we can do?');
  assert.equal(second[second.length - 1].content, matildaReaskNote());
  assert.equal(second[second.length - 2].role, 'assistant');
  assert.match(second[second.length - 2].content, /explore the workspace/, 'the model\'s own announcement is the turn the guard replies to');
  assert.equal(second[second.length - 3].content, 'any improvements we can do?', 'the history is unchanged underneath');
  assert.ok(bodies[1].clientTools?.length >= 1, 'the client tools travel again');
  assert.ok(activity.includes('Matilda routed the request to its own sandbox'), 'the turn path shows the detour');
});

test('the re-ask is never re-asked: a second detour streams to its end and keeps the partial answer', async () => {
  const bodies: any[] = [];
  await withFetch([sse(SANDBOX), sse(SANDBOX)], bodies, async () => {
    const out = await callOpenAIStream(MATILDA, [{ role: 'user', content: 'any improvements we can do?' }], TOOLS, {}, {});
    assert.match(out.content, /explore the workspace/);
    assert.match(out.content, /Matilda stopped early/);
    assert.equal(out.finishReason, 'stop');
  });
  assert.equal(bodies.length, 2);
});

test('no client tools offered ⇒ no cut: the sandbox attempt is read as before', async () => {
  const bodies: any[] = [];
  await withFetch([sse(SANDBOX)], bodies, async () => {
    const out = await callOpenAIStream(MATILDA, [{ role: 'user', content: 'hello' }], [], {}, {});
    assert.match(out.content, /Matilda stopped early/);
  });
  assert.equal(bodies.length, 1);
});
