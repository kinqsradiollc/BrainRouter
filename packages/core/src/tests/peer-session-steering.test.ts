/**
 * ADR-034 peer steering regressions: authenticated provenance survives
 * transcript resume/compaction and content applies once outside the user role.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPendingSteeringAtBoundary } from '../agent/runtime/steering.js';
import {
  type PeerSessionSteeringInput,
  type SteeringInput,
} from '../session/input/inputDelivery.js';
import {
  approveHeldSessionMessage,
  holdSessionMessage,
  listHeldSessionMessages,
} from '../session/input/heldSessionMessages.js';
import { LOCAL_SESSION_DEFAULT_MAX_AGE_MS } from '../session/messaging/contracts.js';
import { loadTranscript } from '../session/transcript/sessionStore.js';
import { readWorkContract } from '../task/workContractStore.js';
import { makeAgent, withTempWorkspaceAsync } from './_helpers.js';

test('peer steering applies at a safe boundary with provenance and never a user role', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const input: PeerSessionSteeringInput = {
      id: 'peer-1',
      text: 'Re-check the release branch.',
      source: 'peer-session',
      createdAt: 1_000,
      sender: {
        sessionKey: 'sender:1',
        deviceId: 'device:1',
        transport: 'local',
      },
    };
    const history: Array<Record<string, unknown>> = [];
    const transcript: Array<Record<string, unknown>> = [];
    const statuses: string[] = [];
    const fake = {
      workspaceRoot: workspace,
      sessionKey: 'recipient:1',
      chatHistory: history,
      consumePendingSteering: () => [input],
      restorePendingSteering: () => {},
      recordTranscript: (entry: Record<string, unknown>) => transcript.push(entry),
    };

    assert.equal(applyPendingSteeringAtBoundary(
      fake,
      { onStatusUpdate: (status) => statuses.push(status) },
      input.createdAt + 1,
    ), 1);
    const delivered = history.at(-1);
    assert.equal(delivered?.role, 'assistant');
    assert.equal(delivered?.name, 'peer-session');
    assert.equal(delivered?.trust, 'untrusted-session');
    assert.equal(delivered?.deliveryId, 'peer-1');
    assert.equal((delivered?.provenance as { sessionKey?: string })?.sessionKey, 'sender:1');
    assert.equal(history.some((entry) => entry.role === 'user'), false);
    assert.equal(transcript.at(-1)?.role, 'assistant');
    assert.match(statuses[0] ?? '', /next safe model boundary/i);
    assert.equal(readWorkContract(workspace, 'recipient:1')?.steering[0]?.source, 'peer-session');
  });
});

test('a replayed peer receipt is acknowledged without applying its content twice', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const input: PeerSessionSteeringInput = {
      id: 'peer-replay-1',
      text: 'Keep the existing release scope.',
      source: 'peer-session',
      createdAt: 2_000,
      sender: { sessionKey: 'sender:2', transport: 'remote' },
    };
    const history: Array<Record<string, unknown>> = [];
    const transcript: Array<Record<string, unknown>> = [];
    const applied: string[] = [];
    const statuses: string[] = [];
    const fake = {
      workspaceRoot: workspace,
      sessionKey: 'recipient:2',
      chatHistory: history,
      consumePendingSteering: () => [input],
      restorePendingSteering: () => {},
      recordTranscript: (entry: Record<string, unknown>) => transcript.push(entry),
    };
    const callbacks = {
      onStatusUpdate: (status: string) => statuses.push(status),
      onSteerApplied: (steer: { id: string }) => applied.push(steer.id),
    };

    assert.equal(applyPendingSteeringAtBoundary(fake, callbacks, input.createdAt + 1), 1);
    assert.equal(applyPendingSteeringAtBoundary(fake, callbacks, input.createdAt + 2), 1);

    assert.equal(history.filter((entry) => entry.deliveryId === input.id).length, 1);
    assert.equal(transcript.filter((entry) => entry.deliveryId === input.id).length, 1);
    assert.deepEqual(applied, [input.id, input.id]);
    assert.match(statuses.at(-1) ?? '', /already-applied peer replay/i);
  });
});

test('a restart and compaction after transcript append cannot apply a lost-ack peer delivery twice', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const message = {
      id: 'peer-crash-window-1',
      senderSessionKey: 'sender:restart',
      senderDeviceId: '11111111-1111-4111-8111-111111111111',
      targetSessionKey: 'session:test',
      text: 'Preserve the accepted release boundary.',
      source: 'peer-session' as const,
      trust: 'untrusted-session' as const,
      createdAt: 3_000,
      receivedAt: 4_000,
    };
    const first = makeAgent(workspace);
    first.chatHistory = [
      first.createSystemMessage(),
      { role: 'user', content: `Initial request ${'context '.repeat(200)}` },
      { role: 'assistant', content: `Initial answer ${'evidence '.repeat(200)}` },
    ];
    first.recordTranscript(first.chatHistory[1]);
    first.recordTranscript(first.chatHistory[2]);
    first.requestPeerSessionSteer(message, {
      clientKind: 'cli',
      title: 'Release verifier',
      workspaceRoot: '/repos/release',
      transport: 'remote',
    });

    // The peer observation reaches the transcript, then the process dies
    // before the host can persist the sender acknowledgement.
    applyPendingSteeringAtBoundary(first, { onStatusUpdate: () => {} }, 5_000);
    const persisted = loadTranscript(workspace, first.sessionKey);
    const persistedPeer = persisted.find((entry) => entry.deliveryId === message.id);
    assert.equal(persistedPeer?.trust, 'untrusted-session');
    assert.deepEqual(persistedPeer?.provenance, {
      sessionKey: 'sender:restart',
      deviceId: message.senderDeviceId,
      sentAt: message.createdAt,
      clientKind: 'cli',
      title: 'Release verifier',
      workspaceRoot: '/repos/release',
      transport: 'remote',
    });

    const resumed = makeAgent(workspace);
    resumed.loadHistory(persisted);
    const resumedPeer = resumed.chatHistory.find((entry) => entry.deliveryId === message.id);
    assert.equal(resumedPeer?.trust, 'untrusted-session');
    assert.deepEqual(resumedPeer?.provenance, persistedPeer?.provenance);

    // A later user turn lets compaction replace the older conversation. The
    // runtime delivery projection must remain even after the peer row leaves
    // model-visible history.
    resumed.chatHistory.push({ role: 'user', content: 'Continue with the current release boundary.' });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: '<summary>Release boundary remains unchanged.</summary>' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    try {
      await resumed.compactHistory();
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(resumed.chatHistory.some((entry) => entry.deliveryId === message.id), false);

    let acknowledged = 0;
    resumed.requestPeerSessionSteer(message, { transport: 'remote' });
    applyPendingSteeringAtBoundary(resumed, {
      onStatusUpdate: () => {},
      onSteerApplied: () => { acknowledged += 1; },
    }, 5_001);

    assert.equal(acknowledged, 1, 'the replay must still re-emit the lost acknowledgement');
    assert.equal(
      loadTranscript(workspace, resumed.sessionKey).filter((entry) => entry.deliveryId === message.id).length,
      1,
      'the peer content must remain exactly once in durable history',
    );
  });
});

test('an approval before cutoff expires at a later safe boundary without losing following steering', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const sentAt = 10_000;
    const boundary = sentAt + LOCAL_SESSION_DEFAULT_MAX_AGE_MS;
    const receivedAt = boundary - 5;
    const message = {
      id: 'peer-boundary-expiry',
      senderSessionKey: 'sender:expiry',
      senderDeviceId: '11111111-1111-4111-8111-111111111111',
      targetSessionKey: 'recipient:expiry',
      text: 'This must not reach model history after expiry.',
      source: 'peer-session' as const,
      trust: 'untrusted-session' as const,
      createdAt: sentAt,
      receivedAt,
      expiresAt: boundary,
    };
    holdSessionMessage(workspace, message, 'needs approval', receivedAt);
    const approved = approveHeldSessionMessage(
      workspace,
      message.targetSessionKey,
      message.id,
      receivedAt + 1,
    );
    assert.ok(approved.input, 'the pre-cutoff approval must produce pending steering');

    const fresh: SteeringInput = {
      id: 'fresh-user-steer',
      text: 'Continue with the safe release check.',
      source: 'user',
      createdAt: receivedAt + 2,
    };
    let queue: SteeringInput[] = [approved.input!, fresh];
    const history: Array<Record<string, unknown>> = [];
    const transcript: Array<Record<string, unknown>> = [];
    const applied: string[] = [];
    const expired: string[] = [];
    const fake = {
      workspaceRoot: workspace,
      sessionKey: message.targetSessionKey,
      chatHistory: history,
      consumePendingSteering: () => queue.splice(0),
      restorePendingSteering: (inputs: SteeringInput[]) => { queue = [...inputs, ...queue]; },
      recordTranscript: (entry: Record<string, unknown>) => { transcript.push(entry); },
    };

    assert.equal(applyPendingSteeringAtBoundary(fake, {
      onStatusUpdate: () => {},
      onSteerApplied: (input) => { applied.push(input.id); },
      onSteerExpired: (input) => { expired.push(input.id); },
    }, boundary), 2);

    assert.deepEqual(expired, [message.id]);
    assert.deepEqual(applied, [fresh.id]);
    assert.equal(queue.length, 0);
    assert.equal(history.some((entry) => entry.deliveryId === message.id), false);
    assert.equal(transcript.some((entry) => entry.deliveryId === message.id), false);
    assert.equal(history.some((entry) => entry.content === fresh.text), true);
    assert.equal(
      listHeldSessionMessages(workspace, message.targetSessionKey, { now: boundary })[0]?.status,
      'expired',
    );
  });
});

test('a receipt failure restores the current steering item and untouched suffix', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const first: SteeringInput = { id: 'receipt-1', text: 'First', source: 'user', createdAt: 1 };
    const second: SteeringInput = { id: 'receipt-2', text: 'Second', source: 'user', createdAt: 2 };
    let queue: SteeringInput[] = [first, second];
    let failReceipt = true;
    const history: Array<Record<string, unknown>> = [];
    const fake = {
      workspaceRoot: workspace,
      sessionKey: 'receipt-failure',
      chatHistory: history,
      consumePendingSteering: () => queue.splice(0),
      restorePendingSteering: (inputs: SteeringInput[]) => { queue = [...inputs, ...queue]; },
      recordTranscript: () => {},
      beginSteeringReceipt: () => {
        if (failReceipt) {
          failReceipt = false;
          throw new Error('injected receipt failure');
        }
        return {
          id: 'receipt', source: 'user' as const, receivedAt: new Date(0).toISOString(),
          priorRevision: 0, affectedRequirementIds: [], affectedTaskIds: [],
          summary: 'fixture', status: 'pending' as const,
        };
      },
    };

    assert.throws(
      () => applyPendingSteeringAtBoundary(fake, { onStatusUpdate: () => {} }, 3),
      /injected receipt failure/,
    );
    assert.deepEqual(queue.map((input) => input.id), [first.id, second.id]);
    assert.equal(history.length, 0);

    assert.equal(applyPendingSteeringAtBoundary(fake, { onStatusUpdate: () => {} }, 3), 2);
    assert.deepEqual(
      history.filter((entry) => entry.role === 'user').map((entry) => entry.content),
      [first.text, second.text],
    );
  });
});

test('a transcript failure restores every unapplied steering item without duplicate history', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const first: SteeringInput = { id: 'transcript-1', text: 'First', source: 'user', createdAt: 1 };
    const second: SteeringInput = { id: 'transcript-2', text: 'Second', source: 'user', createdAt: 2 };
    let queue: SteeringInput[] = [first, second];
    let failTranscript = true;
    const history: Array<Record<string, unknown>> = [];
    const transcript: Array<Record<string, unknown>> = [];
    const fake = {
      workspaceRoot: workspace,
      sessionKey: 'transcript-failure',
      chatHistory: history,
      consumePendingSteering: () => queue.splice(0),
      restorePendingSteering: (inputs: SteeringInput[]) => { queue = [...inputs, ...queue]; },
      recordTranscript: (entry: Record<string, unknown>) => {
        if (failTranscript) {
          failTranscript = false;
          throw new Error('injected transcript failure');
        }
        transcript.push(entry);
      },
    };

    assert.throws(
      () => applyPendingSteeringAtBoundary(fake, { onStatusUpdate: () => {} }, 3),
      /injected transcript failure/,
    );
    assert.deepEqual(queue.map((input) => input.id), [first.id, second.id]);
    assert.equal(history.length, 0);
    assert.equal(transcript.length, 0);

    applyPendingSteeringAtBoundary(fake, { onStatusUpdate: () => {} }, 3);
    assert.deepEqual(
      history.filter((entry) => entry.role === 'user').map((entry) => entry.content),
      [first.text, second.text],
    );
  });
});

test('a peer callback failure retries acknowledgement and preserves its suffix without reapplication', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const peer = (id: string, text: string): PeerSessionSteeringInput => ({
      id, text, source: 'peer-session', createdAt: 1,
      sender: { sessionKey: `sender:${id}`, transport: 'remote' },
    });
    const first = peer('callback-1', 'First peer observation');
    const second = peer('callback-2', 'Second peer observation');
    let queue: SteeringInput[] = [first, second];
    const appliedIds = new Set<string>();
    let failCallback = true;
    const acknowledged: string[] = [];
    const history: Array<Record<string, unknown>> = [];
    const fake = {
      workspaceRoot: workspace,
      sessionKey: 'callback-failure',
      chatHistory: history,
      consumePendingSteering: () => queue.splice(0),
      restorePendingSteering: (inputs: SteeringInput[]) => { queue = [...inputs, ...queue]; },
      recordTranscript: () => {},
      hasAppliedPeerDelivery: (id: string) => appliedIds.has(id),
      rememberAppliedPeerDelivery: (input: PeerSessionSteeringInput) => { appliedIds.add(input.id); },
    };
    const callbacks = {
      onStatusUpdate: () => {},
      onSteerApplied: (input: SteeringInput) => {
        if (failCallback) {
          failCallback = false;
          throw new Error('injected callback failure');
        }
        acknowledged.push(input.id);
      },
    };

    assert.throws(
      () => applyPendingSteeringAtBoundary(fake, callbacks, 2),
      /injected callback failure/,
    );
    assert.deepEqual(queue.map((input) => input.id), [first.id, second.id]);
    assert.deepEqual(
      history.filter((entry) => entry.deliveryId).map((entry) => entry.deliveryId),
      [first.id],
    );

    applyPendingSteeringAtBoundary(fake, callbacks, 2);
    assert.deepEqual(acknowledged, [first.id, second.id]);
    assert.deepEqual(
      history.filter((entry) => entry.deliveryId).map((entry) => entry.deliveryId),
      [first.id, second.id],
    );
  });
});
