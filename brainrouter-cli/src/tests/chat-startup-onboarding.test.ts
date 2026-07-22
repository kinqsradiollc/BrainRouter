import test from 'node:test';
import assert from 'node:assert/strict';
import { decideChatMcpStartup } from '../entry/chatCommand.js';

test('setup-time MCP Skip forces local-only mode even when saved profiles remain', () => {
  assert.deepEqual(decideChatMcpStartup({
    serverIds: ['saved-brain'],
    requestedProfile: undefined,
    strictMcp: false,
    mcpSkipped: true,
  }), { allowed: true, localOnly: true });
});

test('a profile-free non-strict launch remains usable with local tools', () => {
  assert.deepEqual(decideChatMcpStartup({
    serverIds: [],
    requestedProfile: undefined,
    strictMcp: false,
    mcpSkipped: false,
  }), { allowed: true, localOnly: true });
});

test('strict MCP rejects both explicit Skip and a profile-free config', () => {
  for (const input of [
    { serverIds: ['saved-brain'], mcpSkipped: true },
    { serverIds: [], mcpSkipped: false },
  ]) {
    const decision = decideChatMcpStartup({
      ...input,
      requestedProfile: undefined,
      strictMcp: true,
    });
    assert.equal(decision.allowed, false);
    assert.match(decision.error ?? '', /strict-mcp/);
  }
});

test('an unknown requested profile is rejected before connection attempts', () => {
  const decision = decideChatMcpStartup({
    serverIds: ['local'],
    requestedProfile: 'missing',
    strictMcp: false,
    mcpSkipped: false,
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.error ?? '', /missing/);
});
