import test from 'node:test';
import assert from 'node:assert/strict';
import { _resetCliKnobsCache, resolveCliKnobs, setCliKnobOverride } from '../config/config.js';
import { attachCompactedResultHandoff, ResultCache } from '../util/result/resultHandoff.js';
import { compactToolOutput } from '../prompt/compaction/toolCompaction.js';
import { runExtractResult } from '../tool/result/extractResult.js';

function withKnobs<T>(knobs: Parameters<typeof setCliKnobOverride>[0], fn: () => T): T {
  _resetCliKnobsCache();
  setCliKnobOverride(knobs);
  try {
    return fn();
  } finally {
    _resetCliKnobsCache();
  }
}

test('tool-output compression defaults off and preserves the prior output byte-for-byte', () => {
  const input = { toolName: 'read_file', output: JSON.stringify(Array.from({ length: 40 }, (_, id) => ({ id, message: `row ${id}` }))) };
  const baseline = withKnobs({ contextCompaction: false, toolOutputCompressionEnabled: false }, () => compactToolOutput(input));
  const result = withKnobs({ contextCompaction: false, toolOutputCompressionEnabled: false }, () => compactToolOutput(input));

  assert.equal(JSON.stringify(result), JSON.stringify(baseline));
  assert.equal(result.inlineText, input.output);
  assert.equal(result.ruleId, 'disabled');
  assert.equal(result.requiresResultHandoff, undefined);
});

test('tool-output compression keeps JSON anchors, errors, and numeric anomalies', () => {
  const rows = Array.from({ length: 120 }, (_, id) => ({
    id,
    latency: id === 87 ? 99_999 : id % 9,
    message: id === 51 ? 'ERROR database failed' : `normal row ${id}`,
  }));
  const result = withKnobs({
    contextCompaction: false,
    toolOutputCompressionEnabled: true,
    toolOutputCompressionMinChars: 100,
    toolOutputCompressionTargetKeep: 0.2,
  }, () => compactToolOutput({ toolName: 'search', output: JSON.stringify(rows) }));
  const compactedRows = JSON.parse(result.inlineText) as Array<{ id?: number; message?: string; _result_dropped?: string }>;

  assert.equal(result.ruleId, 'smart-json-array');
  assert.equal(result.requiresResultHandoff, true);
  assert.equal(compactedRows[0]?.id, 0);
  assert.equal(compactedRows.some((row) => row.id === 119), true);
  assert.equal(compactedRows.some((row) => row.id === 51), true);
  assert.equal(compactedRows.some((row) => row.id === 87), true);
  assert.match(compactedRows.at(-1)?._result_dropped ?? '', /^\d+ rows omitted; use extract_result with resultRef$/);
});

test('tool-output compression leaves small outputs unchanged when enabled', () => {
  const input = { toolName: 'read_file', output: JSON.stringify([{ id: 1, message: 'small result' }]) };
  const result = withKnobs({
    contextCompaction: false,
    toolOutputCompressionEnabled: true,
    toolOutputCompressionMinChars: 1,
    toolOutputCompressionTargetKeep: 0.2,
  }, () => compactToolOutput(input));

  assert.equal(result.inlineText, input.output);
  assert.equal(result.requiresResultHandoff, undefined);
});

test('a compressed tool result parks the exact original in the existing result cache', () => {
  const cache = new ResultCache();
  const original = JSON.stringify(Array.from({ length: 80 }, (_, id) => ({ id, message: `row ${id}` })));
  const attached = attachCompactedResultHandoff(cache, original, '[compressed JSON summary]', {
    label: 'search',
    idGenerator: () => 'res_compact',
  });

  assert.match(attached.content, /resultRef=res_compact/);
  assert.equal(cache.get('res_compact'), original);
  assert.equal(runExtractResult({ resultRef: 'res_compact', maxChars: original.length + 1 }, cache).returned, original);
});

test('new runtime knobs resolve only from cli config and default to disabled', () => {
  const defaults = resolveCliKnobs({ activeServer: '', servers: {} });
  assert.deepEqual({
    toolOutputCompressionEnabled: defaults.toolOutputCompressionEnabled,
    toolOutputCompressionMinChars: defaults.toolOutputCompressionMinChars,
    toolOutputCompressionTargetKeep: defaults.toolOutputCompressionTargetKeep,
    effortRoutingMode: defaults.effortRoutingMode,
    effortForToolResumeTurns: defaults.effortForToolResumeTurns,
    verbositySteeringLevel: defaults.verbositySteeringLevel,
    agentMcpToolBudget: defaults.agentMcpToolBudget,
  }, {
    toolOutputCompressionEnabled: false,
    toolOutputCompressionMinChars: 2_000,
    toolOutputCompressionTargetKeep: 0.2,
    effortRoutingMode: 'off',
    effortForToolResumeTurns: 'low',
    verbositySteeringLevel: 0,
    agentMcpToolBudget: 16,
  });
});

test('json-summary never stubs a result the per-result cap can carry, and a stubbed one keeps a head + a resultRef', () => {
  // A 61-entry directory listing (~4 KB): must reach the model whole.
  const listing = JSON.stringify(Array.from({ length: 61 }, (_, i) => ({ name: `file-${i}.ts`, type: 'file', size: 1000 + i })), null, 2);
  const whole = withKnobs({ contextCompaction: true, toolOutputCompressionEnabled: false, maxToolResultChars: 8_000 }, () => compactToolOutput({ toolName: 'list_dir', output: listing }));
  assert.equal(whole.inlineText, listing);
  assert.equal(whole.ruleId, 'passthrough');
  // Beyond the cap: summarised, but with the head of the data and a handoff the model can expand.
  const big = JSON.stringify(Array.from({ length: 900 }, (_, i) => ({ name: `file-${i}.ts`, type: 'file', size: 1000 + i })), null, 2);
  const stub = withKnobs({ contextCompaction: true, toolOutputCompressionEnabled: false, maxToolResultChars: 8_000 }, () => compactToolOutput({ toolName: 'list_dir', output: big }));
  assert.equal(stub.ruleId, 'json-summary');
  assert.equal(stub.requiresResultHandoff, true, 'a resultRef is attached so extract_result can read the rest');
  assert.match(stub.inlineText, /array length=900/);
  assert.match(stub.inlineText, /head: \[\{"name":"file-0\.ts"/);
  assert.match(stub.inlineText, /extract_result/);
  const attached = attachCompactedResultHandoff(new ResultCache(), big, stub.inlineText, { label: 'list_dir' });
  assert.match(attached.content, /resultRef/);
});


test('command-signal-lines applies to command-shaped tools only: a read_file of a URL-rich README passes through whole', () => {
  const readme = ['# BrainRouter', ...Array.from({ length: 120 }, (_, i) => `[![badge ${i}](https://img.shields.io/badge/b${i}.svg)](https://example.com/${i})`), 'See docs/setup.md and packages/core/src/index.ts.'].join('\n');
  const read = withKnobs({ contextCompaction: true, toolOutputCompressionEnabled: false, maxToolResultChars: 8_000 }, () => compactToolOutput({ toolName: 'read_file', args: { path: 'README.md' }, output: readme }));
  assert.equal(read.ruleId, 'passthrough');
  assert.equal(read.inlineText, readme);
  const run = withKnobs({ contextCompaction: true, toolOutputCompressionEnabled: false, maxToolResultChars: 8_000 }, () => compactToolOutput({ toolName: 'run_command', args: { command: 'cat README.md' }, output: readme }));
  assert.equal(run.ruleId, 'command-signal-lines', 'the same text as a command output is still summarised');
});
