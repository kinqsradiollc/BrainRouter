/**
 * ADR-034 MCP transport regressions: authenticated connection ownership,
 * durable poll fallback, and ID-only wakes remain tenant-scoped and truthful.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SessionMessageNotificationSchema,
} from '@kinqs/brainrouter-core/mcp';

const mocks = vi.hoisted(() => ({
  registerActiveSession: vi.fn(),
  heartbeatActiveSession: vi.fn(),
  ownsActiveSessionClaim: vi.fn(),
  unregisterActiveSession: vi.fn(),
  routeSessionMessage: vi.fn(),
  readSessionInbox: vi.fn(),
  transitionSessionMessages: vi.fn(),
  readSessionMessageReceipts: vi.fn(),
  ackSessionMessageReceipts: vi.fn(),
}));

vi.mock('../memory/engine.js', () => ({
  memoryEngine: { store: mocks },
}));

import { Registry } from '../registry.js';
import { SessionDeliveryHub } from '../services/sessionDeliveryHub.js';
import { buildMcpServer } from './mcpServer.js';

describe('session messaging MCP push', () => {
  const closers: Array<() => Promise<unknown>> = [];
  let hub: SessionDeliveryHub;

  beforeEach(() => {
    vi.clearAllMocks();
    hub = new SessionDeliveryHub();
    mocks.registerActiveSession.mockImplementation(async (record) => record);
    mocks.heartbeatActiveSession.mockResolvedValue(true);
    mocks.ownsActiveSessionClaim.mockResolvedValue(true);
    mocks.unregisterActiveSession.mockResolvedValue(true);
    mocks.readSessionInbox.mockResolvedValue([]);
    const delivery = {
      id: 'message-1',
      orgId: null,
      userId: 'user-a',
      messageId: 'client-message-1',
      fromSessionKey: 'sender',
      toSessionKey: 'recipient',
      kind: 'text',
      payload: { text: 'correct course' },
      status: 'pending',
      createdAt: '2026-08-11T00:00:00.000Z',
      deliveredAt: null,
    };
    mocks.routeSessionMessage.mockResolvedValue({
      messageId: 'client-message-1',
      state: 'persisted-unseen',
      deliveries: [delivery],
      receipts: [delivery],
      accepted: 1,
      rejected: 0,
      idempotentReplay: false,
    });
    mocks.transitionSessionMessages.mockResolvedValue([]);
    mocks.readSessionMessageReceipts.mockResolvedValue([]);
    mocks.ackSessionMessageReceipts.mockResolvedValue(0);
  });

  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  async function connect(connectionId: string, defaultOrgId?: string) {
    const registry = new Registry({ globalRoot: '/nonexistent', localRoot: '/nonexistent' });
    const server = buildMcpServer(registry, {
      defaultUserId: 'user-a',
      defaultOrgId,
      connectionId,
      sessionDeliveryHub: hub,
    });
    const client = new Client({ name: connectionId, version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closers.push(async () => { hub.disconnect(connectionId); await client.close(); await server.close(); });
    return client;
  }

  it('never exposes claim-less session ownership paths through MCP', async () => {
    const registry = new Registry({ globalRoot: '/nonexistent', localRoot: '/nonexistent' });
    const server = buildMcpServer(registry, { defaultUserId: 'user-a' });
    const client = new Client({ name: 'unclaimed', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closers.push(async () => { await client.close(); await server.close(); });

    for (const name of [
      'session_register',
      'session_heartbeat',
      'session_unregister',
      'session_send',
      'session_inbox_read',
      'session_inbox_ack',
      'session_receipts',
      'session_receipts_ack',
    ]) {
      const result = await client.callTool({ name, arguments: {} });
      expect(result.isError, name).toBe(true);
      expect(String((result.content as Array<{ text: string }>)[0]?.text), name)
        .toContain('requires a server-owned MCP connection claim');
    }

    expect(mocks.registerActiveSession).not.toHaveBeenCalled();
    expect(mocks.heartbeatActiveSession).not.toHaveBeenCalled();
    expect(mocks.unregisterActiveSession).not.toHaveBeenCalled();
    expect(mocks.routeSessionMessage).not.toHaveBeenCalled();
    expect(mocks.readSessionInbox).not.toHaveBeenCalled();
    expect(mocks.transitionSessionMessages).not.toHaveBeenCalled();
    expect(mocks.readSessionMessageReceipts).not.toHaveBeenCalled();
    expect(mocks.ackSessionMessageReceipts).not.toHaveBeenCalled();
  });

  it('uses a notification as a wake hint after the durable row is persisted', async () => {
    const recipient = await connect('recipient-connection');
    const sender = await connect('sender-connection');
    const wakes: unknown[] = [];
    recipient.setNotificationHandler(SessionMessageNotificationSchema, (notification) => {
      wakes.push(notification.params);
    });

    await recipient.callTool({
      name: 'session_register',
      arguments: {
        sessionKey: 'recipient',
        clientKind: 'brainrouter-cli',
        messageWakeVersion: 1,
      },
    });
    await sender.callTool({
      name: 'session_register',
      arguments: { sessionKey: 'sender', clientKind: 'brainrouter-cli' },
    });
    const result = await sender.callTool({
      name: 'session_send',
      arguments: {
        from: 'sender',
        to: 'recipient',
        messageId: 'client-message-1',
        kind: 'text',
        payload: { text: 'correct course' },
      },
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(mocks.routeSessionMessage).toHaveBeenCalledOnce();
    expect(mocks.routeSessionMessage).toHaveBeenCalledWith(expect.objectContaining({
      fromSessionKey: 'sender',
      senderClaimToken: 'sender-connection',
    }));
    expect(wakes).toEqual([{ sessionKey: 'recipient', messageIds: ['message-1'] }]);
    expect(JSON.parse(String((result.content as Array<{ text: string }>)[0].text))).toMatchObject({
      accepted: 1,
      state: 'persisted-unseen',
      messageId: 'client-message-1',
      recipients: [{ inboxId: 'message-1', status: 'pending', wake: 'pushed' }],
    });
  });

  it('rejects a sender key not owned by the calling MCP connection', async () => {
    const sender = await connect('sender-connection');
    await sender.callTool({
      name: 'session_register',
      arguments: { sessionKey: 'real-sender', clientKind: 'brainrouter-cli' },
    });

    const result = await sender.callTool({
      name: 'session_send',
      arguments: {
        from: 'spoofed-sender',
        to: 'recipient',
        kind: 'text',
        payload: { text: 'do something unsafe' },
      },
    });

    expect(result.isError).toBe(true);
    expect(String((result.content as Array<{ text: string }>)[0].text)).toMatch(/does not own/);
    expect(mocks.routeSessionMessage).not.toHaveBeenCalled();
  });

  it('rejects a locally bound sender when its database claim is no longer current', async () => {
    const sender = await connect('stale-database-claim');
    await sender.callTool({
      name: 'session_register',
      arguments: { sessionKey: 'stale-sender', clientKind: 'brainrouter-cli' },
    });
    mocks.ownsActiveSessionClaim.mockResolvedValue(false);

    const result = await sender.callTool({
      name: 'session_send',
      arguments: {
        from: 'stale-sender',
        to: 'recipient',
        kind: 'text',
        payload: { text: 'must not route' },
      },
    });

    expect(result.isError).toBe(true);
    expect(mocks.ownsActiveSessionClaim).toHaveBeenCalledWith(
      null, 'user-a', 'stale-sender', 'stale-database-claim',
    );
    expect(mocks.routeSessionMessage).not.toHaveBeenCalled();
  });

  it('refuses a live session-key collision instead of stealing the route', async () => {
    const first = await connect('first-connection');
    const second = await connect('second-connection');
    const initial = await first.callTool({
      name: 'session_register',
      arguments: { sessionKey: 'same-key', clientKind: 'brainrouter-cli' },
    });
    const collision = await second.callTool({
      name: 'session_register',
      arguments: { sessionKey: 'same-key', clientKind: 'brainrouter-cli' },
    });

    expect(initial.isError).not.toBe(true);
    expect(collision.isError).toBe(true);
    expect(String((collision.content as Array<{ text: string }>)[0].text)).toMatch(/already bound/);
  });

  it('releases a reserved session key when persistence rejects registration', async () => {
    const first = await connect('failed-registration');
    const second = await connect('registration-retry');
    mocks.registerActiveSession.mockRejectedValueOnce(new Error('database unavailable'));

    const failed = await first.callTool({
      name: 'session_register',
      arguments: { sessionKey: 'retry-key', clientKind: 'brainrouter-cli' },
    });
    const retried = await second.callTool({
      name: 'session_register',
      arguments: { sessionKey: 'retry-key', clientKind: 'brainrouter-cli' },
    });

    expect(failed.isError).toBe(true);
    expect(retried.isError).not.toBe(true);
  });

  it('keeps an existing same-connection binding when re-registration persistence fails', async () => {
    const client = await connect('stable-registration');
    const initial = await client.callTool({
      name: 'session_register',
      arguments: { sessionKey: 'stable-key', clientKind: 'brainrouter-cli' },
    });
    mocks.registerActiveSession.mockRejectedValueOnce(new Error('database unavailable'));

    const failedRetry = await client.callTool({
      name: 'session_register',
      arguments: { sessionKey: 'stable-key', clientKind: 'brainrouter-cli' },
    });
    const send = await client.callTool({
      name: 'session_send',
      arguments: {
        from: 'stable-key',
        to: 'recipient',
        kind: 'text',
        payload: { text: 'still authorized' },
      },
    });

    expect(initial.isError).not.toBe(true);
    expect(failedRetry.isError).toBe(true);
    expect(send.isError).not.toBe(true);
    expect(mocks.routeSessionMessage).toHaveBeenCalledOnce();
  });

  it('does not let a disconnected delayed registration steal a newer live binding', async () => {
    const staleClient = await connect('stale-registration');
    const currentClient = await connect('current-registration');
    let releaseStale!: () => void;
    let staleStarted!: () => void;
    const staleGate = new Promise<void>((resolve) => { releaseStale = resolve; });
    const started = new Promise<void>((resolve) => { staleStarted = resolve; });
    mocks.registerActiveSession.mockImplementationOnce(async (record) => {
      staleStarted();
      await staleGate;
      return record;
    });

    const staleRegistration = staleClient.callTool({
      name: 'session_register',
      arguments: { sessionKey: 'reclaimed-key', clientKind: 'brainrouter-cli' },
    });
    await started;
    hub.disconnect('stale-registration');

    const currentRegistration = await currentClient.callTool({
      name: 'session_register',
      arguments: { sessionKey: 'reclaimed-key', clientKind: 'brainrouter-cli' },
    });
    releaseStale();
    const staleResult = await staleRegistration;

    expect(currentRegistration.isError).not.toBe(true);
    expect(staleResult.isError).toBe(true);
    expect(String((staleResult.content as Array<{ text: string }>)[0].text)).toMatch(/reservation is no longer current/);
    expect(hub.owns('stale-registration', null, 'user-a', 'reclaimed-key')).toBe(false);
    expect(hub.owns('current-registration', null, 'user-a', 'reclaimed-key')).toBe(true);
  });

  it('pins organization and user identity server-side during registration', async () => {
    const client = await connect('tenant-connection', 'org-a');

    await client.callTool({
      name: 'session_register',
      arguments: {
        userId: 'spoofed-user',
        sessionKey: 'tenant-session',
        clientKind: 'brainrouter-cli',
        deviceId: '11111111-1111-4111-8111-111111111111',
        title: 'Fix message delivery',
        titleSource: 'agent',
        state: 'working',
        messageWakeVersion: 1,
      },
    });

    expect(mocks.registerActiveSession).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'org-a',
        userId: 'user-a',
        sessionKey: 'tenant-session',
        metadata: expect.objectContaining({
          deviceId: '11111111-1111-4111-8111-111111111111',
          title: 'Fix message delivery',
          titleSource: 'agent',
          state: 'working',
          messageWakeVersion: 1,
        }),
      }),
      expect.objectContaining({ token: 'tenant-connection' }),
    );
  });

  it('renews and releases the server-owned claim token on heartbeat and unregister', async () => {
    const client = await connect('lifecycle-owner', 'org-a');
    await client.callTool({
      name: 'session_register',
      arguments: { sessionKey: 'owned-session', clientKind: 'brainrouter-cli' },
    });
    await client.callTool({ name: 'session_heartbeat', arguments: { sessionKey: 'owned-session' } });
    await client.callTool({ name: 'session_unregister', arguments: { sessionKey: 'owned-session' } });

    expect(mocks.heartbeatActiveSession).toHaveBeenCalledWith(
      'user-a',
      'owned-session',
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      null,
      'org-a',
      { token: 'lifecycle-owner' },
    );
    expect(mocks.unregisterActiveSession).toHaveBeenCalledWith(
      'user-a', 'owned-session', 'org-a', 'lifecycle-owner',
    );
  });

  it('passes a typed queue_full recipient terminal outcome through MCP with the connection claim', async () => {
    const client = await connect('queue-full-owner', 'org-a');
    await client.callTool({
      name: 'session_register',
      arguments: { sessionKey: 'recipient', clientKind: 'brainrouter-cli' },
    });
    mocks.transitionSessionMessages.mockResolvedValueOnce([{ id: 'receipt-queue-full', status: 'queue_full' }]);

    const response = await client.callTool({
      name: 'session_inbox_ack',
      arguments: {
        sessionKey: 'recipient',
        ids: ['receipt-queue-full'],
        status: 'queue_full',
        reason: 'recipient queue is full',
      },
    });

    expect(response.isError).not.toBe(true);
    expect(mocks.transitionSessionMessages).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org-a',
      userId: 'user-a',
      toSessionKey: 'recipient',
      ids: ['receipt-queue-full'],
      toStatus: 'queue_full',
      reason: 'recipient queue is full',
      claimToken: 'queue-full-owner',
    }));
  });

  it('returns a structured MCP error when no recipient accepted the message', async () => {
    const sender = await connect('sender-rejection');
    await sender.callTool({ name: 'session_register', arguments: { sessionKey: 'sender', clientKind: 'brainrouter-cli' } });
    mocks.routeSessionMessage.mockResolvedValueOnce({
      messageId: 'logical-rejected',
      state: 'not-queued',
      deliveries: [],
      receipts: [{
        id: 'receipt-rejected', orgId: null, userId: 'user-a', messageId: 'logical-rejected',
        fromSessionKey: 'sender', toSessionKey: 'missing', kind: 'text', payload: { text: 'hello' },
        status: 'rejected', statusReason: 'recipient_not_active', createdAt: '2026-08-11T00:00:00.000Z',
        deliveredAt: null,
      }],
      accepted: 0,
      rejected: 1,
      idempotentReplay: false,
      rejectionReason: 'recipient_not_active',
    });

    const response = await sender.callTool({
      name: 'session_send',
      arguments: { messageId: 'logical-rejected', from: 'sender', to: 'missing', kind: 'text', payload: { text: 'hello' } },
    });

    expect(response.isError).toBe(true);
    expect(JSON.parse(String((response.content as Array<{ text: string }>)[0].text))).toMatchObject({
      state: 'not-queued', accepted: 0, rejected: 1, rejectionReason: 'recipient_not_active',
      recipients: [{ inboxId: 'receipt-rejected', status: 'rejected', reason: 'recipient_not_active' }],
    });
  });

  it('reports an idempotent terminal retry as applied without claiming a new unseen delivery', async () => {
    const sender = await connect('sender-terminal-retry');
    await sender.callTool({ name: 'session_register', arguments: { sessionKey: 'sender', clientKind: 'brainrouter-cli' } });
    mocks.routeSessionMessage.mockResolvedValueOnce({
      messageId: 'logical-applied',
      state: 'applied',
      deliveries: [],
      receipts: [{
        id: 'receipt-applied', orgId: null, userId: 'user-a', messageId: 'logical-applied',
        fromSessionKey: 'sender', toSessionKey: 'recipient', kind: 'text', payload: { text: 'hello' },
        status: 'applied', createdAt: '2026-08-11T00:00:00.000Z', deliveredAt: '2026-08-11T00:00:01.000Z',
      }],
      accepted: 1,
      rejected: 0,
      idempotentReplay: true,
    });

    const response = await sender.callTool({
      name: 'session_send',
      arguments: { messageId: 'logical-applied', from: 'sender', to: 'recipient', kind: 'text', payload: { text: 'hello' } },
    });

    expect(response.isError).not.toBe(true);
    expect(JSON.parse(String((response.content as Array<{ text: string }>)[0].text))).toEqual({
      messageId: 'logical-applied',
      state: 'applied',
      accepted: 1,
      rejected: 0,
      idempotentReplay: true,
      recipients: [{ sessionKey: 'recipient', inboxId: 'receipt-applied', status: 'applied' }],
    });
  });

  it('enforces the transport-neutral text limit in UTF-8 bytes', async () => {
    const sender = await connect('sender-bounds');
    await sender.callTool({ name: 'session_register', arguments: { sessionKey: 'sender', clientKind: 'brainrouter-cli' } });

    const response = await sender.callTool({
      name: 'session_send',
      arguments: {
        messageId: 'logical-too-large',
        from: 'sender',
        to: 'recipient',
        kind: 'text',
        payload: { text: 'é'.repeat(10_001) },
      },
    });

    expect(response.isError).toBe(true);
    expect(String((response.content as Array<{ text: string }>)[0].text)).toContain('20000 UTF-8 bytes');
    expect(mocks.routeSessionMessage).not.toHaveBeenCalled();
  });

  it('authorizes held/applied transitions and sender receipt reads against the bound session', async () => {
    const client = await connect('lifecycle-connection', 'org-a');
    await client.callTool({ name: 'session_register', arguments: { sessionKey: 'recipient', clientKind: 'brainrouter-cli' } });
    await client.callTool({
      name: 'session_inbox_ack',
      arguments: { sessionKey: 'recipient', ids: ['receipt-1'], status: 'held', reason: 'recipient requires approval' },
    });
    await client.callTool({ name: 'session_receipts', arguments: { sessionKey: 'recipient' } });

    expect(mocks.transitionSessionMessages).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org-a', userId: 'user-a', toSessionKey: 'recipient', ids: ['receipt-1'], toStatus: 'held',
      claimToken: 'lifecycle-connection',
    }));
    expect(mocks.readSessionMessageReceipts).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org-a', userId: 'user-a', fromSessionKey: 'recipient',
      claimToken: 'lifecycle-connection',
    }));
  });
});
