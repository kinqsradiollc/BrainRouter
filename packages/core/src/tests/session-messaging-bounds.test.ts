/**
 * ADR-034 local messaging bounds and address-space rules.
 *
 * These tests exercise values that reach the recipient rather than merely
 * asserting that a guard function was called.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCAL_SESSION_AUTH_HEADER,
  LOCAL_SESSION_DEFAULT_MAX_AGE_MS,
  LOCAL_SESSION_DEFAULT_QUEUE_DEPTH,
  LOCAL_SESSION_MAX_ACCEPTED_IDS,
  LOCAL_SESSION_MAX_BODY_BYTES,
  LOCAL_SESSION_MAX_TEXT_BYTES,
  requireSessionKey,
  sanitizePeerTextForTerminal,
  sendLocalSessionMessage,
  startLocalSessionTransport,
} from '../session/messaging/index.js';
import { MAX_SESSION_TITLE } from '../session/sessionTitle.js';
import { LocalSessionMailbox } from '../session/messaging/mailbox.js';
import { findSessionRouteByKey, mergeSessionRoutes } from '../session/messaging/routes.js';
import type { LocalSessionMessage, SessionRouteDescriptor } from '../session/messaging/contracts.js';
import {
  listLocalSessionRegistryEntries,
  writeLocalSessionRegistryEntry,
} from '../session/messaging/registry.js';
import { createLocalSessionSenderProof } from '../session/messaging/senderProof.js';
import { withTempWorkspaceAsync } from './_helpers.js';

function message(id: string, createdAt: number, receivedAt = createdAt): LocalSessionMessage {
  return {
    id,
    senderSessionKey: 'session:sender',
    senderDeviceId: 'device-a',
    targetSessionKey: 'session:recipient',
    text: `message ${id}`,
    source: 'peer-session',
    trust: 'untrusted-session',
    createdAt,
    receivedAt,
  };
}

function route(
  sessionKey: string,
  transport: 'local' | 'remote',
  lastSeenAt: number,
  title = 'Same readable title',
): SessionRouteDescriptor {
  return {
    sessionKey,
    deviceId: transport === 'local' ? 'device-local' : 'device-remote',
    clientKind: 'cli',
    state: 'working',
    transport,
    lastSeenAt,
    title,
  };
}

test('ADR-034 mailbox rejects overflow and reports accepted messages that expire', () => {
  const mailbox = new LocalSessionMailbox(1, 100);
  assert.deepEqual(mailbox.enqueue(message('first', 1_000), 1_000), {
    accepted: true,
    acceptedAt: 1_000,
    pending: 1,
    duplicate: false,
  });
  assert.deepEqual(mailbox.enqueue(message('second', 1_001), 1_001), {
    accepted: false,
    reason: 'queue_full',
  });

  const drained = mailbox.drain(1_100);
  assert.deepEqual(drained.messages, [], 'expired content must not reach the recipient');
  assert.deepEqual(drained.expired, [{
    messageId: 'first',
    senderSessionKey: 'session:sender',
    expiredAt: 1_100,
  }]);
  assert.equal(drained.expiredOmitted, 0);
});

test('ADR-034 mailbox deduplicates accepted ids and rejects conflicting reuse', () => {
  const mailbox = new LocalSessionMailbox(10, 100, 10);
  const original = message('same-id', 1_000);
  assert.deepEqual(mailbox.enqueue(original, 1_000), {
    accepted: true,
    acceptedAt: 1_000,
    pending: 1,
    duplicate: false,
  });
  assert.deepEqual(mailbox.enqueue({ ...original, receivedAt: 1_001 }, 1_001), {
    accepted: true,
    acceptedAt: 1_000,
    pending: 1,
    duplicate: true,
  });
  assert.deepEqual(mailbox.enqueue({ ...original, text: 'different content' }, 1_001), {
    accepted: false,
    reason: 'id_conflict',
  });
  assert.deepEqual(mailbox.drain(1_001).messages.map(({ id }) => id), ['same-id']);
  assert.deepEqual(mailbox.enqueue({ ...original, receivedAt: 1_002 }, 1_002), {
    accepted: true,
    acceptedAt: 1_000,
    pending: 0,
    duplicate: true,
  }, 'draining the queue must not reopen the idempotency window');
});

test('ADR-034 mailbox preserves an authoritative remote deadline across delayed receipt and retries', () => {
  const mailbox = new LocalSessionMailbox(10, LOCAL_SESSION_DEFAULT_MAX_AGE_MS, 10);
  const createdAt = 1_000;
  const expiresAt = createdAt + LOCAL_SESSION_DEFAULT_MAX_AGE_MS;
  const delayed = {
    ...message('remote-deadline', createdAt, expiresAt - 5),
    expiresAt,
  };
  assert.deepEqual(mailbox.enqueue(delayed, expiresAt - 5), {
    accepted: true,
    acceptedAt: expiresAt - 5,
    pending: 1,
    duplicate: false,
  });
  const drained = mailbox.drain(expiresAt);
  assert.deepEqual(drained.messages, []);
  assert.deepEqual(drained.expired.map((notice) => notice.messageId), [delayed.id]);
  assert.deepEqual(mailbox.enqueue(delayed, expiresAt), {
    accepted: false,
    reason: 'expired',
  }, 'expiry also closes the accepted-id replay window');
});

test('ADR-034 production defaults retain the queue, age, dedupe-ledger, and body bounds', () => {
  assert.equal(LOCAL_SESSION_DEFAULT_QUEUE_DEPTH, 100);
  assert.equal(LOCAL_SESSION_DEFAULT_MAX_AGE_MS, 24 * 60 * 60 * 1_000);
  assert.equal(LOCAL_SESSION_MAX_ACCEPTED_IDS, 1_000);
  assert.equal(LOCAL_SESSION_MAX_BODY_BYTES, 64 * 1_024);
});

test('ADR-034 terminal presentation neutralizes C0, C1, ESC, CSI, and OSC without changing peer text', () => {
  const raw = [
    'plain ',
    '\u001b]8;;https://example.invalid\u0007linked\u001b]8;;\u0007',
    ' \u001b[31mred\u001b[0m',
    '\rnext\b!\u009b2J',
    '\n模型\t🙂',
    '\u009d52;c;clipboard\u009c',
    ' end',
  ].join('');
  const safe = sanitizePeerTextForTerminal(raw);

  assert.equal(safe, 'plain linked red\nnext!\n模型  🙂 end');
  assert.equal(raw.includes('\u001b]8;'), true, 'sanitization must not mutate the stored/model copy');
  assert.doesNotMatch(safe, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
});

test('ADR-034 every session-key boundary rejects C0, ESC, and C1 controls', async () => {
  await withTempWorkspaceAsync(async () => {
    for (const badKey of ['session:bad\u0000key', 'session:bad\u001b[2J', 'session:bad\u009b2J']) {
      assert.throws(() => requireSessionKey(badKey), /Invalid local messaging session key/);
      assert.equal(findSessionRouteByKey([route(badKey, 'remote', 1)], badKey), undefined);
      assert.deepEqual(mergeSessionRoutes([], [route(badKey, 'remote', 1)]), []);
      await assert.rejects(
        startLocalSessionTransport({ sessionKey: badKey, clientKind: 'cli' }),
        /Invalid local messaging session key/,
      );
      const receipt = await sendLocalSessionMessage(badKey, {
        senderSessionKey: 'session:sender',
        text: 'must not route',
      });
      assert.equal(receipt.queued, false);
      assert.equal(receipt.queued ? '' : receipt.reason, 'invalid_message');
    }
  });
});

test('ADR-034 registry titles use the shared JS-length bound while workspace metadata stays byte-bounded', async () => {
  await withTempWorkspaceAsync(async () => {
    const cjkTitle = '界'.repeat(MAX_SESSION_TITLE);
    const emojiTitle = '🙂'.repeat(MAX_SESSION_TITLE / 2);
    const handle = await startLocalSessionTransport({
      sessionKey: 'session:unicode-title',
      clientKind: 'desktop',
      title: cjkTitle,
    });
    try {
      assert.equal(handle.registration().title, cjkTitle);
      assert.equal(handle.updateRegistration({ title: emojiTitle }).title, emojiTitle);
      assert.throws(
        () => handle.updateRegistration({ title: `${emojiTitle}🙂` }),
        /Invalid local messaging session title/,
      );
    } finally {
      await handle.close();
    }

    await assert.rejects(
      startLocalSessionTransport({
        sessionKey: 'session:oversized-workspace',
        clientKind: 'cli',
        workspaceRoot: '界'.repeat(1_366),
      }),
      /Invalid local messaging registry text/,
    );
  });
});

test('ADR-034 accepted-id capacity refuses new work without evicting retry evidence', () => {
  const mailbox = new LocalSessionMailbox(1, 1_000, 2);
  const first = message('ledger-first', 100);
  const second = message('ledger-second', 101);
  assert.equal(mailbox.enqueue(first, 100).accepted, true);
  mailbox.drain(100);
  assert.equal(mailbox.enqueue(second, 101).accepted, true);
  mailbox.drain(101);
  assert.deepEqual(mailbox.enqueue(message('ledger-overflow', 102), 102), {
    accepted: false,
    reason: 'queue_full',
  });
  assert.equal(mailbox.enqueue(first, 102).accepted, true, 'an accepted retry remains provable');
  assert.equal(mailbox.enqueue(message('ledger-after-expiry', 102), 1_100).accepted, true,
    'expired dedupe evidence releases bounded capacity');
});

test('ADR-034 mailbox refuses a message whose sender timestamp is already outside retention', () => {
  const mailbox = new LocalSessionMailbox(10, 100);
  assert.deepEqual(mailbox.enqueue(message('old', 1_000, 1_200), 1_200), {
    accepted: false,
    reason: 'expired',
  });
  assert.equal(mailbox.pending(1_200), 0);
});

test('ADR-034 route merging uses exact keys and a live local route wins a remote duplicate', () => {
  const routes = mergeSessionRoutes(
    [route('session:local', 'local', 10), route('session:shared', 'local', 5)],
    [route('session:remote', 'remote', 20), route('session:shared', 'remote', 30)],
  );

  assert.deepEqual(routes.map(({ sessionKey, transport }) => ({ sessionKey, transport })), [
    { sessionKey: 'session:local', transport: 'local' },
    { sessionKey: 'session:remote', transport: 'remote' },
    { sessionKey: 'session:shared', transport: 'local' },
  ]);
  assert.equal(findSessionRouteByKey(routes, 'session:shared')?.deviceId, 'device-local');
  assert.equal(findSessionRouteByKey(routes, ' session:shared '), undefined,
    'exact keys are rejected rather than whitespace-normalized');
  assert.equal(findSessionRouteByKey(routes, 'Same readable title'), undefined,
    'a title must never become a routing alias');
});

test('ADR-034 live mailbox returns truthful full, expired, and oversized receipts', async () => {
  await withTempWorkspaceAsync(async () => {
    let now = 1_000;
    const sender = await startLocalSessionTransport({
      sessionKey: 'session:sender',
      clientKind: 'desktop',
      now: () => now,
    });
    const recipient = await startLocalSessionTransport({
      sessionKey: 'session:bounded',
      clientKind: 'cli',
      maxQueueDepth: 1,
      maxMessageAgeMs: 100,
      now: () => now,
    });
    try {
      const first = await sendLocalSessionMessage('session:bounded', {
        id: 'first-live',
        senderSessionKey: 'session:sender',
        text: 'first',
        createdAt: now,
      }, { now: () => now });
      assert.equal(first.queued, true);

      const full = await sendLocalSessionMessage('session:bounded', {
        id: 'second-live',
        senderSessionKey: 'session:sender',
        text: 'second',
        createdAt: now,
      }, { now: () => now });
      assert.equal(full.queued, false);
      assert.equal(full.queued ? '' : full.reason, 'queue_full');

      now += 100;
      const drained = recipient.drain();
      assert.deepEqual(drained.messages, []);
      assert.deepEqual(drained.expired.map((notice) => notice.messageId), ['first-live']);

      const old = await sendLocalSessionMessage('session:bounded', {
        id: 'already-old',
        senderSessionKey: 'session:sender',
        text: 'old',
        createdAt: now - 100,
      }, { now: () => now });
      assert.equal(old.queued, false);
      assert.equal(old.queued ? '' : old.reason, 'expired');

      const oversized = await sendLocalSessionMessage('session:bounded', {
        id: 'oversized',
        senderSessionKey: 'session:sender',
        text: 'x'.repeat(LOCAL_SESSION_MAX_TEXT_BYTES + 1),
        createdAt: now,
      }, { now: () => now });
      assert.equal(oversized.queued, false);
      assert.equal(oversized.queued ? '' : oversized.reason, 'payload_too_large');
    } finally {
      await Promise.all([sender.close(), recipient.close()]);
    }
  });
});

test('ADR-034 listener authenticates before body handling and caps hostile raw requests', async () => {
  await withTempWorkspaceAsync(async () => {
    const sender = await startLocalSessionTransport({ sessionKey: 'session:sender', clientKind: 'cli' });
    const recipient = await startLocalSessionTransport({ sessionKey: 'session:auth', clientKind: 'desktop' });
    try {
      const base = `http://${recipient.host}:${recipient.port}`;
      const denied = await fetch(`${base}/session-messaging/v1/health`);
      assert.equal(denied.status, 401);

      const entry = listLocalSessionRegistryEntries().find((candidate) =>
        candidate.sessionKey === 'session:auth')!;
      const oversized = await fetch(`${base}/session-messaging/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [LOCAL_SESSION_AUTH_HEADER]: entry.token,
        },
        body: JSON.stringify({ padding: 'x'.repeat(LOCAL_SESSION_MAX_BODY_BYTES + 1) }),
      });
      assert.equal(oversized.status, 413);
      assert.equal((await oversized.json() as { reason: string }).reason, 'payload_too_large');
      assert.equal(recipient.pendingCount(), 0);

      const spoofedSender = await fetch(`${base}/session-messaging/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [LOCAL_SESSION_AUTH_HEADER]: entry.token,
        },
        body: JSON.stringify({
          id: 'raw-spoofed-sender',
          senderSessionKey: 'session:sender',
          senderDeviceId: entry.deviceId,
          targetSessionKey: 'session:auth',
          text: 'claim another live sender without its capability proof',
          createdAt: Date.now(),
        }),
      });
      assert.equal(spoofedSender.status, 401);
      assert.deepEqual(await spoofedSender.json(), {
        queued: false,
        status: 'not_queued',
        transport: 'local',
        targetSessionKey: 'session:auth',
        reason: 'invalid_message',
        messageId: 'raw-spoofed-sender',
      });
      assert.equal(recipient.pendingCount(), 0);

      const senderEntry = listLocalSessionRegistryEntries().find((candidate) =>
        candidate.sessionKey === 'session:sender')!;
      const wrongDeviceEnvelope = {
        id: 'raw-wrong-device',
        senderSessionKey: 'session:sender',
        senderDeviceId: '00000000-0000-4000-8000-000000000000',
        targetSessionKey: 'session:auth',
        text: 'a valid sender capability cannot claim a different installation',
        createdAt: Date.now(),
      };
      const wrongDevice = await fetch(`${base}/session-messaging/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [LOCAL_SESSION_AUTH_HEADER]: entry.token,
        },
        body: JSON.stringify({
          ...wrongDeviceEnvelope,
          senderProof: createLocalSessionSenderProof(
            wrongDeviceEnvelope,
            senderEntry.instanceId,
            senderEntry.token,
          ),
        }),
      });
      assert.equal(wrongDevice.status, 401);
      assert.equal(recipient.pendingCount(), 0);

      const selfSend = await fetch(`${base}/session-messaging/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [LOCAL_SESSION_AUTH_HEADER]: entry.token,
        },
        body: JSON.stringify({
          id: 'raw-self-send',
          senderSessionKey: 'session:auth',
          senderDeviceId: entry.deviceId,
          targetSessionKey: 'session:auth',
          text: 'must be rejected',
          createdAt: Date.now(),
        }),
      });
      assert.equal(selfSend.status, 409);
      assert.deepEqual(await selfSend.json(), {
        queued: false,
        status: 'not_queued',
        transport: 'local',
        targetSessionKey: 'session:auth',
        reason: 'self_send',
        messageId: 'raw-self-send',
      });
      assert.equal(recipient.pendingCount(), 0);
    } finally {
      await Promise.all([sender.close(), recipient.close()]);
    }
  });
});

test('ADR-034 recipient rejects and reaps a restored stale sender proof before mailbox admission', async () => {
  await withTempWorkspaceAsync(async () => {
    const sender = await startLocalSessionTransport({
      sessionKey: 'session:stale-proof-sender',
      clientKind: 'cli',
    });
    const recipient = await startLocalSessionTransport({
      sessionKey: 'session:stale-proof-recipient',
      clientKind: 'desktop',
    });
    const registrations = listLocalSessionRegistryEntries();
    const senderEntry = registrations.find((entry) => entry.sessionKey === 'session:stale-proof-sender')!;
    const recipientEntry = registrations.find((entry) => entry.sessionKey === 'session:stale-proof-recipient')!;
    const envelope = {
      id: 'raw-stale-sender-proof',
      senderSessionKey: senderEntry.sessionKey,
      senderDeviceId: senderEntry.deviceId,
      targetSessionKey: recipientEntry.sessionKey,
      text: 'A closed sender must not remain authoritative through its old HMAC.',
      createdAt: Date.now(),
    };
    const senderProof = createLocalSessionSenderProof(envelope, senderEntry.instanceId, senderEntry.token);

    await sender.close();
    writeLocalSessionRegistryEntry(senderEntry);
    try {
      const response = await fetch(
        `http://${recipient.host}:${recipient.port}/session-messaging/v1/messages`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [LOCAL_SESSION_AUTH_HEADER]: recipientEntry.token,
          },
          body: JSON.stringify({ ...envelope, senderProof }),
        },
      );
      assert.equal(response.status, 401);
      assert.equal(recipient.pendingCount(), 0);
      assert.equal(
        listLocalSessionRegistryEntries().some((entry) => entry.instanceId === senderEntry.instanceId),
        false,
        'the recipient-side live proof must reap the exact stale sender instance',
      );
      assert.equal(
        listLocalSessionRegistryEntries().some((entry) => entry.instanceId === recipientEntry.instanceId),
        true,
        'sender authentication failure must not reap the healthy recipient',
      );
    } finally {
      await recipient.close();
    }
  });
});
