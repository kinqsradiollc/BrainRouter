import test from 'node:test';
import assert from 'node:assert/strict';
import { childConversationJson, formatChildConversationList } from '../runtime/conversations/conversationsCommand.js';
import type { ChildConversationRecord } from '@kinqs/brainrouter-core/session';

function record(overrides: Partial<ChildConversationRecord> = {}): ChildConversationRecord {
  return {
    id: 'conv_12345678',
    sessionKey: 'session:parent:child:conv_12345678',
    parentSessionKey: 'session:parent',
    parentRuntimeId: 'rt_parent',
    repo: 'acme/project',
    branch: 'feature/x',
    model: 'test-model',
    title: 'Investigate preview',
    status: 'open',
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
    ...overrides,
  };
}

test('formatChildConversationList renders open child conversations', () => {
  const text = formatChildConversationList([record()]);
  assert.match(text, /Child Conversations \(1\)/);
  assert.match(text, /open\s+conv_12345678/);
  assert.match(text, /acme\/project@feature\/x/);
  assert.match(text, /runtime=rt_parent/);
  assert.match(text, /model=test-model/);
  assert.match(text, /Investigate preview/);
});

test('childConversationJson emits a machine-readable envelope', () => {
  const parsed = JSON.parse(childConversationJson([record({ status: 'closed' })]));
  assert.equal(parsed.conversations[0].status, 'closed');
  assert.equal(parsed.conversations[0].parentRuntimeId, 'rt_parent');
});

test('formatChildConversationList reports empty state', () => {
  assert.equal(formatChildConversationList([]), 'No child conversations yet.\n');
});
