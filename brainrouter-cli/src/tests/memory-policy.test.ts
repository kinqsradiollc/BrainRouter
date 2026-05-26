import test from 'node:test';
import assert from 'node:assert/strict';
import { assessCapturePayload, assessRecallCards } from '../memory/memoryPolicy.js';

test('memoryPolicy: assessCapturePayload blocks OpenAI-style key', () => {
  const result = assessCapturePayload('here is my key sk-abcdefghijklmnopqrstuvwxyzABCD');
  assert.equal(result.blocked, true);
  assert.match(result.reason ?? '', /credential-shaped/);
});

test('memoryPolicy: assessCapturePayload blocks PEM private key block', () => {
  const result = assessCapturePayload('-----BEGIN RSA PRIVATE KEY-----\nMIIB');
  assert.equal(result.blocked, true);
});

test('memoryPolicy: assessCapturePayload passes innocuous text', () => {
  const result = assessCapturePayload('fix the briefing inspector to render warnings');
  assert.equal(result.blocked, false);
});

test('memoryPolicy: assessRecallCards warns on stale-tagged records', () => {
  const warnings = assessRecallCards(
    [{ recordId: 'r1', content: 'this approach is superseded by the new router' }],
    { workspaceRoot: '/tmp/ws' },
  );
  assert.ok(warnings.some((w) => /stale|superseded/i.test(w)));
});

test('memoryPolicy: assessRecallCards warns on off-workspace paths', () => {
  const warnings = assessRecallCards(
    [{ recordId: 'r1', content: 'edited /var/other/project/src/foo.ts last week' }],
    { workspaceRoot: '/tmp/ws' },
  );
  assert.ok(warnings.some((w) => /outside/i.test(w)));
});

test('memoryPolicy: assessRecallCards is silent on healthy records', () => {
  const warnings = assessRecallCards(
    [{ recordId: 'r1', content: 'use describeSourcePlan from briefing' }],
    { workspaceRoot: '/tmp/ws' },
  );
  assert.equal(warnings.length, 0);
});
