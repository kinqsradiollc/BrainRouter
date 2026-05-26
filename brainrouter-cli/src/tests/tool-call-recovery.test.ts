import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dedupeToolCalls,
  parseArgumentsOrError,
  synthesizeOrphanResults,
  suggestSimilarToolName,
  type ToolCallLike,
  type ToolResultMessage,
} from '../agent/toolCallRecovery.js';
import { normalizeToolName } from '../agent/agent.js';

const tc = (id: string, name: string, args: string | object = '{}'): ToolCallLike => ({
  id,
  type: 'function',
  function: { name, arguments: args },
});

test('dedupeToolCalls: empty / nullish input returns []', () => {
  assert.deepEqual(dedupeToolCalls(undefined), []);
  assert.deepEqual(dedupeToolCalls(null), []);
  assert.deepEqual(dedupeToolCalls([]), []);
});

test('dedupeToolCalls: no duplicates is a passthrough', () => {
  const calls = [tc('a', 'read_file'), tc('b', 'list_dir')];
  assert.deepEqual(dedupeToolCalls(calls), calls);
});

test('dedupeToolCalls: keeps last occurrence of each id, preserves relative order', () => {
  const dropped: Array<{ id: string; idx: number }> = [];
  const result = dedupeToolCalls(
    [
      tc('a', 'read_file', '{"path":"first"}'),
      tc('b', 'list_dir'),
      tc('a', 'read_file', '{"path":"second"}'), // duplicate id, last one wins
      tc('c', 'grep_search'),
    ],
    (id, idx) => dropped.push({ id, idx }),
  );
  assert.equal(result.length, 3);
  // The kept `a` is the LAST one (args=second).
  const keptA = result.find((c) => c.id === 'a');
  assert.equal((keptA?.function.arguments as string), '{"path":"second"}');
  // Original relative order is preserved among the survivors.
  assert.deepEqual(result.map((c) => c.id), ['b', 'a', 'c']);
  // Warning fired for the dropped first occurrence.
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].id, 'a');
});

test('dedupeToolCalls: id-less calls pass through unchanged (orphan path will handle)', () => {
  const calls = [tc('', 'no_id'), { id: undefined as any, type: 'function', function: { name: 'also_no', arguments: '{}' } }, tc('x', 'ok')];
  const out = dedupeToolCalls(calls as any);
  assert.equal(out.length, 3);
});

test('parseArgumentsOrError: valid JSON parses', () => {
  const parsed = parseArgumentsOrError(tc('1', 'read_file', '{"path":"src/foo.ts"}'));
  assert.equal(parsed.error, undefined);
  assert.deepEqual(parsed.args, { path: 'src/foo.ts' });
  assert.equal(parsed.rawArguments, '{"path":"src/foo.ts"}');
});

test('parseArgumentsOrError: malformed JSON returns structured error, does not throw', () => {
  const parsed = parseArgumentsOrError(tc('1', 'read_file', '{"path":"src/foo.ts",}')); // trailing comma
  assert.notEqual(parsed.error, undefined);
  assert.match(parsed.error!, /Tool argument JSON was malformed/);
  assert.match(parsed.error!, /Re-issue the tool call/);
  // Raw arguments are echoed so the model can spot its own mistake.
  assert.match(parsed.error!, /Raw arguments emitted by the model:/);
  assert.deepEqual(parsed.args, {});
});

test('parseArgumentsOrError: already-parsed object args pass through', () => {
  const parsed = parseArgumentsOrError({
    id: '1', type: 'function', function: { name: 'x', arguments: { foo: 1 } },
  });
  assert.equal(parsed.error, undefined);
  assert.deepEqual(parsed.args, { foo: 1 });
});

test('parseArgumentsOrError: empty / missing arguments treated as {}', () => {
  assert.deepEqual(parseArgumentsOrError(tc('1', 'x', '')).args, {});
  assert.deepEqual(parseArgumentsOrError({ id: '1', type: 'function', function: { name: 'x', arguments: undefined as any } }).args, {});
});

test('parseArgumentsOrError: huge raw arguments are truncated in the error message', () => {
  const huge = '{' + 'a'.repeat(2000); // malformed and long
  const parsed = parseArgumentsOrError(tc('1', 'x', huge));
  assert.notEqual(parsed.error, undefined);
  assert.match(parsed.error!, /truncated \d+ chars/);
});

test('synthesizeOrphanResults: empty calls returns []', () => {
  assert.deepEqual(synthesizeOrphanResults(undefined, []), []);
  assert.deepEqual(synthesizeOrphanResults([], []), []);
});

test('synthesizeOrphanResults: all calls paired => no synthetics', () => {
  const calls = [tc('a', 'read_file'), tc('b', 'list_dir')];
  const results: ToolResultMessage[] = [
    { role: 'tool', tool_call_id: 'a', name: 'read_file', content: 'ok' },
    { role: 'tool', tool_call_id: 'b', name: 'list_dir', content: 'ok' },
  ];
  assert.deepEqual(synthesizeOrphanResults(calls, results), []);
});

test('synthesizeOrphanResults: unmatched ids produce synthetic ERROR envelopes', () => {
  const calls = [tc('a', 'read_file'), tc('b', 'list_dir'), tc('c', 'spawn_agent')];
  const results: ToolResultMessage[] = [
    { role: 'tool', tool_call_id: 'a', name: 'read_file', content: 'ok' },
  ];
  const synth = synthesizeOrphanResults(calls, results);
  assert.equal(synth.length, 2);
  assert.deepEqual(synth.map((s) => s.tool_call_id), ['b', 'c']);
  for (const s of synth) {
    // CRITICAL: must start with ERROR: so the R1 child-drain guardrail's
    // parseJsonObject returns undefined and doesn't think spawn_agent ran.
    assert.match(s.content, /^ERROR:/);
    assert.equal(s.isError, true);
    assert.equal(s.role, 'tool');
  }
});

test('synthesizeOrphanResults: synthetic content is plain string (not JSON) to dodge child-drain guardrail', () => {
  const calls = [tc('c', 'spawn_agent')];
  const synth = synthesizeOrphanResults(calls, []);
  assert.equal(synth.length, 1);
  // Round-trip through JSON.parse must NOT yield an object — otherwise
  // parseJsonObject in agent.ts would return a record and the guardrail
  // would try to wait on a non-existent child id.
  let parsed: any;
  try { parsed = JSON.parse(synth[0].content); } catch { parsed = undefined; }
  assert.equal(typeof parsed === 'object' && parsed !== null, false);
});

test('synthesizeOrphanResults: ignores id-less calls (they cannot be paired anyway)', () => {
  const calls = [tc('', 'no_id'), tc('x', 'real')];
  const synth = synthesizeOrphanResults(calls, []);
  assert.equal(synth.length, 1);
  assert.equal(synth[0].tool_call_id, 'x');
});

test('suggestSimilarToolName: returns undefined when name already matches a candidate', () => {
  assert.equal(suggestSimilarToolName('read_file', ['read_file', 'list_dir'], normalizeToolName), undefined);
});

test('suggestSimilarToolName: returns canonical when case/separator differs', () => {
  assert.equal(suggestSimilarToolName('Read-File', ['read_file', 'list_dir'], normalizeToolName), 'read_file');
  assert.equal(suggestSimilarToolName('LIST.DIR', ['read_file', 'list_dir'], normalizeToolName), 'list_dir');
});

test('suggestSimilarToolName: returns undefined when no candidate matches', () => {
  assert.equal(suggestSimilarToolName('frobnicate', ['read_file'], normalizeToolName), undefined);
});

test('suggestSimilarToolName: tolerates the mcp_<server>_<tool> single-underscore prefix', () => {
  // Single-underscore convention (R5). If the model emits with a different
  // separator inside the prefixed name, normalizeToolName flattens both
  // sides and the suggestion still lands.
  const candidates = ['mcp_brainrouter_memory_recall', 'read_file'];
  assert.equal(
    suggestSimilarToolName('MCP-Brainrouter-Memory-Recall', candidates, normalizeToolName),
    'mcp_brainrouter_memory_recall',
  );
});
