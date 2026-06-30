/** HONK-L4 — the tools drop-and-retry decision + body stripping (callOpenAI). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isToolsUnsupportedError, stripToolsFromBody } from '../agent/agent.js';

test('isToolsUnsupportedError fires on a tools/tool_choice-blaming 4xx', () => {
  assert.equal(isToolsUnsupportedError(400, 'Error: tool_choice is not supported by this model'), true);
  assert.equal(isToolsUnsupportedError(400, '"tools" parameter is not supported'), true);
  assert.equal(isToolsUnsupportedError(404, 'function calling unavailable for this endpoint'), true);
  assert.equal(isToolsUnsupportedError(422, 'Unexpected field: tool_choice'), true);
});

test('isToolsUnsupportedError does NOT fire on unrelated errors or non-4xx', () => {
  // Wrong status — a 429/5xx must stay on the reconnect path, never strip tools.
  assert.equal(isToolsUnsupportedError(429, 'tools rate limited'), false);
  assert.equal(isToolsUnsupportedError(500, 'tool_choice internal error'), false);
  // 400 but not about tools — must not strip tools (would lose tool-calling for a real bug).
  assert.equal(isToolsUnsupportedError(400, 'invalid value for temperature'), false);
  assert.equal(isToolsUnsupportedError(400, 'context length exceeded'), false);
});

test('stripToolsFromBody removes tools + tool_choice, leaves the rest, and is a no-op without tools', () => {
  const body = { model: 'x', messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function' }], tool_choice: 'auto', temperature: 0.2 };
  const stripped = stripToolsFromBody(body);
  assert.ok(stripped);
  assert.equal('tools' in stripped, false);
  assert.equal('tool_choice' in stripped, false);
  assert.equal(stripped.temperature, 0.2, 'unrelated fields preserved');
  assert.deepEqual(body.tools, [{ type: 'function' }], 'original body not mutated');

  // No tools → undefined so the caller skips the retry entirely.
  assert.equal(stripToolsFromBody({ model: 'x', messages: [] }), undefined);
  assert.equal(stripToolsFromBody({ model: 'x', tools: [] }), undefined, 'empty tools array is not a tools request');
  // A lone forced tool_choice still triggers a strip.
  assert.ok(stripToolsFromBody({ model: 'x', tool_choice: { type: 'function', function: { name: 'f' } } }));
});
