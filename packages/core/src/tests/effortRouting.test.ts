import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTurn, resolveEffortForTurn } from '../agent/effortRouting.js';

test('classifyTurn distinguishes new asks, mechanical tool continuations, and errors', () => {
  assert.equal(classifyTurn([{ role: 'user', content: 'Review this change.' }]), 'NEW_USER_ASK');
  assert.equal(classifyTurn([{ role: 'assistant', content: '', tool_calls: [{}] }, { role: 'tool', content: 'search completed' }]), 'MECHANICAL_CONTINUATION');
  assert.equal(classifyTurn([{ role: 'tool', content: 'command failed', isError: true }]), 'ERROR_CONTINUATION');
});

test('adaptive routing lowers only high-effort mechanical continuations', () => {
  const mechanical = [{ role: 'tool', content: 'read complete' }];
  assert.equal(resolveEffortForTurn('high', mechanical, { effortRoutingMode: 'adaptive', effortForToolResumeTurns: 'low' }), 'low');
  assert.equal(resolveEffortForTurn('xhigh', mechanical, { effortRoutingMode: 'adaptive', effortForToolResumeTurns: 'medium' }), 'medium');
  assert.equal(resolveEffortForTurn('medium', mechanical, { effortRoutingMode: 'adaptive', effortForToolResumeTurns: 'low' }), 'medium');
});

test('new asks, error continuations, and default-off routing preserve the selected effort byte-for-byte', () => {
  const high = 'high' as const;
  const newAsk = [{ role: 'user', content: 'Investigate the incident.' }];
  const errored = [{ role: 'tool', content: 'failure', isError: true }];
  const mechanical = [{ role: 'tool', content: 'ok' }];

  assert.strictEqual(resolveEffortForTurn(high, newAsk, { effortRoutingMode: 'adaptive', effortForToolResumeTurns: 'low' }), high);
  assert.strictEqual(resolveEffortForTurn(high, errored, { effortRoutingMode: 'adaptive', effortForToolResumeTurns: 'low' }), high);
  assert.strictEqual(resolveEffortForTurn(high, mechanical, { effortRoutingMode: 'off', effortForToolResumeTurns: 'low' }), high);
});
