/**
 * ADR-034 live-delivery hub regressions: only the exact surviving connection
 * reservation may own and receive an ID-only wake for a durable row.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SessionInboxRecord } from '@kinqs/brainrouter-types';
import { SessionDeliveryHub } from './sessionDeliveryHub.js';

function record(id: string, userId = 'u1', toSessionKey = 'target', orgId: string | null = null): SessionInboxRecord {
  return {
    id,
    orgId,
    userId,
    fromSessionKey: 'sender',
    toSessionKey,
    kind: 'text',
    payload: { text: 'hello' },
    createdAt: '2026-08-11T00:00:00.000Z',
    deliveredAt: null,
  };
}

describe('SessionDeliveryHub', () => {
  it('pushes one wake per recipient while preserving per-row outcomes', async () => {
    const hub = new SessionDeliveryHub();
    const notify = vi.fn(async () => {});
    hub.bind({ connectionId: 'c1', orgId: null, userId: 'u1', sessionKey: 'target', notify });

    const outcomes = await hub.notifyPersisted([record('m1'), record('m2')]);

    expect(notify).toHaveBeenCalledWith({
      sessionKey: 'target',
      messageIds: ['m1', 'm2'],
    });
    expect([...outcomes]).toEqual([['m1', 'pushed'], ['m2', 'pushed']]);
  });

  it('never crosses the authenticated user partition', async () => {
    const hub = new SessionDeliveryHub();
    const notify = vi.fn(async () => {});
    hub.bind({ connectionId: 'c1', orgId: null, userId: 'u1', sessionKey: 'target', notify });

    const outcomes = await hub.notifyPersisted([record('m1', 'u2')]);

    expect(notify).not.toHaveBeenCalled();
    expect(outcomes.get('m1')).toBe('poll-fallback');
  });

  it('never crosses the authenticated organization partition', async () => {
    const hub = new SessionDeliveryHub();
    const notify = vi.fn(async () => {});
    hub.bind({ connectionId: 'c1', orgId: 'org-a', userId: 'u1', sessionKey: 'target', notify });

    const outcomes = await hub.notifyPersisted([record('m1', 'u1', 'target', 'org-b')]);

    expect(notify).not.toHaveBeenCalled();
    expect(outcomes.get('m1')).toBe('poll-fallback');
  });

  it('reserves one exact identity atomically until its owning connection releases it', () => {
    const hub = new SessionDeliveryHub();

    expect(hub.reserve('first', 'org-a', 'u1', 'target', 'attempt-1')).toBe(true);
    expect(hub.reserve('second', 'org-a', 'u1', 'target', 'attempt-2')).toBe(false);
    hub.unbind('org-a', 'u1', 'target', 'first');
    expect(hub.reserve('second', 'org-a', 'u1', 'target', 'attempt-3')).toBe(true);
  });

  it('does not unbind a valid same-owner route when a re-registration attempt fails', async () => {
    const hub = new SessionDeliveryHub();
    const notify = vi.fn(async () => {});
    hub.bind({ connectionId: 'owner', orgId: 'org-a', userId: 'u1', sessionKey: 'target', notify });

    expect(hub.reserve('owner', 'org-a', 'u1', 'target', 'retry-attempt')).toBe(true);
    hub.releaseReservation('owner', 'org-a', 'u1', 'target', 'retry-attempt');

    expect(hub.owns('owner', 'org-a', 'u1', 'target')).toBe(true);
    await hub.notifyPersisted([record('m1', 'u1', 'target', 'org-a')]);
    expect(notify).toHaveBeenCalledOnce();
  });

  it('token-checks re-registration finalize so a stale completion cannot replace the newest route', async () => {
    const hub = new SessionDeliveryHub();
    const initialNotify = vi.fn(async () => {});
    const firstNotify = vi.fn(async () => {});
    const newestNotify = vi.fn(async () => {});
    hub.bind({
      connectionId: 'owner', orgId: 'org-a', userId: 'u1', sessionKey: 'target', notify: initialNotify,
    });

    expect(hub.reserve('owner', 'org-a', 'u1', 'target', 'first-attempt')).toBe(true);
    expect(hub.reserve('owner', 'org-a', 'u1', 'target', 'overlap-attempt')).toBe(false);
    expect(hub.commitReservation({
      connectionId: 'owner', orgId: 'org-a', userId: 'u1', sessionKey: 'target', notify: firstNotify,
    }, 'first-attempt')).toBe(true);

    expect(hub.reserve('owner', 'org-a', 'u1', 'target', 'newest-attempt')).toBe(true);
    expect(hub.commitReservation({
      connectionId: 'owner', orgId: 'org-a', userId: 'u1', sessionKey: 'target', notify: newestNotify,
    }, 'newest-attempt')).toBe(true);
    expect(hub.commitReservation({
      connectionId: 'owner', orgId: 'org-a', userId: 'u1', sessionKey: 'target', notify: firstNotify,
    }, 'first-attempt')).toBe(false);

    await hub.notifyPersisted([record('m1', 'u1', 'target', 'org-a')]);
    expect(initialNotify).not.toHaveBeenCalled();
    expect(firstNotify).not.toHaveBeenCalled();
    expect(newestNotify).toHaveBeenCalledOnce();
  });

  it('releases only the placeholder created by the matching registration attempt', () => {
    const hub = new SessionDeliveryHub();
    expect(hub.reserve('owner', 'org-a', 'u1', 'target', 'original-attempt')).toBe(true);

    hub.releaseReservation('owner', 'org-a', 'u1', 'target', 'different-attempt');
    expect(hub.owns('owner', 'org-a', 'u1', 'target')).toBe(false);
    expect(hub.reserve('competitor', 'org-a', 'u1', 'target', 'blocked-attempt')).toBe(false);

    hub.releaseReservation('owner', 'org-a', 'u1', 'target', 'original-attempt');
    expect(hub.owns('owner', 'org-a', 'u1', 'target')).toBe(false);
    expect(hub.reserve('competitor', 'org-a', 'u1', 'target', 'accepted-attempt')).toBe(true);
  });

  it('rejects a second concurrent registration attempt from the same connection', () => {
    const hub = new SessionDeliveryHub();
    expect(hub.reserve('owner', 'org-a', 'u1', 'target', 'first-attempt')).toBe(true);
    expect(hub.reserve('owner', 'org-a', 'u1', 'target', 'second-attempt')).toBe(false);
    hub.releaseReservation('owner', 'org-a', 'u1', 'target', 'first-attempt');
    expect(hub.reserve('owner', 'org-a', 'u1', 'target', 'second-attempt')).toBe(true);
  });

  it('refuses a stale completion after its connection disconnected and a new owner bound', async () => {
    const hub = new SessionDeliveryHub();
    const oldNotify = vi.fn(async () => {});
    const newNotify = vi.fn(async () => {});

    expect(hub.reserve('old', 'org-a', 'u1', 'target', 'old-attempt')).toBe(true);
    expect(hub.owns('old', 'org-a', 'u1', 'target')).toBe(false);
    hub.disconnect('old');

    expect(hub.reserve('new', 'org-a', 'u1', 'target', 'new-attempt')).toBe(true);
    expect(hub.commitReservation({
      connectionId: 'new', orgId: 'org-a', userId: 'u1', sessionKey: 'target', notify: newNotify,
    }, 'new-attempt')).toBe(true);

    expect(hub.commitReservation({
      connectionId: 'old', orgId: 'org-a', userId: 'u1', sessionKey: 'target', notify: oldNotify,
    }, 'old-attempt')).toBe(false);
    expect(hub.owns('old', 'org-a', 'u1', 'target')).toBe(false);
    expect(hub.owns('new', 'org-a', 'u1', 'target')).toBe(true);

    await hub.notifyPersisted([record('m1', 'u1', 'target', 'org-a')]);
    expect(oldNotify).not.toHaveBeenCalled();
    expect(newNotify).toHaveBeenCalledOnce();
  });

  it('rebinds an identity to the newest connection', async () => {
    const hub = new SessionDeliveryHub();
    const oldNotify = vi.fn(async () => {});
    const newNotify = vi.fn(async () => {});
    hub.bind({ connectionId: 'old', orgId: null, userId: 'u1', sessionKey: 'target', notify: oldNotify });
    hub.bind({ connectionId: 'new', orgId: null, userId: 'u1', sessionKey: 'target', notify: newNotify });

    await hub.notifyPersisted([record('m1')]);

    expect(oldNotify).not.toHaveBeenCalled();
    expect(newNotify).toHaveBeenCalledOnce();
  });

  it('falls back to polling and reaps a failed stream', async () => {
    const hub = new SessionDeliveryHub();
    const notify = vi.fn(async () => { throw new Error('closed'); });
    hub.bind({ connectionId: 'c1', orgId: null, userId: 'u1', sessionKey: 'target', notify });

    const first = await hub.notifyPersisted([record('m1')]);
    const second = await hub.notifyPersisted([record('m2')]);

    expect(first.get('m1')).toBe('poll-fallback');
    expect(second.get('m2')).toBe('poll-fallback');
    expect(notify).toHaveBeenCalledOnce();
  });

  it('routes committed pending wakes to recipients and terminal receipts to senders', async () => {
    const hub = new SessionDeliveryHub();
    const recipientNotify = vi.fn(async () => {});
    const senderNotify = vi.fn(async () => {});
    hub.bind({ connectionId: 'recipient-connection', orgId: 'org-a', userId: 'u1', sessionKey: 'target', notify: recipientNotify });
    hub.bind({ connectionId: 'sender-connection', orgId: 'org-a', userId: 'u1', sessionKey: 'sender', notify: senderNotify });
    const base = {
      version: 1 as const,
      orgId: 'org-a',
      userId: 'u1',
      fromSessionKey: 'sender',
      toSessionKey: 'target',
      messageId: 'logical-1',
      inboxId: 'inbox-1',
    };

    await hub.notifyStoreNotification({ ...base, status: 'pending' });
    await hub.notifyStoreNotification({ ...base, status: 'applied' });

    expect(recipientNotify).toHaveBeenCalledWith({ sessionKey: 'target', messageIds: ['inbox-1'] });
    expect(senderNotify).toHaveBeenCalledWith({ sessionKey: 'sender', messageIds: ['inbox-1'] });
  });
});
