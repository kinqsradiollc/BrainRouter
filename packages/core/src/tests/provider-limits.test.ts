import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChatCompletionPayload } from '../agent/transport/llmTransport.js';
import type { LLMConfig } from '../config/config.js';

// ADR-058 — `ProviderDefinition.limits`: a provider declares the hard per-request
// limits its endpoint enforces and the transport shapes the request to fit,
// instead of letting a full agent turn be rejected outright. The numbers below
// are Matilda's, measured against the live endpoint: a 64 KiB request body
// (65 536 bytes → 200, 65 537 → 403 `{"error":"forbidden"}`, enforced at the
// edge BEFORE validation) and 16 000 CHARACTERS of `content` per message
// (16 001 → 400). The byte limit is on the WIRE — UTF-8 bytes, not JS chars.

const MATILDA: LLMConfig = {
  provider: 'matilda',
  endpoint: 'https://matilda.maincode.com/api/v1',
  apiKey: 'mc_live_test',
  model: 'matilda',
};
// A provider with NO declared limits — the control: nothing is touched.
const OPENAI: LLMConfig = { provider: 'openai', endpoint: 'https://api.openai.com/v1', apiKey: 'sk-test', model: 'gpt-5' };

const BODY_LIMIT = 65_536;
const MSG_LIMIT = 16_000;
const utf8 = (s: string): number => Buffer.byteLength(s, 'utf8');

function tool(name: string, description: string) {
  return { name, description, inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };
}

// ~200 tools × ~1 KB — well over the byte budget. Descriptions carry multi-byte
// characters (em-dashes) so JS `length` UNDER-counts the wire bytes, the exact
// trap a character-based measure falls into.
function heavyTools(count = 200) {
  return Array.from({ length: count }, (_, i) => tool(`tool_${i}`, `Tool number ${i} — does a thing — ${'—'.repeat(300)}`));
}

test('limits.maxMessageChars: an over-long message is cut from the tail to the limit, with a marker', () => {
  const sys = 'INSTRUCTIONS-FIRST ' + 'x'.repeat(25_000);
  const body = buildChatCompletionPayload(MATILDA, [
    { role: 'system', content: sys },
    { role: 'user', content: 'hello' },
  ], [], {});
  const [system, user] = body.messages as Array<{ content: string }>;
  assert.ok(system.content.length <= MSG_LIMIT, `system must be ≤ ${MSG_LIMIT} chars, got ${system.content.length}`);
  assert.ok(system.content.startsWith('INSTRUCTIONS-FIRST'), 'the HEAD (front-loaded instructions) is what survives');
  assert.ok(system.content.endsWith("[truncated to the provider's per-message limit]"), 'a visible marker ends the cut');
  assert.equal(user.content, 'hello', 'a short message is untouched');
});

test('limits.maxBodyBytes: the tool list is fitted to the budget measured in UTF-8 BYTES, keeping the task-relevant tools', () => {
  const tools = [...heavyTools(), tool('read_file', 'Read a file from the workspace')];
  const messages = [
    { role: 'system', content: 'You are an agent.' },
    { role: 'user', content: 'please read the file at src/index.ts' },
  ];
  const body = buildChatCompletionPayload(MATILDA, messages, tools, {});
  const json = JSON.stringify(body);
  assert.ok(utf8(json) <= BODY_LIMIT, `wire body must be ≤ ${BODY_LIMIT} UTF-8 bytes, got ${utf8(json)}`);
  assert.ok(json.length < utf8(json), 'the fixture really is multi-byte (chars < bytes), so a char-based measure would have overshot');
  const kept = (body.tools ?? []).map((t) => t.function.name);
  assert.ok(kept.length > 0 && kept.length < tools.length, `fitted to a strict subset, got ${kept.length}/${tools.length}`);
  assert.ok(kept.includes('read_file'), 'the tool relevant to the task ("read … file") survives the fit');
  assert.equal(body.tool_choice, 'auto');
});

test('limits: a request already under both limits is left byte-for-byte alone', () => {
  const tools = [tool('read_file', 'Read a file')];
  const messages = [{ role: 'system', content: 'short' }, { role: 'user', content: 'hi' }];
  const a = buildChatCompletionPayload(MATILDA, messages, tools, {});
  assert.equal(a.tools?.length, 1);
  assert.equal((a.messages[0] as { content: string }).content, 'short');
});

test('limits: a provider that declares none is untouched even when huge', () => {
  const sys = 'x'.repeat(25_000);
  const tools = heavyTools();
  const body = buildChatCompletionPayload(OPENAI, [{ role: 'system', content: sys }, { role: 'user', content: 'hi' }], tools, {});
  assert.equal((body.messages[0] as { content: string }).content.length, 25_000, 'no message cap without a declared limit');
  assert.equal(body.tools?.length, tools.length, 'no tool fit without a declared limit');
});

test('matilda never receives reasoning_effort (strict body validation rejects it), even at high effort', () => {
  const body = buildChatCompletionPayload(MATILDA, [{ role: 'user', content: 'hi' }], [], { effort: 'high' });
  assert.equal('reasoning_effort' in body, false);
  assert.equal('reasoning' in body, false);
  // …while a provider that accepts the field still gets it.
  const oa = buildChatCompletionPayload(OPENAI, [{ role: 'user', content: 'hi' }], [], { effort: 'high' });
  assert.equal((oa as { reasoning_effort?: string }).reasoning_effort, 'high');
});
