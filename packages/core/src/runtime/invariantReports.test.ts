/**
 * ADR-046 D2 — the tripwire channel and the tool-call pairing reporter.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  noteRuntimeInvariantBreak,
  runtimeInvariantReportTotals,
  resetRuntimeInvariantReports,
  reportPairingRepair,
} from './invariantReports.js';
import { sanitizeToolCallPairing } from '../agent/guards/toolCallRecovery.js';

const PAIRING = 'session/tool-call-pairing';

test('noteRuntimeInvariantBreak counts per id', () => {
  resetRuntimeInvariantReports();
  noteRuntimeInvariantBreak('a', 'x', 'first');
  noteRuntimeInvariantBreak('a', 'x', 'second');
  noteRuntimeInvariantBreak('b', 'y', 'once');
  assert.deepEqual(runtimeInvariantReportTotals(), { 'a/x': 2, 'b/y': 1 });
});

test('a well-formed history fires no pairing tripwire', () => {
  resetRuntimeInvariantReports();
  const clean = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', name: 'read_file', content: 'ok' },
  ];
  const out = sanitizeToolCallPairing(clean, reportPairingRepair);
  assert.equal(runtimeInvariantReportTotals()[PAIRING] ?? 0, 0);
  assert.deepEqual(out, clean); // idempotent passthrough
});

test('an orphaned tool_call synthesizes a placeholder AND fires the tripwire', () => {
  resetRuntimeInvariantReports();
  const broken = [
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_command', arguments: '{}' } }] },
    { role: 'user', content: 'next' },
  ];
  const out = sanitizeToolCallPairing(broken, reportPairingRepair);
  const synth = out.find((m: any) => m.role === 'tool' && m.tool_call_id === 'c1');
  assert.ok(synth, 'expected a synthesized placeholder result');
  assert.match(String((synth as any).content), /^ERROR:/);
  assert.equal(runtimeInvariantReportTotals()[PAIRING], 1);
});

test('duplicate + id-less calls each fire the tripwire', () => {
  resetRuntimeInvariantReports();
  const broken = [
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } },
        { id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } }, // duplicate id
        { id: '', type: 'function', function: { name: 'b', arguments: '{}' } }, // id-less
      ],
    },
    { role: 'tool', tool_call_id: 'c1', name: 'a', content: 'ok' },
  ];
  sanitizeToolCallPairing(broken, reportPairingRepair);
  assert.ok((runtimeInvariantReportTotals()[PAIRING] ?? 0) >= 2);
});
