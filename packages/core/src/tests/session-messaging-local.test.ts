/**
 * ADR-034 same-machine delivery acceptance tests.
 *
 * These run over real ephemeral loopback listeners with only a private temp
 * BrainRouter home. No backend is started: delivery therefore proves the local
 * path remains independent of remote availability.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  LOCAL_SESSION_AUTH_HEADER,
  LOCAL_SESSION_HOST,
  LOCAL_SESSION_PROTOCOL,
  discoverLocalSessionRoutes,
  sendLocalSessionMessage,
  startLocalSessionTransport,
} from '../session/messaging/index.js';
import {
  listLocalSessionRegistryEntries,
  newLocalSessionRegistryEntry,
  removeLocalSessionRegistryEntry,
  writeLocalSessionRegistryEntry,
} from '../session/messaging/registry.js';
import {
  createLocalSessionSenderProof,
  verifyLocalSessionSenderProof,
} from '../session/messaging/senderProof.js';
import { withTempWorkspaceAsync } from './_helpers.js';

test('ADR-034 two offline hosts discover and deliver by exact session key', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    let now = 1_700_000_000_000;
    let wakeCount = 0;
    const sender = await startLocalSessionTransport({
      sessionKey: 'session:sender',
      clientKind: 'cli',
      state: 'working',
      workspaceRoot: workspace,
      title: 'Investigate the same failure',
      now: () => now,
    });
    const recipient = await startLocalSessionTransport({
      sessionKey: 'session:recipient',
      clientKind: 'desktop',
      state: 'idle',
      workspaceRoot: workspace,
      title: 'Investigate the same failure',
      now: () => now,
      onMessageAvailable: () => { wakeCount += 1; },
    });
    try {
      assert.equal(sender.host, '127.0.0.1');
      assert.equal(recipient.host, '127.0.0.1');
      assert.notEqual(sender.port, recipient.port, 'each session owns its own ephemeral listener');

      const discovered = await discoverLocalSessionRoutes({ now: () => now });
      assert.deepEqual(discovered.map(({ sessionKey, clientKind, transport }) => ({
        sessionKey,
        clientKind,
        transport,
      })), [
        { sessionKey: 'session:recipient', clientKind: 'desktop', transport: 'local' },
        { sessionKey: 'session:sender', clientKind: 'cli', transport: 'local' },
      ]);
      assert.equal(discovered[0]!.deviceId, discovered[1]!.deviceId,
        'both hosts must share the persisted same-machine identity');

      const receipt = await sendLocalSessionMessage('session:recipient', {
        id: 'msg-exact-key',
        senderSessionKey: 'session:sender',
        text: 'Stop after the current tool boundary and re-check the migration.',
        createdAt: now,
      }, { now: () => now });
      assert.deepEqual(receipt, {
        queued: true,
        status: 'queued',
        transport: 'local',
        messageId: 'msg-exact-key',
        targetSessionKey: 'session:recipient',
        acceptedAt: now,
        pending: 1,
        duplicate: false,
      });
      assert.equal(wakeCount, 1);
      assert.equal(sender.pendingCount(), 0, 'the readable title collision must not redirect delivery');

      const duplicateEnvelope = {
        id: 'msg-exact-key',
        senderSessionKey: 'session:sender',
        senderDeviceId: discovered[0]!.deviceId,
        targetSessionKey: 'session:recipient',
        text: 'Stop after the current tool boundary and re-check the migration.',
        createdAt: now,
      };
      assert.deepEqual(recipient.acceptPeerMessage(duplicateEnvelope), {
        queued: true,
        status: 'queued',
        transport: 'local',
        messageId: 'msg-exact-key',
        targetSessionKey: 'session:recipient',
        acceptedAt: now,
        pending: 1,
        duplicate: true,
      }, 'a remote push racing local delivery must not enqueue twice');
      assert.equal(wakeCount, 1, 'a duplicate must not wake the recipient twice');

      assert.deepEqual(recipient.drain().messages, [{
        id: 'msg-exact-key',
        senderSessionKey: 'session:sender',
        senderDeviceId: discovered[0]!.deviceId,
        targetSessionKey: 'session:recipient',
        text: 'Stop after the current tool boundary and re-check the migration.',
        source: 'peer-session',
        trust: 'untrusted-session',
        createdAt: now,
        receivedAt: now,
      }]);
      assert.deepEqual(recipient.acceptPeerMessage(duplicateEnvelope), {
        queued: true,
        status: 'queued',
        transport: 'local',
        messageId: 'msg-exact-key',
        targetSessionKey: 'session:recipient',
        acceptedAt: now,
        pending: 0,
        duplicate: true,
      }, 'a later poll of the same durable id must remain a no-op after drain');
      assert.deepEqual(recipient.drain().messages, []);
      assert.equal(wakeCount, 1);

      const titleSend = await sendLocalSessionMessage('Investigate the same failure', {
        senderSessionKey: 'session:sender',
        text: 'This title is deliberately ambiguous.',
        createdAt: now,
      }, { now: () => now });
      assert.equal(titleSend.queued, false);
      assert.equal(titleSend.queued ? '' : titleSend.reason, 'not_found',
        'titles are discovery metadata and never aliases');

      const selfSend = await sendLocalSessionMessage('session:sender', {
        id: 'client-self-send',
        senderSessionKey: 'session:sender',
        text: 'must not loop back to the same identity',
        createdAt: now,
      }, { now: () => now });
      assert.deepEqual(selfSend, {
        queued: false,
        status: 'not_queued',
        transport: 'local',
        targetSessionKey: 'session:sender',
        reason: 'self_send',
        messageId: 'client-self-send',
      });
      assert.equal(sender.pendingCount(), 0);

      now += 1;
      const updated = recipient.updateRegistration({ state: 'waiting', title: 'Waiting for approval' });
      assert.equal(updated.state, 'waiting');
      const refreshed = await discoverLocalSessionRoutes({ now: () => now });
      assert.equal(refreshed.find((route) => route.sessionKey === 'session:recipient')?.title,
        'Waiting for approval');
    } finally {
      await Promise.all([sender.close(), recipient.close()]);
    }
  });
});

test('ADR-034 remote admission keeps the database absolute deadline instead of resetting age', async () => {
  await withTempWorkspaceAsync(async () => {
    const createdAt = 1_000;
    const expiresAt = createdAt + 24 * 60 * 60 * 1_000;
    let now = expiresAt - 5;
    const recipient = await startLocalSessionTransport({
      sessionKey: 'session:remote-expiry',
      clientKind: 'desktop',
      now: () => now,
    });
    const envelope = {
      id: 'remote-expiry-message',
      senderSessionKey: 'session:remote-sender',
      senderDeviceId: '11111111-1111-4111-8111-111111111111',
      targetSessionKey: 'session:remote-expiry',
      text: 'Apply only before the database deadline.',
      createdAt,
      expiresAt,
    };
    try {
      assert.equal(recipient.acceptPeerMessage(envelope).queued, true);
      now = expiresAt;
      assert.deepEqual(recipient.drain().messages, []);
      assert.deepEqual(recipient.acceptPeerMessage(envelope), {
        queued: false,
        status: 'not_queued',
        transport: 'local',
        targetSessionKey: envelope.targetSessionKey,
        reason: 'expired',
        messageId: envelope.id,
      });
    } finally {
      await recipient.close();
    }
  });
});

test('ADR-034 listener close rejects a partial in-flight POST before mailbox admission', async () => {
  await withTempWorkspaceAsync(async () => {
    const sender = await startLocalSessionTransport({
      sessionKey: 'session:shutdown-sender',
      clientKind: 'cli',
    });
    const recipient = await startLocalSessionTransport({
      sessionKey: 'session:shutdown-recipient',
      clientKind: 'desktop',
    });
    try {
      const entries = listLocalSessionRegistryEntries();
      const senderEntry = entries.find((entry) => entry.sessionKey === 'session:shutdown-sender')!;
      const recipientEntry = entries.find((entry) => entry.sessionKey === 'session:shutdown-recipient')!;
      const envelope = {
        id: 'shutdown-race-message',
        senderSessionKey: senderEntry.sessionKey,
        senderDeviceId: senderEntry.deviceId,
        targetSessionKey: recipientEntry.sessionKey,
        text: 'Must be rejected or included in the final drain.',
        createdAt: Date.now(),
      };
      const serialized = JSON.stringify({
        ...envelope,
        senderProof: createLocalSessionSenderProof(envelope, senderEntry.instanceId, senderEntry.token),
      });
      let continueRequest!: () => void;
      const continued = new Promise<void>((resolve) => { continueRequest = resolve; });
      const responseStatus = new Promise<number>((resolve, reject) => {
        const request = http.request({
          host: LOCAL_SESSION_HOST,
          port: recipientEntry.port,
          path: '/session-messaging/v1/messages',
          method: 'POST',
          headers: {
            [LOCAL_SESSION_AUTH_HEADER]: recipientEntry.token,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(serialized),
            expect: '100-continue',
          },
        });
        request.once('continue', continueRequest);
        request.once('response', (response) => {
          response.resume();
          response.once('end', () => resolve(response.statusCode ?? 0));
        });
        request.once('error', reject);
        request.flushHeaders();
        void continued.then(() => {
          const split = Math.floor(serialized.length / 2);
          request.write(serialized.slice(0, split));
          setImmediate(() => {
            const closing = recipient.close();
            setImmediate(() => {
              request.end(serialized.slice(split));
              void closing.catch(reject);
            });
          });
        });
      });

      await continued;
      assert.equal(await responseStatus, 503,
        'shutdown wins before mailbox admission, so the sender never observes 202');
      assert.equal(recipient.pendingCount(), 0);
      assert.deepEqual(recipient.drain().messages, []);
    } finally {
      await Promise.all([sender.close(), recipient.close()]);
    }
  });
});

test('ADR-034 duplicate live claims for one exact key refuse instead of guessing', async () => {
  await withTempWorkspaceAsync(async () => {
    const first = await startLocalSessionTransport({ sessionKey: 'session:duplicate', clientKind: 'cli' });
    const second = await startLocalSessionTransport({ sessionKey: 'session:duplicate', clientKind: 'desktop' });
    try {
      const discovered = await discoverLocalSessionRoutes();
      assert.equal(discovered.length, 1);
      assert.equal(discovered[0]?.ambiguous, true);
      assert.equal(discovered[0]?.instanceCount, 2);

      const receipt = await sendLocalSessionMessage('session:duplicate', {
        senderSessionKey: 'session:sender',
        text: 'Do not guess which duplicate owns this identity.',
      });
      assert.equal(receipt.queued, false);
      assert.equal(receipt.queued ? '' : receipt.reason, 'ambiguous');
      assert.equal(first.pendingCount(), 0);
      assert.equal(second.pendingCount(), 0);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });
});

test('ADR-034 duplicate live sender claims cannot authenticate one envelope', async () => {
  await withTempWorkspaceAsync(async () => {
    const firstSender = await startLocalSessionTransport({ sessionKey: 'session:duplicate-sender', clientKind: 'cli' });
    const secondSender = await startLocalSessionTransport({ sessionKey: 'session:duplicate-sender', clientKind: 'desktop' });
    const recipient = await startLocalSessionTransport({ sessionKey: 'session:unique-recipient', clientKind: 'desktop' });
    try {
      const receipt = await sendLocalSessionMessage('session:unique-recipient', {
        id: 'ambiguous-sender-proof',
        senderSessionKey: 'session:duplicate-sender',
        text: 'No one incarnation may speak for an ambiguous logical sender.',
      });
      assert.equal(receipt.queued, false);
      assert.equal(receipt.queued ? '' : receipt.reason, 'rejected');
      assert.equal(recipient.pendingCount(), 0);
    } finally {
      await Promise.all([firstSender.close(), secondSender.close(), recipient.close()]);
    }
  });
});

test('ADR-034 discovery probes liveness and reaps a crashed listener entry', async () => {
  await withTempWorkspaceAsync(async () => {
    const handle = await startLocalSessionTransport({ sessionKey: 'session:crashed', clientKind: 'cli' });
    const entry = listLocalSessionRegistryEntries()[0]!;
    await handle.close();
    writeLocalSessionRegistryEntry(entry);
    assert.equal(listLocalSessionRegistryEntries().length, 1, 'the fixture recreates a crash-left record');

    assert.deepEqual(await discoverLocalSessionRoutes({ probeTimeoutMs: 50 }), []);
    assert.deepEqual(listLocalSessionRegistryEntries(), [], 'a failed exact health probe must reap the stale file');
  });
});

test('ADR-034 local delivery refuses a claimed sender that has no live authenticated registration', async () => {
  await withTempWorkspaceAsync(async () => {
    const recipient = await startLocalSessionTransport({
      sessionKey: 'session:recipient-only',
      clientKind: 'desktop',
    });
    try {
      const receipt = await sendLocalSessionMessage('session:recipient-only', {
        id: 'missing-sender-proof',
        senderSessionKey: 'session:not-live',
        text: 'This sender identity must not be accepted on a target capability alone.',
      });
      assert.equal(receipt.queued, false);
      assert.equal(receipt.queued ? '' : receipt.reason, 'rejected');
      assert.equal(recipient.pendingCount(), 0);
    } finally {
      await recipient.close();
    }
  });
});

test('ADR-034 sender rollover retries stale proof without reaping the healthy recipient', async () => {
  await withTempWorkspaceAsync(async () => {
    const sender = await startLocalSessionTransport({
      sessionKey: 'session:rollover-sender',
      clientKind: 'cli',
    });
    let replacement: Awaited<ReturnType<typeof startLocalSessionTransport>> | undefined;
    let targetEntry: ReturnType<typeof newLocalSessionRegistryEntry> | undefined;
    let postCount = 0;
    let handlerError: unknown;
    const server = http.createServer((request, response) => {
      void (async () => {
        if (!targetEntry || request.headers[LOCAL_SESSION_AUTH_HEADER] !== targetEntry.token) {
          return sendTestJson(response, 401, { error: 'unauthorized' });
        }
        if (request.url === '/session-messaging/v1/health') {
          return sendTestJson(response, 200, {
            protocol: LOCAL_SESSION_PROTOCOL,
            sessionKey: targetEntry.sessionKey,
            instanceId: targetEntry.instanceId,
            deviceId: targetEntry.deviceId,
          });
        }
        if (request.url !== '/session-messaging/v1/messages') {
          return sendTestJson(response, 404, { error: 'not_found' });
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        postCount += 1;
        if (postCount === 1) {
          await sender.close();
          replacement = await startLocalSessionTransport({
            sessionKey: 'session:rollover-sender',
            clientKind: 'desktop',
          });
          return sendTestJson(response, 401, { error: 'stale_sender_proof' });
        }

        const currentSenders = listLocalSessionRegistryEntries().filter((entry) =>
          entry.sessionKey === 'session:rollover-sender');
        assert.equal(currentSenders.length, 1);
        assert.equal(
          verifyLocalSessionSenderProof(
            body as unknown as Parameters<typeof verifyLocalSessionSenderProof>[0],
            body.senderProof,
            currentSenders[0]!,
          ),
          true,
          'the retry must use the replacement sender capability',
        );
        sendTestJson(response, 202, {
          queued: true,
          status: 'queued',
          transport: 'local',
          messageId: body.id,
          targetSessionKey: targetEntry.sessionKey,
          acceptedAt: Date.now(),
          pending: 1,
          duplicate: false,
        });
      })().catch((error) => {
        handlerError = error;
        if (!response.headersSent) sendTestJson(response, 500, { error: 'test_handler' });
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, LOCAL_SESSION_HOST, resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const senderEntry = listLocalSessionRegistryEntries().find((entry) =>
      entry.sessionKey === 'session:rollover-sender')!;
    const now = Date.now();
    targetEntry = newLocalSessionRegistryEntry({
      sessionKey: 'session:rollover-recipient',
      deviceId: senderEntry.deviceId,
      clientKind: 'desktop',
      state: 'idle',
      pid: process.pid,
      port: address.port,
      registeredAt: now,
      updatedAt: now,
    });
    writeLocalSessionRegistryEntry(targetEntry);

    try {
      const receipt = await sendLocalSessionMessage(targetEntry.sessionKey, {
        id: 'sender-rollover-retry',
        senderSessionKey: senderEntry.sessionKey,
        text: 'Retry this exact envelope with the new sender incarnation.',
        createdAt: now,
      }, { probeTimeoutMs: 500, deliveryTimeoutMs: 2_000 });
      assert.equal(receipt.queued, true);
      assert.equal(postCount, 2);
      assert.equal(handlerError, undefined);
      assert.equal(
        listLocalSessionRegistryEntries().some((entry) => entry.instanceId === targetEntry?.instanceId),
        true,
        'a stale sender proof must never reap a recipient that still passes exact health',
      );
    } finally {
      if (targetEntry) removeLocalSessionRegistryEntry(targetEntry);
      await Promise.all([
        sender.close(),
        replacement?.close(),
        new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
      ]);
    }
  });
});

function sendTestJson(response: http.ServerResponse, status: number, body: object): void {
  const serialized = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(serialized),
  });
  response.end(serialized);
}
