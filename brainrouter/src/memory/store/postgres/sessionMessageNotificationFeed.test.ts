/**
 * ADR-034 Postgres notification-feed regressions: committed ID-only hints fan
 * into live Brain processes and reconnect without becoming the source of truth.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { startSessionMessageNotificationFeed } from './sessionMessageNotificationFeed.js';

class FakeClient extends EventEmitter {
  readonly queries: string[] = [];
  released = false;

  async query(text: string): Promise<{ rows: never[]; rowCount: number }> {
    this.queries.push(text);
    return { rows: [], rowCount: 0 };
  }

  release(): void { this.released = true; }
}

function payload(inboxId: string): string {
  return JSON.stringify({
    version: 1,
    orgId: 'org-a',
    userId: 'user-a',
    fromSessionKey: 'sender',
    toSessionKey: 'recipient',
    messageId: 'logical-message',
    inboxId,
    status: 'pending',
  });
}

describe('session message Postgres notification feed', () => {
  it('accepts only bounded typed channel payloads and closes its LISTEN client', async () => {
    const client = new FakeClient();
    const pool = { connect: vi.fn(async () => client as unknown as PoolClient) } as unknown as Pool;
    const listener = vi.fn(async () => {});
    const feed = startSessionMessageNotificationFeed(pool, listener, { retryMinMs: 10, retryMaxMs: 10 });
    await feed.ready;

    client.emit('notification', { channel: 'brainrouter_session_messages', payload: payload('inbox-1') });
    client.emit('notification', { channel: 'brainrouter_session_messages', payload: '{bad json' });
    client.emit('notification', { channel: 'some_other_channel', payload: payload('inbox-2') });
    await new Promise((resolve) => setImmediate(resolve));

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ inboxId: 'inbox-1', status: 'pending' }));
    await feed.close();
    expect(client.queries).toEqual([
      'LISTEN brainrouter_session_messages',
      'UNLISTEN brainrouter_session_messages',
    ]);
    expect(client.released).toBe(true);
  });

  it('reconnects after a lost database listener', async () => {
    const first = new FakeClient();
    const second = new FakeClient();
    const clients = [first, second];
    const pool = {
      connect: vi.fn(async () => (clients.shift() ?? second) as unknown as PoolClient),
    } as unknown as Pool;
    const listener = vi.fn(async () => {});
    const feed = startSessionMessageNotificationFeed(pool, listener, { retryMinMs: 10, retryMaxMs: 10 });
    await feed.ready;

    first.emit('error', new Error('connection lost'));
    await vi.waitFor(() => expect(pool.connect).toHaveBeenCalledTimes(2));
    second.emit('notification', { channel: 'brainrouter_session_messages', payload: payload('inbox-after-reconnect') });
    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());

    await feed.close();
    expect(first.released).toBe(true);
    expect(second.released).toBe(true);
  });
});
