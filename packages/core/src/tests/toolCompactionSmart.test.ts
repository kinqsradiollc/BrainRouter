import test from 'node:test';
import assert from 'node:assert/strict';
import { _resetCliKnobsCache, resolveCliKnobs, setCliKnobOverride } from '../config/config.js';
import { attachCompactedResultHandoff, ResultCache } from '../util/resultHandoff.js';
import { compactToolOutput } from '../prompt/toolCompaction.js';
import { runExtractResult } from '../tool/extractResult.js';

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
