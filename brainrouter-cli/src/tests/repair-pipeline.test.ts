import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ToolCallRepair,
  analyzeSchema,
  flattenSchema,
  nestArguments,
  scavengeToolCalls,
  repairTruncatedJson,
  StormBreaker,
} from '../agent/repair/index.js';

// ---- flatten ----------------------------------------------------------

test('analyzeSchema: shallow schema with ≤10 leaves stays unflattened', () => {
  const decision = analyzeSchema({
    type: 'object',
    properties: {
      a: { type: 'string' },
      b: { type: 'number' },
      c: { type: 'boolean' },
    },
  });
  assert.equal(decision.shouldFlatten, false);
  assert.equal(decision.leafCount, 3);
});

test('analyzeSchema: schema with >10 leaves triggers flatten', () => {
  const props: Record<string, any> = {};
  for (let i = 0; i < 12; i++) props[`field${i}`] = { type: 'string' };
  const decision = analyzeSchema({ type: 'object', properties: props });
  assert.equal(decision.shouldFlatten, true);
  assert.equal(decision.leafCount, 12);
});

test('analyzeSchema: depth >2 triggers flatten', () => {
  const decision = analyzeSchema({
    type: 'object',
    properties: {
      a: { type: 'object', properties: { b: { type: 'object', properties: { c: { type: 'string' } } } } },
    },
  });
  assert.equal(decision.shouldFlatten, true);
  assert.ok(decision.maxDepth >= 3);
});

test('flattenSchema + nestArguments round-trip preserves structure', () => {
  const nested = {
    type: 'object',
    properties: {
      query: { type: 'string' },
      filters: {
        type: 'object',
        properties: {
          tag: { type: 'string' },
          priority: { type: 'number' },
        },
        required: ['tag'],
      },
    },
    required: ['query', 'filters'],
  };
  const flat = flattenSchema(nested);
  assert.ok(flat.properties?.['query']);
  assert.ok(flat.properties?.['filters.tag']);
  assert.ok(flat.properties?.['filters.priority']);
  assert.deepEqual(flat.required, ['query', 'filters.tag']);
  const renested = nestArguments({
    'query': 'auth bug',
    'filters.tag': 'security',
    'filters.priority': 5,
  });
  assert.deepEqual(renested, {
    query: 'auth bug',
    filters: { tag: 'security', priority: 5 },
  });
});

// ---- scavenge ---------------------------------------------------------

test('scavengeToolCalls picks up name+arguments shape', () => {
  const allowed = new Set(['read_file', 'list_directory']);
  const reasoning = `I'll read it. {"name": "read_file", "arguments": {"path": "src/agent.ts"}}`;
  const r = scavengeToolCalls(reasoning, { allowedNames: allowed });
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0]!.function.name, 'read_file');
  assert.equal(JSON.parse(r.calls[0]!.function.arguments).path, 'src/agent.ts');
});

test('scavengeToolCalls ignores unknown tool names', () => {
  const allowed = new Set(['read_file']);
  const r = scavengeToolCalls(
    `{"name": "make_coffee", "arguments": {"size": "L"}}`,
    { allowedNames: allowed },
  );
  assert.equal(r.calls.length, 0);
});

test('scavengeToolCalls accepts OpenAI-canonical tool_use envelope', () => {
  const allowed = new Set(['list_directory']);
  const r = scavengeToolCalls(
    `{"type":"function","function":{"name":"list_directory","arguments":"{\\"path\\":\\".\\"}"}}`,
    { allowedNames: allowed },
  );
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0]!.function.name, 'list_directory');
});

test('scavengeToolCalls caps at maxCalls', () => {
  const allowed = new Set(['read_file']);
  let text = '';
  for (let i = 0; i < 10; i++) text += `{"name":"read_file","arguments":{"path":"f${i}"}}\n`;
  const r = scavengeToolCalls(text, { allowedNames: allowed, maxCalls: 2 });
  assert.equal(r.calls.length, 2);
});

test('scavengeToolCalls returns empty on null / huge input', () => {
  const allowed = new Set(['read_file']);
  assert.equal(scavengeToolCalls(null, { allowedNames: allowed }).calls.length, 0);
  // 110 KB input bypasses the 100 KB cap.
  const r = scavengeToolCalls('x'.repeat(110_000), { allowedNames: allowed });
  assert.equal(r.calls.length, 0);
  assert.ok(r.notes[0]?.includes('too large'));
});

// ---- truncation -------------------------------------------------------

test('repairTruncatedJson closes unbalanced braces', () => {
  const r = repairTruncatedJson('{"path": "foo", "mode": "read"');
  assert.equal(r.changed, true);
  assert.equal(r.fallback, false);
  const parsed = JSON.parse(r.repaired);
  assert.deepEqual(parsed, { path: 'foo', mode: 'read' });
});

test('repairTruncatedJson closes unterminated string', () => {
  const r = repairTruncatedJson('{"path": "foo');
  assert.equal(r.changed, true);
  assert.equal(r.fallback, false);
  // Whatever survives must parse.
  JSON.parse(r.repaired);
});

test('repairTruncatedJson is no-op on valid JSON', () => {
  const r = repairTruncatedJson('{"path":"foo","mode":"read"}');
  assert.equal(r.changed, false);
  assert.equal(r.fallback, false);
});

test('repairTruncatedJson flags unrecoverable input', () => {
  const r = repairTruncatedJson(': this is not json at all }');
  assert.equal(r.fallback, true);
});

// ---- storm ------------------------------------------------------------

test('StormBreaker suppresses at the threshold-th identical call', () => {
  const sb = new StormBreaker(6, 3);
  const call = { function: { name: 'read_file', arguments: '{"path":"foo"}' } };
  assert.equal(sb.inspect(call).suppress, false);
  assert.equal(sb.inspect(call).suppress, false);
  // Threshold = 3 → the 3rd identical is suppressed.
  assert.equal(sb.inspect(call).suppress, true);
});

test('StormBreaker isMutating clears prior read-only entries', () => {
  const sb = new StormBreaker(6, 3, (c) => c.function.name === 'write_file');
  const r = { function: { name: 'read_file', arguments: '{"path":"a"}' } };
  const w = { function: { name: 'write_file', arguments: '{"path":"a","content":"x"}' } };
  assert.equal(sb.inspect(r).suppress, false);
  assert.equal(sb.inspect(r).suppress, false);
  assert.equal(sb.inspect(w).suppress, false);
  // Re-read after write is allowed without tripping the counter.
  assert.equal(sb.inspect(r).suppress, false);
  assert.equal(sb.inspect(r).suppress, false);
});

test('StormBreaker honours isStormExempt', () => {
  const sb = new StormBreaker(6, 3, undefined, (c) => c.function.name === 'get_status');
  const status = { function: { name: 'get_status', arguments: '{}' } };
  for (let i = 0; i < 10; i++) assert.equal(sb.inspect(status).suppress, false);
});

// ---- full pipeline ----------------------------------------------------

test('ToolCallRepair.process passes a clean call list through unchanged', () => {
  const repair = new ToolCallRepair({ allowedToolNames: new Set(['read_file']) });
  const declared = [{ id: 'a', function: { name: 'read_file', arguments: '{"path":"x"}' } }];
  const { calls, report } = repair.process(declared, null, null);
  assert.equal(calls.length, 1);
  assert.equal(report.scavenged, 0);
  assert.equal(report.stormsBroken, 0);
});

test('ToolCallRepair.process recovers a reasoning-content tool call', () => {
  const repair = new ToolCallRepair({ allowedToolNames: new Set(['read_file']) });
  const { calls, report } = repair.process(
    [],
    `Let me read it: {"name":"read_file","arguments":{"path":"src/foo.ts"}}`,
    null,
  );
  assert.equal(calls.length, 1);
  assert.equal(report.scavenged, 1);
});

test('ToolCallRepair.process repairs a truncated argument string', () => {
  const repair = new ToolCallRepair({ allowedToolNames: new Set(['read_file']) });
  const declared = [{ id: 'b', function: { name: 'read_file', arguments: '{"path":"foo"' } }];
  const { calls, report } = repair.process(declared, null, null);
  assert.equal(calls.length, 1);
  assert.equal(report.truncationsFixed, 1);
  // The repaired argument must parse.
  JSON.parse(typeof calls[0]!.function.arguments === 'string' ? calls[0]!.function.arguments : '');
});

test('ToolCallRepair.process suppresses the 4th identical call (pipeline default)', () => {
  // Default threshold is 4 (one step LATER than the existing legacy
  // per-turn guard, which catches the 4th identical first). Our
  // pipeline-level guard fires on calls 4+ as a complementary safety
  // net for cases the legacy guard missed.
  const repair = new ToolCallRepair({ allowedToolNames: new Set(['read_file']) });
  const make = (id: string) => ({ id, function: { name: 'read_file', arguments: '{"path":"x"}' } });
  // Calls 1–3 pass.
  for (let i = 1; i <= 3; i++) {
    const r = repair.process([make(`c${i}`)], null, null);
    assert.equal(r.calls.length, 1);
    assert.equal(r.report.stormsBroken, 0);
  }
  // 4th identical call → suppressed.
  const r4 = repair.process([make('c4')], null, null);
  assert.equal(r4.calls.length, 0);
  assert.equal(r4.report.stormsBroken, 1);
});
