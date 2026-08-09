import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentCommand } from '@kinqs/brainrouter-agent-protocol';
import {
  INTERNAL_ACTIVE_ORG_QUERY_PREFIX,
  broadcastActiveOrgSelection,
  isActiveOrgSelectionQuery,
  isInternalActiveOrgResult,
} from './activeOrgHostBroadcast.js';

function sink(): { messages: AgentCommand[]; postMessage(message: AgentCommand): void } {
  const messages: AgentCommand[] = [];
  return { messages, postMessage: (message) => { messages.push(message); } };
}

test('active-org selection fans out once to every live host and preserves one renderer response id', () => {
  const active = sink();
  const background = sink();
  const otherWindow = sink();
  const command: AgentCommand = {
    kind: 'query',
    id: 'renderer-query',
    name: 'account-set-active-org',
    args: { orgId: 'org-next' },
  };
  assert.equal(isActiveOrgSelectionQuery(command), true);
  if (!isActiveOrgSelectionQuery(command)) throw new Error('query guard failed');

  const sent = broadcastActiveOrgSelection(
    command,
    active,
    [active, background, otherWindow, background],
    'batch-1',
  );

  assert.equal(sent, 3);
  assert.equal(active.messages[0]?.kind, 'query');
  assert.equal((active.messages[0] as Extract<AgentCommand, { kind: 'query' }>).id, 'renderer-query');
  for (const host of [background, otherWindow]) {
    const forwarded = host.messages[0] as Extract<AgentCommand, { kind: 'query' }>;
    assert.match(forwarded.id, new RegExp(`^${INTERNAL_ACTIVE_ORG_QUERY_PREFIX}`));
    assert.equal(forwarded.name, command.name);
    assert.deepEqual(forwarded.args, command.args);
  }
});

test('only internal active-org query results are consumed by main', () => {
  assert.equal(isInternalActiveOrgResult({
    event: { kind: 'query-result', id: `${INTERNAL_ACTIVE_ORG_QUERY_PREFIX}batch:1`, ok: true },
  }), true);
  assert.equal(isInternalActiveOrgResult({
    event: { kind: 'query-result', id: 'renderer-query', ok: true },
  }), false);
  assert.equal(isInternalActiveOrgResult({
    event: { kind: 'turn-complete', id: `${INTERNAL_ACTIVE_ORG_QUERY_PREFIX}batch:1` },
  }), false);
});
