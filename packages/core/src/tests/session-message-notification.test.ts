/**
 * ADR-034 notification regressions: a wake contains bounded durable ids only
 * and cannot replace polling or carry peer payload content.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpClientWrapper } from '../mcp/client/client.js';
import { SESSION_MESSAGE_NOTIFICATION_METHOD } from '../mcp/sessionMessages.js';

test('MCP session-message notification wakes subscribers without carrying content', async () => {
  const wrapper = new McpClientWrapper();
  const server = new Server(
    { name: 'test-brain', version: '1.0.0' },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const wakes: Array<{ sessionKey: string; messageIds: string[] }> = [];
  const unsubscribe = wrapper.subscribeSessionMessageWakes((wake) => { wakes.push(wake); });

  await Promise.all([
    wrapper.client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  await server.notification({
    method: SESSION_MESSAGE_NOTIFICATION_METHOD,
    params: { sessionKey: 'recipient', messageIds: ['m1', 'm2'] },
  } as any);

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(wakes, [{ sessionKey: 'recipient', messageIds: ['m1', 'm2'] }]);

  unsubscribe();
  await Promise.all([wrapper.client.close(), server.close()]);
});
