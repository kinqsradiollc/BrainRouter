/**
 * ADR-034 Desktop messaging lifecycle regressions: verified envelopes retain
 * truthful hold, receipt, retry, switch, and shutdown state.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  HELD_SESSION_MESSAGE_MAX_AGE_MS,
  HELD_SESSION_MESSAGE_MAX_RECORDS,
  expireHeldSessionMessages,
  getSessionMeta,
  holdSessionMessage,
  setSessionMeta,
  type LocalSessionMessage,
  type LocalSessionTransportHandle,
  type PeerSessionSender,
  type PeerSessionMessageInput,
  type SessionRouteDescriptor,
} from '@kinqs/brainrouter-core/session';
import { getStateFile, writeJsonFile } from '@kinqs/brainrouter-core/storage';
import {
  DesktopSessionMessaging,
  desktopPeerReceiptWording,
  resolveDesktopPeerAddress,
  type DesktopSessionMessagingMcp,
} from './sessionMessaging.js';

function result(payload: unknown, isError = false): unknown {
  return { ...(isError ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  // 10s budget (1000 x 10ms), not 2s. These predicates wait on an async service
  // to start its transport, poll its inbox, and reach a state — comfortably under
  // a second locally, but a loaded CI runner sharing the box with the full
  // workspace suite can miss a 2s window without anything being wrong. The
  // assertions are unchanged; only the patience is. A genuinely stuck state still
  // fails, just later.
  for (let index = 0; index < 1000; index += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('timed out waiting for Desktop session-messaging state');
}

function fakeTransport(
  sessionKey: string,
  onMessageAvailable?: (message: LocalSessionMessage) => void,
): LocalSessionTransportHandle {
  let messages: LocalSessionMessage[] = [];
  let state: 'idle' | 'working' | 'waiting' = 'idle';
  const accepted = new Map<string, PeerSessionMessageInput>();
  return {
    host: '127.0.0.1',
    port: 49152,
    registration: () => ({ sessionKey, deviceId: '11111111-1111-4111-8111-111111111111', clientKind: 'desktop', state, transport: 'local', lastSeenAt: Date.now() }),
    pendingCount: () => messages.length,
    drain: () => { const drained = messages; messages = []; return { messages: drained, expired: [], expiredOmitted: 0 }; },
    acceptPeerMessage: (input: PeerSessionMessageInput) => {
      const prior = accepted.get(input.id);
      if (prior) {
        const same = JSON.stringify(prior) === JSON.stringify(input);
        if (!same) return { queued: false, status: 'not_queued', transport: 'local', targetSessionKey: sessionKey, messageId: input.id, reason: 'id_conflict' };
        return { queued: true, status: 'queued', transport: 'local', messageId: input.id, targetSessionKey: sessionKey, acceptedAt: Date.now(), pending: messages.length, duplicate: true };
      }
      accepted.set(input.id, { ...input });
      const message: LocalSessionMessage = { ...input, source: 'peer-session', trust: 'untrusted-session', receivedAt: Date.now() };
      messages.push(message);
      onMessageAvailable?.(message);
      return { queued: true, status: 'queued', transport: 'local', messageId: input.id, targetSessionKey: sessionKey, acceptedAt: Date.now(), pending: messages.length, duplicate: false };
    },
    updateRegistration: (patch) => {
      state = patch.state ?? state;
      return { sessionKey, deviceId: '11111111-1111-4111-8111-111111111111', clientKind: 'desktop', state, transport: 'local', lastSeenAt: Date.now(), title: patch.title };
    },
    close: async () => {},
  };
}

test('offline Desktop starts its authenticated local participant without calling the Brain', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-desktop-peers-offline-'));
  let started = 0;
  let calls = 0;
  try {
    const service = new DesktopSessionMessaging({
      workspaceRoot: root,
      mcp: {
        callTool: async () => { calls += 1; throw new Error('offline'); },
        getActiveBrainrouterServerId: () => undefined,
      },
      getActiveAgent: () => ({ sessionKey: 'desktop:offline', getAccessMode: () => 'read', interactionPort: {} }),
      deliverPeer: () => ({ accepted: true, state: 'steered' }),
      confirmHeld: async () => false,
      pollIntervalMs: 60_000,
      local: {
        start: async (options) => { started += 1; return fakeTransport(options.sessionKey, options.onMessageAvailable); },
        discover: async () => [],
        send: async (key, input) => ({ queued: true, status: 'queued', transport: 'local', messageId: input.id!, targetSessionKey: key, acceptedAt: Date.now(), pending: 1, duplicate: false }),
        deviceId: () => '11111111-1111-4111-8111-111111111111',
      },
    });
    await service.start();
    assert.equal(started, 1);
    assert.equal(calls, 0);
    assert.equal((await service.listPeers()).brainOnline, false);
    await service.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Desktop human title publication persists display metadata without changing the exact key', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-desktop-human-title-'));
  const sessionKey = 'desktop:new-fixed-address';
  const service = new DesktopSessionMessaging({
    workspaceRoot: root,
    mcp: {
      callTool: async () => { throw new Error('offline'); },
      getActiveBrainrouterServerId: () => undefined,
    },
    getActiveAgent: () => ({ sessionKey, getAccessMode: () => 'read' }),
    deliverPeer: () => ({ accepted: true, state: 'steered' }),
    confirmHeld: async () => null,
    pollIntervalMs: 60_000,
    local: {
      start: async (options) => fakeTransport(options.sessionKey, options.onMessageAvailable),
      discover: async () => [],
      send: async (key, input) => ({ queued: true, status: 'queued', transport: 'local', messageId: input.id!, targetSessionKey: key, acceptedAt: Date.now(), pending: 1, duplicate: false }),
      deviceId: () => '11111111-1111-4111-8111-111111111111',
    },
  });
  try {
    await service.start();
    service.setTitle(sessionKey, 'Repeated release label', 'human');
    assert.deepEqual(getSessionMeta(root, sessionKey), {
      title: 'Repeated release label',
      titleSource: 'human',
    });
    assert.equal(service.listHeld().length, 0, 'title metadata cannot reclaim an inbox row');
  } finally {
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Desktop surfaces bounded local mailbox expiry notices during normal drain, switch, and close', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-desktop-expiry-notices-'));
  const active = { current: { sessionKey: 'desktop:expiry-a', getAccessMode: () => 'read' as const } };
  const notices: Array<{ sessionKey: string; message: string }> = [];
  const controls = new Map<string, {
    notify(): void;
    drains: Array<ReturnType<LocalSessionTransportHandle['drain']>>;
  }>();
  const service = new DesktopSessionMessaging({
    workspaceRoot: root,
    mcp: {
      callTool: async () => { throw new Error('offline'); },
      getActiveBrainrouterServerId: () => undefined,
    },
    getActiveAgent: () => active.current,
    deliverPeer: () => ({ accepted: true, state: 'steered' }),
    confirmHeld: async () => null,
    onNotice: (sessionKey, message) => notices.push({ sessionKey, message }),
    pollIntervalMs: 60_000,
    local: {
      start: async (options) => {
        const drains: Array<ReturnType<LocalSessionTransportHandle['drain']>> = [];
        const base = fakeTransport(options.sessionKey);
        const handle: LocalSessionTransportHandle = {
          ...base,
          drain: () => drains.shift() ?? { messages: [], expired: [], expiredOmitted: 0 },
        };
        controls.set(options.sessionKey, {
          drains,
          notify: () => options.onMessageAvailable?.({} as LocalSessionMessage),
        });
        return handle;
      },
      discover: async () => [],
      send: async (key, input) => ({ queued: true, status: 'queued', transport: 'local', messageId: input.id!, targetSessionKey: key, acceptedAt: Date.now(), pending: 1, duplicate: false }),
      deviceId: () => '11111111-1111-4111-8111-111111111111',
    },
  });
  try {
    await service.start(active.current);
    const a = controls.get(active.current.sessionKey)!;
    a.drains.push({
      messages: [],
      expired: [{ messageId: 'normal-expired', senderSessionKey: 'cli:sender', expiredAt: Date.now() }],
      expiredOmitted: 2,
    });
    a.notify();
    await new Promise<void>((resolve) => setImmediate(resolve));

    a.drains.push({
      messages: [],
      expired: [{ messageId: 'switch-expired', senderSessionKey: 'cli:sender', expiredAt: Date.now() }],
      expiredOmitted: 0,
    });
    active.current = { sessionKey: 'desktop:expiry-b', getAccessMode: () => 'read' as const };
    await service.activate(active.current);

    const b = controls.get(active.current.sessionKey)!;
    b.drains.push({
      messages: [],
      expired: [{ messageId: 'close-expired', senderSessionKey: 'cli:sender', expiredAt: Date.now() }],
      expiredOmitted: 0,
    });
    await service.close();

    assert.deepEqual(notices.map((notice) => notice.sessionKey), [
      'desktop:expiry-a',
      'desktop:expiry-a',
      'desktop:expiry-a',
      'desktop:expiry-b',
    ]);
    assert.match(notices[0]!.message, /normal-expired.*expired before recipient admission/i);
    assert.match(notices[1]!.message, /2 older peer-message expiry notices were omitted/i);
    assert.match(notices[2]!.message, /switch-expired.*expired before recipient admission/i);
    assert.match(notices[3]!.message, /close-expired.*expired before recipient admission/i);
  } finally {
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI and Desktop routes share one address space, local wins, and prefix ambiguity refuses', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-desktop-peers-routes-'));
  const localRoutes: SessionRouteDescriptor[] = [{
    sessionKey: 'cli:release-check', deviceId: '11111111-1111-4111-8111-111111111111',
    clientKind: 'cli', state: 'working', transport: 'local', lastSeenAt: 20, title: 'Local release check', instanceCount: 1,
  }];
  let sentTarget = '';
  const mcp: DesktopSessionMessagingMcp = {
    getActiveBrainrouterServerId: () => 'brainrouter',
    callTool: async (name) => {
      if (name === 'session_register') return result({ session: { sessionKey: 'desktop:active' } });
      if (name === 'session_list') return result({ sessions: [
        { sessionKey: 'cli:release-check', deviceId: '22222222-2222-4222-8222-222222222222', clientKind: 'brainrouter-cli', state: 'idle', messageWakeVersion: 1, lastHeartbeatAt: new Date().toISOString(), metadata: {} },
        { sessionKey: 'cli:release-notes', deviceId: '33333333-3333-4333-8333-333333333333', clientKind: 'brainrouter-cli', state: 'idle', lastHeartbeatAt: new Date().toISOString(), metadata: {} },
      ] });
      if (name === 'session_inbox_read') return result({ messages: [] });
      return result({ deleted: true });
    },
  };
  try {
    const service = new DesktopSessionMessaging({
      workspaceRoot: root,
      mcp,
      getActiveAgent: () => ({ sessionKey: 'desktop:active', getAccessMode: () => 'read', interactionPort: {} }),
      deliverPeer: () => ({ accepted: true, state: 'steered' }),
      confirmHeld: async () => false,
      pollIntervalMs: 60_000,
      local: {
        start: async (options) => fakeTransport(options.sessionKey, options.onMessageAvailable),
        discover: async () => localRoutes,
        send: async (key, input) => {
          sentTarget = key;
          return { queued: true, status: 'queued', transport: 'local', messageId: input.id!, targetSessionKey: key, acceptedAt: Date.now(), pending: 1, duplicate: false };
        },
        deviceId: () => '11111111-1111-4111-8111-111111111111',
      },
    });
    await service.start();
    const snapshot = await service.listPeers();
    assert.equal(snapshot.routes.find((route) => route.sessionKey === 'cli:release-check')?.transport, 'local');
    assert.equal(
      snapshot.routes.find((route) => route.sessionKey === 'cli:release-notes')?.transport,
      'remote',
      'polling-only peers remain discoverable when they do not advertise wake v1',
    );
    assert.deepEqual(resolveDesktopPeerAddress(snapshot.routes, 'cli:release', snapshot.ownSessionKey), { reason: 'ambiguous' });
    assert.deepEqual(resolveDesktopPeerAddress(snapshot.routes, 'desktop:active', snapshot.ownSessionKey), { reason: 'self_send' });
    assert.deepEqual(resolveDesktopPeerAddress(snapshot.routes, 'desktop:', snapshot.ownSessionKey), { reason: 'self_send' });
    const queued = await service.send('cli:release-check', 'Review the release evidence.');
    assert.equal(queued.ok, true);
    assert.equal(sentTarget, 'cli:release-check');
    assert.equal(queued.wording, 'Queued in the recipient’s local inbox; not yet applied.');
    await service.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Desktop retries a vanished preferred local route through its exact remote duplicate', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-desktop-local-crash-fallback-'));
  const target = 'cli:duplicate-route';
  let localMessageId = '';
  let remoteArgs: Record<string, unknown> | undefined;
  const service = new DesktopSessionMessaging({
    workspaceRoot: root,
    mcp: {
      getActiveBrainrouterServerId: () => 'brainrouter',
      callTool: async (name, args) => {
        if (name === 'session_register') return result({ session: { sessionKey: args.sessionKey } });
        if (name === 'session_list') return result({ sessions: [{
          sessionKey: target,
          deviceId: '22222222-2222-4222-8222-222222222222',
          clientKind: 'brainrouter-cli', state: 'idle', messageWakeVersion: 1,
          lastHeartbeatAt: new Date().toISOString(), metadata: {},
        }] });
        if (name === 'session_inbox_read') return result({ messages: [] });
        if (name === 'session_send') {
          remoteArgs = args;
          return result({
            messageId: args.messageId,
            accepted: 1,
            recipients: [{ sessionKey: target, status: 'pending', wake: 'poll-fallback' }],
          });
        }
        return result({ deleted: true, updated: true });
      },
    },
    getActiveAgent: () => ({ sessionKey: 'desktop:fallback-sender', getAccessMode: () => 'read' }),
    deliverPeer: () => ({ accepted: true, state: 'steered' }),
    confirmHeld: async () => null,
    pollIntervalMs: 60_000,
    local: {
      start: async (options) => fakeTransport(options.sessionKey, options.onMessageAvailable),
      discover: async () => [{
        sessionKey: target,
        deviceId: '11111111-1111-4111-8111-111111111111',
        clientKind: 'cli', state: 'idle', transport: 'local', lastSeenAt: Date.now(), instanceCount: 1,
      }],
      send: async (key, input) => {
        localMessageId = input.id!;
        return { queued: false, status: 'not_queued', transport: 'local', messageId: input.id!, targetSessionKey: key, reason: 'not_found' };
      },
      deviceId: () => '55555555-5555-4555-8555-555555555555',
    },
  });
  try {
    await service.start();
    const receipt = await service.send(target, 'Survive the local listener crash.');
    assert.equal(receipt.ok, true);
    assert.equal(receipt.transport, 'remote');
    assert.equal(receipt.status, 'pending');
    assert.equal(receipt.wake, 'poll-fallback');
    assert.equal(remoteArgs?.to, target);
    assert.equal(remoteArgs?.messageId, localMessageId, 'fallback preserves one logical send id');
    assert.match(receipt.wording, /Persisted.*not yet applied/i);
  } finally {
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Desktop remote send uses the exact authenticated envelope and reports persistence, wake, and tool failure truthfully', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-desktop-peers-remote-send-'));
  setSessionMeta(root, 'desktop:sender', { title: 'Desktop release sender', titleSource: 'human' });
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let sendAttempts = 0;
  const mcp: DesktopSessionMessagingMcp = {
    getActiveBrainrouterServerId: () => 'brainrouter',
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === 'session_register') return result({ session: { sessionKey: args.sessionKey } });
      if (name === 'session_list') return result({ sessions: [{
        sessionKey: 'cli:remote-target',
        deviceId: '99999999-9999-4999-8999-999999999999',
        clientKind: 'brainrouter-cli', state: 'idle', messageWakeVersion: 1,
        lastHeartbeatAt: new Date().toISOString(), metadata: {},
      }] });
      if (name === 'session_inbox_read') return result({ messages: [] });
      if (name === 'session_send') {
        sendAttempts += 1;
        if (sendAttempts === 2) return result({ error: 'ownership lost' }, true);
        return result({
          messageId: args.messageId,
          accepted: 1,
          recipients: [{
            sessionKey: 'cli:remote-target', inboxId: 'remote-inbox-1',
            status: 'pending', wake: 'pushed',
          }],
        });
      }
      return result({ deleted: true });
    },
  };
  try {
    const service = new DesktopSessionMessaging({
      workspaceRoot: root,
      mcp,
      getActiveAgent: () => ({ sessionKey: 'desktop:sender', getAccessMode: () => 'read' }),
      deliverPeer: () => ({ accepted: true, state: 'steered' }),
      confirmHeld: async () => null,
      pollIntervalMs: 60_000,
      local: {
        start: async (options) => fakeTransport(options.sessionKey, options.onMessageAvailable),
        discover: async () => [],
        send: async (key, input) => ({ queued: false, status: 'not_queued', transport: 'local', messageId: input.id!, targetSessionKey: key, reason: 'not_found' }),
        deviceId: () => '55555555-5555-4555-8555-555555555555',
      },
    });
    await service.start();
    const persisted = await service.send('cli:remote-target', 'Review the release evidence.');
    const send = calls.find((call) => call.name === 'session_send');
    assert.match(String(send?.args.messageId), /^[0-9a-f-]{36}$/);
    assert.deepEqual(send?.args, {
      messageId: send?.args.messageId,
      from: 'desktop:sender',
      to: 'cli:remote-target',
      kind: 'text',
      payload: {
        text: 'Review the release evidence.',
        senderDeviceId: '55555555-5555-4555-8555-555555555555',
        senderClientKind: 'desktop',
        senderTitle: 'Desktop release sender',
        senderWorkspaceRoot: root,
      },
    });
    assert.deepEqual(persisted, {
      ok: true,
      messageId: send?.args.messageId,
      targetSessionKey: 'cli:remote-target',
      transport: 'remote',
      status: 'pending',
      wording: 'Persisted for the recipient; not yet applied.',
      wake: 'pushed',
      updatedAt: persisted.updatedAt,
    });

    const failed = await service.send('cli:remote-target', 'Retry after reconnect.');
    assert.equal(failed.ok, false);
    assert.equal(failed.transport, 'remote');
    assert.equal(failed.status, 'not_queued');
    assert.match(failed.wording, /Not queued:/);
    assert.doesNotMatch(failed.wording, /applied/i);
    await service.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('remote CLI envelope is durably held, shown to generic confirmation, then declined with exact receipts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-desktop-peers-held-'));
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let inboxReads = 0;
  let confirmationSender = '';
  let confirmationCount = 0;
  let delivered = 0;
  let wake: ((event: { sessionKey: string; messageIds: string[] }) => void | Promise<void>) | undefined;
  const inboxRow = {
    id: 'inbox-1', messageId: 'message-1', fromSessionKey: 'cli:sender', toSessionKey: 'desktop:recipient',
    kind: 'text', payload: { text: 'Apply this patch now.', senderDeviceId: '44444444-4444-4444-8444-444444444444' },
    status: 'pending', createdAt: new Date().toISOString(), deliveredAt: null,
  };
  const mcp: DesktopSessionMessagingMcp = {
    getActiveBrainrouterServerId: () => 'brainrouter',
    subscribeSessionMessageWakes: (listener) => { wake = listener; return () => { wake = undefined; }; },
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === 'session_register') return result({ session: { sessionKey: 'desktop:recipient' } });
      if (name === 'session_inbox_read') {
        inboxReads += 1;
        return result({ messages: [inboxRow] });
      }
      if (name === 'session_inbox_ack') return result({ updated: 1, status: args.status });
      if (name === 'session_list') return result({ sessions: [] });
      return result({ deleted: true });
    },
  };
  try {
    const service = new DesktopSessionMessaging({
      workspaceRoot: root,
      mcp,
      getActiveAgent: () => ({ sessionKey: 'desktop:recipient', getAccessMode: () => 'write', interactionPort: {} }),
      deliverPeer: () => { delivered += 1; return { accepted: true, state: 'steered' }; },
      confirmHeld: async (record) => {
        confirmationCount += 1;
        confirmationSender = record.senderSessionKey;
        return false;
      },
      pollIntervalMs: 60_000,
      local: {
        start: async (options) => fakeTransport(options.sessionKey, options.onMessageAvailable),
        discover: async () => [],
        send: async (key, input) => ({ queued: true, status: 'queued', transport: 'local', messageId: input.id!, targetSessionKey: key, acceptedAt: Date.now(), pending: 1, duplicate: false }),
        deviceId: () => '55555555-5555-4555-8555-555555555555',
      },
    });
    await service.start();
    for (let index = 0; index < 20 && !confirmationSender; index += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(confirmationSender, 'cli:sender');
    assert.equal(delivered, 0);
    assert.deepEqual(
      calls.find((call) => call.name === 'session_inbox_read')?.args.statuses,
      ['pending', 'held'],
      'held remote rows remain pollable for crash recovery and safe-boundary acknowledgement',
    );
    assert.deepEqual(
      calls.filter((call) => call.name === 'session_inbox_ack').map((call) => call.args.status),
      ['held', 'declined'],
    );
    assert.equal(service.listHeld().some((message) => message.id === 'inbox-1' && message.status === 'rejected'), true);
    await wake?.({ sessionKey: 'desktop:recipient', messageIds: ['inbox-1'] });
    for (let index = 0; index < 20; index += 1) {
      if (calls.filter((call) => call.name === 'session_inbox_ack').length >= 3) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(confirmationCount, 1, 'a terminal decline replay never opens another approval prompt');
    assert.deepEqual(
      calls.filter((call) => call.name === 'session_inbox_ack').map((call) => call.args.status),
      ['held', 'declined', 'declined'],
    );
    await service.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Desktop preserves remote absolute expiry for near-deadline and delayed rows', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-desktop-remote-deadline-'));
  let clock = Date.now();
  const nearExpiry = clock + 60_000;
  const alreadyExpired = clock - 1;
  const transitions: Array<{ id: string; status: string }> = [];
  const prompted: string[] = [];
  let delivered = 0;
  const rows = [
    {
      id: 'desktop-near-expiry', fromSessionKey: 'cli:near', toSessionKey: 'desktop:deadline',
      kind: 'text', payload: {
        text: 'Keep the original deadline.',
        senderDeviceId: '11111111-1111-4111-8111-111111111111',
      },
      status: 'pending',
      createdAt: new Date(nearExpiry - HELD_SESSION_MESSAGE_MAX_AGE_MS).toISOString(),
      expiresAt: new Date(nearExpiry).toISOString(),
    },
    {
      id: 'desktop-already-expired', fromSessionKey: 'cli:late', toSessionKey: 'desktop:deadline',
      kind: 'text', payload: {
        text: 'Must never be applied.',
        senderDeviceId: '22222222-2222-4222-8222-222222222222',
      },
      status: 'pending',
      createdAt: new Date(alreadyExpired - HELD_SESSION_MESSAGE_MAX_AGE_MS).toISOString(),
      expiresAt: new Date(alreadyExpired).toISOString(),
    },
  ];
  const service = new DesktopSessionMessaging({
    workspaceRoot: root,
    mcp: {
      getActiveBrainrouterServerId: () => 'brainrouter',
      callTool: async (name, args) => {
        if (name === 'session_register') return result({ session: { sessionKey: 'desktop:deadline' } });
        if (name === 'session_inbox_read') return result({ messages: rows });
        if (name === 'session_inbox_ack') {
          transitions.push({
            id: String(Array.isArray(args.ids) ? args.ids[0] : ''),
            status: String(args.status),
          });
          return result({ updated: 1, status: args.status });
        }
        if (name === 'session_list') return result({ sessions: [] });
        return result({ deleted: true, updated: true });
      },
    },
    getActiveAgent: () => ({ sessionKey: 'desktop:deadline', getAccessMode: () => 'read' }),
    deliverPeer: () => { delivered += 1; return { accepted: true, state: 'steered' }; },
    confirmHeld: async (record) => { prompted.push(record.id); return null; },
    pollIntervalMs: 60_000,
    now: () => clock,
    local: {
      start: async (options) => fakeTransport(options.sessionKey, options.onMessageAvailable),
      discover: async () => [],
      send: async (key, input) => ({ queued: true, status: 'queued', transport: 'local', messageId: input.id!, targetSessionKey: key, acceptedAt: clock, pending: 1, duplicate: false }),
      deviceId: () => '55555555-5555-4555-8555-555555555555',
    },
  });
  try {
    await service.start();
    await waitUntil(() => transitions.some((entry) => entry.id === 'desktop-near-expiry' && entry.status === 'held') &&
      transitions.some((entry) => entry.id === 'desktop-already-expired' && entry.status === 'expired'));

    const near = service.listHeld().find((message) => message.id === 'desktop-near-expiry');
    assert.equal(near?.expiresAt, nearExpiry, 'Desktop must not restart the Brain-owned TTL at poll time');
    assert.deepEqual(prompted, ['desktop-near-expiry']);
    assert.equal(delivered, 0);

    clock = nearExpiry + 1;
    const expired = service.listHeld().find((message) => message.id === 'desktop-near-expiry');
    assert.equal(expired?.status, 'expired');
    await waitUntil(() => transitions.some((entry) => entry.id === 'desktop-near-expiry' && entry.status === 'expired'));
    assert.equal(transitions.some((entry) => entry.status === 'applied'), false);
  } finally {
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('full Desktop held queue reports queue_full remotely and surfaces a local capacity notice', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-desktop-held-capacity-'));
  const recipientKey = 'desktop:capacity-recipient';
  const now = Date.now();
  writeJsonFile(getStateFile(root, 'heldSessionMessages.json'), {
    schemaVersion: 1,
    records: Array.from({ length: HELD_SESSION_MESSAGE_MAX_RECORDS }, (_, index) => ({
      id: `capacity-${index}`,
      senderSessionKey: 'cli:capacity-sender',
      senderDeviceId: '11111111-1111-4111-8111-111111111111',
      targetSessionKey: recipientKey,
      text: `terminal ${index}`,
      source: 'peer-session' as const,
      trust: 'untrusted-session' as const,
      createdAt: now - 1,
      receivedAt: now,
      status: 'rejected' as const,
      expiresAt: now + HELD_SESSION_MESSAGE_MAX_AGE_MS,
      holdReason: 'Prior terminal refusal.',
      decidedAt: now,
      terminalReceiptStatus: 'rejected' as const,
    })),
  });
  const acknowledgements: string[] = [];
  const notices: string[] = [];
  let localHandle: LocalSessionTransportHandle | undefined;
  const remoteRow = {
    id: 'remote-capacity-overflow', messageId: 'remote-capacity-overflow',
    fromSessionKey: 'cli:remote-capacity', toSessionKey: recipientKey,
    kind: 'text', payload: {
      text: 'Remote overflow.', senderDeviceId: '22222222-2222-4222-8222-222222222222',
    },
    status: 'pending', createdAt: new Date(now).toISOString(),
  };
  const service = new DesktopSessionMessaging({
    workspaceRoot: root,
    mcp: {
      getActiveBrainrouterServerId: () => 'brainrouter',
      callTool: async (name, args) => {
        if (name === 'session_register') return result({ session: { sessionKey: args.sessionKey } });
        if (name === 'session_list') return result({ sessions: [] });
        if (name === 'session_inbox_read') return result({ messages: [remoteRow] });
        if (name === 'session_inbox_ack') {
          acknowledgements.push(String(args.status));
          return result({ updated: 1, status: args.status });
        }
        return result({ deleted: true, updated: true });
      },
    },
    getActiveAgent: () => ({ sessionKey: recipientKey, getAccessMode: () => 'read' }),
    deliverPeer: () => { throw new Error('capacity refusal must not reach the Agent'); },
    confirmHeld: async () => { throw new Error('capacity refusal must not prompt'); },
    onNotice: (_sessionKey, message) => notices.push(message),
    pollIntervalMs: 60_000,
    local: {
      start: async (options) => {
        localHandle = fakeTransport(options.sessionKey, options.onMessageAvailable);
        return localHandle;
      },
      discover: async () => [],
      send: async (key, input) => ({ queued: true, status: 'queued', transport: 'local', messageId: input.id!, targetSessionKey: key, acceptedAt: now, pending: 1, duplicate: false }),
      deviceId: () => '33333333-3333-4333-8333-333333333333',
    },
  });
  try {
    await service.start();
    await waitUntil(() => acknowledgements.includes('queue_full'));

    localHandle!.acceptPeerMessage({
      id: 'local-capacity-overflow',
      senderSessionKey: 'cli:local-capacity',
      senderDeviceId: '44444444-4444-4444-8444-444444444444',
      targetSessionKey: recipientKey,
      text: 'Local overflow.',
      createdAt: now,
    });
    await waitUntil(() => notices.some((notice) => /local-capacity-overflow.*full/i.test(notice)));
    assert.equal(acknowledgements.includes('rejected'), false);
  } finally {
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('held approval preserves sender provenance and becomes applied only after the safe-boundary callback', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-desktop-peers-approved-'));
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let inboxReads = 0;
  let deliveredSender: PeerSessionSender | undefined;
  let settleConfirmation!: (approved: boolean | null) => void;
  const confirmationResponse = new Promise<boolean | null>((resolve) => { settleConfirmation = resolve; });
  let confirmationResolutions = 0;
  const mcp: DesktopSessionMessagingMcp = {
    getActiveBrainrouterServerId: () => 'brainrouter',
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === 'session_register') return result({ session: { sessionKey: 'desktop:recipient' } });
      if (name === 'session_inbox_read') {
        inboxReads += 1;
        return result({ messages: inboxReads === 1 ? [{
          id: 'inbox-approved-1', fromSessionKey: 'cli:sender', toSessionKey: 'desktop:recipient',
          kind: 'text', payload: {
            text: 'Use the attached verification context.',
            senderDeviceId: '66666666-6666-4666-8666-666666666666',
            senderClientKind: 'brainrouter-cli',
            senderTitle: 'Release verifier',
            senderWorkspaceRoot: '/repos/release',
          },
          status: 'pending', createdAt: new Date().toISOString(),
        }] : [] });
      }
      if (name === 'session_inbox_ack') return result({ updated: 1, status: args.status });
      if (name === 'session_list') return result({ sessions: [] });
      return result({ deleted: true });
    },
  };
  try {
    const service = new DesktopSessionMessaging({
      workspaceRoot: root,
      mcp,
      getActiveAgent: () => ({ sessionKey: 'desktop:recipient', getAccessMode: () => 'write', interactionPort: {} }),
      deliverPeer: (_message, sender) => {
        deliveredSender = sender;
        return { accepted: true, state: 'steered' };
      },
      confirmHeld: () => ({
        interactionId: 'ir-held-approved',
        response: confirmationResponse,
        resolve: (approved) => {
          confirmationResolutions += 1;
          settleConfirmation(approved);
          return true;
        },
      }),
      pollIntervalMs: 60_000,
      local: {
        start: async (options) => fakeTransport(options.sessionKey, options.onMessageAvailable),
        discover: async () => [],
        send: async (key, input) => ({ queued: true, status: 'queued', transport: 'local', messageId: input.id!, targetSessionKey: key, acceptedAt: Date.now(), pending: 1, duplicate: false }),
        deviceId: () => '55555555-5555-4555-8555-555555555555',
      },
    });
    await service.start();
    for (let index = 0; index < 20; index += 1) {
      if (service.listHeld().some((row) => row.interactionId === 'ir-held-approved')) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(service.listHeld().find((row) => row.id === 'inbox-approved-1')?.interactionId, 'ir-held-approved');
    await service.decideHeld('inbox-approved-1', true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(confirmationResolutions, 1, 'panel decision settles the active generic confirmation');
    assert.equal(deliveredSender === undefined, false);
    assert.equal(deliveredSender?.sessionKey, 'cli:sender');
    assert.equal(deliveredSender?.deviceId, '66666666-6666-4666-8666-666666666666');
    assert.equal(deliveredSender?.clientKind, 'cli');
    assert.equal(deliveredSender?.title, 'Release verifier');
    assert.equal(deliveredSender?.workspaceRoot, '/repos/release');
    assert.equal(deliveredSender?.transport, 'remote');
    assert.equal(typeof deliveredSender?.sentAt, 'number');
    assert.equal(
      calls.filter((call) => call.name === 'session_inbox_ack' && call.args.status === 'held').length,
      1,
      'the generic prompt path does not duplicate the panel decision',
    );
    assert.deepEqual(
      calls.filter((call) => call.name === 'session_inbox_ack').map((call) => call.args.status),
      ['held'],
      'approval is durable but is not yet an application receipt',
    );
    service.onPeerApplied('desktop:recipient', 'inbox-approved-1');
    for (let index = 0; index < 20; index += 1) {
      if (calls.some((call) => call.name === 'session_inbox_ack' && call.args.status === 'applied')) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(
      calls.filter((call) => call.name === 'session_inbox_ack').map((call) => call.args.status),
      ['held', 'applied'],
    );
    await service.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dismissed generic confirmation leaves the durable message held', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-desktop-peers-dismissed-'));
  const acknowledgements: unknown[] = [];
  let inboxReads = 0;
  const mcp: DesktopSessionMessagingMcp = {
    getActiveBrainrouterServerId: () => 'brainrouter',
    callTool: async (name, args) => {
      if (name === 'session_register') return result({ session: { sessionKey: 'desktop:recipient' } });
      if (name === 'session_inbox_read') {
        inboxReads += 1;
        return result({ messages: inboxReads === 1 ? [{
          id: 'inbox-dismissed-1', fromSessionKey: 'cli:sender', toSessionKey: 'desktop:recipient',
          kind: 'text', payload: { text: 'Please consider this later.', senderDeviceId: '77777777-7777-4777-8777-777777777777' },
          status: 'pending', createdAt: new Date().toISOString(),
        }] : [] });
      }
      if (name === 'session_inbox_ack') {
        acknowledgements.push(args.status);
        return result({ updated: 1 });
      }
      if (name === 'session_list') return result({ sessions: [] });
      return result({ deleted: true });
    },
  };
  try {
    const service = new DesktopSessionMessaging({
      workspaceRoot: root,
      mcp,
      getActiveAgent: () => ({ sessionKey: 'desktop:recipient', getAccessMode: () => 'write', interactionPort: {} }),
      deliverPeer: () => ({ accepted: true, state: 'steered' }),
      confirmHeld: async () => null,
      pollIntervalMs: 60_000,
      local: {
        start: async (options) => fakeTransport(options.sessionKey, options.onMessageAvailable),
        discover: async () => [],
        send: async (key, input) => ({ queued: true, status: 'queued', transport: 'local', messageId: input.id!, targetSessionKey: key, acceptedAt: Date.now(), pending: 1, duplicate: false }),
        deviceId: () => '55555555-5555-4555-8555-555555555555',
      },
    });
    await service.start();
    for (let index = 0; index < 20; index += 1) {
      if (service.listHeld().some((row) => row.id === 'inbox-dismissed-1')) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(service.listHeld().find((row) => row.id === 'inbox-dismissed-1')?.status, 'held');
    assert.deepEqual(acknowledgements, ['held']);
    await service.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('delayed Desktop approval and decline acknowledge expired and never deliver', async () => {
  for (const approved of [true, false]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `br-desktop-delayed-${approved ? 'yes' : 'no'}-`));
    const recipientKey = `desktop:delayed-${approved ? 'yes' : 'no'}`;
    const receivedAt = Date.now();
    let clock = receivedAt;
    let settle!: (value: boolean | null) => void;
    let promptStarted = false;
    let deliveries = 0;
    const acknowledgements: string[] = [];
    const row = {
      id: `delayed-${approved ? 'yes' : 'no'}`,
      messageId: `delayed-${approved ? 'yes' : 'no'}`,
      fromSessionKey: 'cli:delayed-sender', toSessionKey: recipientKey,
      kind: 'text', payload: {
        text: 'This decision will arrive after expiry.',
        senderDeviceId: '77777777-7777-4777-8777-777777777777',
      },
      status: 'pending', createdAt: new Date(receivedAt).toISOString(),
    };
    const service = new DesktopSessionMessaging({
      workspaceRoot: root,
      now: () => clock,
      mcp: {
        getActiveBrainrouterServerId: () => 'brainrouter',
        callTool: async (name, args) => {
          if (name === 'session_register') return result({ session: { sessionKey: args.sessionKey } });
          if (name === 'session_list') return result({ sessions: [] });
          if (name === 'session_inbox_read') return result({ messages: [row] });
          if (name === 'session_inbox_ack') {
            acknowledgements.push(String(args.status));
            return result({ updated: 1, status: args.status });
          }
          return result({ deleted: true, updated: true });
        },
      },
      getActiveAgent: () => ({ sessionKey: recipientKey, getAccessMode: () => 'read' }),
      deliverPeer: () => { deliveries += 1; return { accepted: true, state: 'steered' }; },
      confirmHeld: () => new Promise<boolean | null>((resolve) => {
        promptStarted = true;
        settle = resolve;
      }),
      pollIntervalMs: 60_000,
      local: {
        start: async (options) => fakeTransport(options.sessionKey, options.onMessageAvailable),
        discover: async () => [],
        send: async (key, input) => ({ queued: true, status: 'queued', transport: 'local', messageId: input.id!, targetSessionKey: key, acceptedAt: clock, pending: 1, duplicate: false }),
        deviceId: () => '88888888-8888-4888-8888-888888888888',
      },
    });
    try {
      await service.start();
      await waitUntil(() => promptStarted);
      clock = receivedAt + HELD_SESSION_MESSAGE_MAX_AGE_MS + 1;
      settle(approved);
      await waitUntil(() => acknowledgements.includes('expired'));

      assert.equal(acknowledgements.includes('declined'), false);
      assert.equal(acknowledgements.includes('rejected'), false);
      assert.equal(deliveries, 0);
      assert.equal(service.listHeld().find((message) => message.id === row.id)?.status, 'expired');
    } finally {
      settle?.(null);
      await service.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('legacy remote rows use the same deterministic valid device UUID for discovery and admission', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-desktop-peers-legacy-'));
  let admittedDeviceId = '';
  let inboxReads = 0;
  const mcp: DesktopSessionMessagingMcp = {
    getActiveBrainrouterServerId: () => 'brainrouter',
    callTool: async (name) => {
      if (name === 'session_register') return result({ session: { sessionKey: 'desktop:recipient' } });
      if (name === 'session_list') return result({ sessions: [{
        sessionKey: 'cli:legacy', clientKind: 'brainrouter-cli', state: 'idle',
        messageWakeVersion: 1, lastHeartbeatAt: new Date().toISOString(), metadata: {},
      }] });
      if (name === 'session_inbox_read') {
        inboxReads += 1;
        return result({ messages: inboxReads === 1 ? [{
          id: 'legacy-inbox-1', fromSessionKey: 'cli:legacy', toSessionKey: 'desktop:recipient',
          kind: 'text', payload: { text: 'Legacy peer message.' }, status: 'pending',
          createdAt: new Date().toISOString(),
        }] : [] });
      }
      if (name === 'session_inbox_ack') return result({ updated: 1 });
      return result({ deleted: true });
    },
  };
  try {
    const service = new DesktopSessionMessaging({
      workspaceRoot: root,
      mcp,
      getActiveAgent: () => ({
        sessionKey: 'desktop:recipient',
        getAccessMode: () => 'read',
        getSessionMessageRecipientAuthority: () => ({
          workspaceFiles: 'denied', shell: 'denied', computerUse: 'denied',
          externalWrites: 'confirm', remoteTools: 'confirm',
        }),
      }),
      deliverPeer: (message) => {
        admittedDeviceId = message.senderDeviceId;
        return { accepted: true, state: 'steered' };
      },
      confirmHeld: async () => false,
      pollIntervalMs: 60_000,
      local: {
        start: async (options) => fakeTransport(options.sessionKey, options.onMessageAvailable),
        discover: async () => [],
        send: async (key, input) => ({ queued: true, status: 'queued', transport: 'local', messageId: input.id!, targetSessionKey: key, acceptedAt: Date.now(), pending: 1, duplicate: false }),
        deviceId: () => '55555555-5555-4555-8555-555555555555',
      },
    });
    await service.start();
    for (let index = 0; index < 20 && !admittedDeviceId; index += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    const routeDeviceId = (await service.listPeers()).routes.find((route) => route.sessionKey === 'cli:legacy')?.deviceId;
    assert.match(admittedDeviceId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(routeDeviceId, admittedDeviceId, 'legacy route and envelope share a stable compatibility identity');
    await service.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('duplicate remote poll stays pending until Core reports safe-boundary application', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-desktop-peers-replay-'));
  const acknowledgements: unknown[] = [];
  let deliveries = 0;
  let wake: ((event: { sessionKey: string; messageIds: string[] }) => void | Promise<void>) | undefined;
  const row = {
    id: 'inbox-replay-1', fromSessionKey: 'cli:sender', toSessionKey: 'desktop:recipient',
    kind: 'text', payload: { text: 'One durable observation.', senderDeviceId: '88888888-8888-4888-8888-888888888888' },
    status: 'pending', createdAt: new Date().toISOString(),
  };
  const mcp: DesktopSessionMessagingMcp = {
    getActiveBrainrouterServerId: () => 'brainrouter',
    subscribeSessionMessageWakes: (listener) => { wake = listener; return () => { wake = undefined; }; },
    callTool: async (name, args) => {
      if (name === 'session_register') return result({ session: { sessionKey: 'desktop:recipient' } });
      if (name === 'session_inbox_read') return result({ messages: [row] });
      if (name === 'session_inbox_ack') {
        acknowledgements.push(args.status);
        return result({ updated: 1 });
      }
      if (name === 'session_list') return result({ sessions: [] });
      return result({ deleted: true });
    },
  };
  try {
    const service = new DesktopSessionMessaging({
      workspaceRoot: root,
      mcp,
      getActiveAgent: () => ({
        sessionKey: 'desktop:recipient',
        getAccessMode: () => 'read',
        getSessionMessageRecipientAuthority: () => ({
          workspaceFiles: 'denied', shell: 'denied', computerUse: 'denied',
          externalWrites: 'confirm', remoteTools: 'confirm',
        }),
      }),
      deliverPeer: () => { deliveries += 1; return { accepted: true, state: 'steered' }; },
      confirmHeld: async () => false,
      pollIntervalMs: 60_000,
      local: {
        start: async (options) => fakeTransport(options.sessionKey, options.onMessageAvailable),
        discover: async () => [],
        send: async (key, input) => ({ queued: true, status: 'queued', transport: 'local', messageId: input.id!, targetSessionKey: key, acceptedAt: Date.now(), pending: 1, duplicate: false }),
        deviceId: () => '55555555-5555-4555-8555-555555555555',
      },
    });
    await service.start();
    for (let index = 0; index < 20 && deliveries === 0; index += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    await wake?.({ sessionKey: 'desktop:recipient', messageIds: ['inbox-replay-1'] });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(deliveries, 1, 'mailbox duplicate is not enqueued twice');
    assert.deepEqual(acknowledgements, [], 'duplicate persistence is not mislabeled as application');
    service.onPeerApplied('desktop:recipient', 'inbox-replay-1');
    for (let index = 0; index < 20 && acknowledgements.length === 0; index += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(acknowledgements, ['applied']);
    await service.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Core safe-boundary expiry publishes only expired and clears the remote delivery identity', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-desktop-boundary-expiry-'));
  const acknowledgements: string[] = [];
  let deliveries = 0;
  let wake: ((event: { sessionKey: string; messageIds: string[] }) => void | Promise<void>) | undefined;
  const createdAt = Date.now();
  const row = {
    id: 'inbox-boundary-expiry', fromSessionKey: 'cli:sender', toSessionKey: 'desktop:recipient',
    kind: 'text', payload: {
      text: 'Approved now, expired at the later safe boundary.',
      senderDeviceId: '88888888-8888-4888-8888-888888888888',
    },
    status: 'pending', createdAt: new Date(createdAt).toISOString(),
  };
  const service = new DesktopSessionMessaging({
    workspaceRoot: root,
    mcp: {
      getActiveBrainrouterServerId: () => 'brainrouter',
      subscribeSessionMessageWakes: (listener) => { wake = listener; return () => { wake = undefined; }; },
      callTool: async (name, args) => {
        if (name === 'session_register') return result({ session: { sessionKey: 'desktop:recipient' } });
        if (name === 'session_inbox_read') return result({ messages: [row] });
        if (name === 'session_inbox_ack') {
          acknowledgements.push(String(args.status));
          return result({ updated: 1 });
        }
        if (name === 'session_list') return result({ sessions: [] });
        return result({ deleted: true, updated: true });
      },
    },
    getActiveAgent: () => ({ sessionKey: 'desktop:recipient', getAccessMode: () => 'write' }),
    deliverPeer: () => { deliveries += 1; return { accepted: true, state: 'steered' }; },
    confirmHeld: async () => true,
    pollIntervalMs: 60_000,
    local: {
      start: async (options) => fakeTransport(options.sessionKey, options.onMessageAvailable),
      discover: async () => [],
      send: async (key, input) => ({ queued: true, status: 'queued', transport: 'local', messageId: input.id!, targetSessionKey: key, acceptedAt: Date.now(), pending: 1, duplicate: false }),
      deviceId: () => '55555555-5555-4555-8555-555555555555',
    },
  });
  try {
    await service.start();
    await waitUntil(() => deliveries === 1);
    const approved = service.listHeld().find((message) => message.id === row.id);
    assert.ok(approved, 'the approved row remains durable until the safe boundary');
    expireHeldSessionMessages(root, approved.expiresAt + 1);
    service.onPeerExpired('desktop:recipient', row.id);
    await waitUntil(() => acknowledgements.includes('expired'));

    assert.equal(acknowledgements.includes('applied'), false);
    assert.equal(acknowledgements.includes('declined'), false);
    assert.equal(service.listHeld().find((message) => message.id === row.id)?.status, 'expired');
    await wake?.({ sessionKey: 'desktop:recipient', messageIds: [row.id] });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(deliveries, 1, 'terminal expiry replay never re-enters the Agent queue');
  } finally {
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('approved remote replay survives transient queue failure and later applies without a rejected receipt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-desktop-approved-retry-'));
  const acknowledgements: string[] = [];
  let deliveries = 0;
  let confirmations = 0;
  let wake: ((event: { sessionKey: string; messageIds: string[] }) => void | Promise<void>) | undefined;
  const row = {
    id: 'inbox-approved-retry-1', fromSessionKey: 'cli:sender', toSessionKey: 'desktop:recipient',
    kind: 'text', payload: {
      text: 'Retry this approved observation.',
      senderDeviceId: '77777777-7777-4777-8777-777777777777',
    },
    status: 'pending', createdAt: new Date().toISOString(),
  };
  const mcp: DesktopSessionMessagingMcp = {
    getActiveBrainrouterServerId: () => 'brainrouter',
    subscribeSessionMessageWakes: (listener) => { wake = listener; return () => { wake = undefined; }; },
    callTool: async (name, args) => {
      if (name === 'session_register') return result({ session: { sessionKey: 'desktop:recipient' } });
      if (name === 'session_inbox_read') return result({ messages: [row] });
      if (name === 'session_inbox_ack') {
        acknowledgements.push(String(args.status));
        return result({ updated: 1 });
      }
      if (name === 'session_list') return result({ sessions: [] });
      return result({ deleted: true });
    },
  };
  try {
    const service = new DesktopSessionMessaging({
      workspaceRoot: root,
      mcp,
      getActiveAgent: () => ({ sessionKey: 'desktop:recipient', getAccessMode: () => 'write' }),
      deliverPeer: () => {
        deliveries += 1;
        return deliveries === 1
          ? { accepted: false, state: 'queue_full', reason: 'Steering queue is full.' }
          : { accepted: true, state: 'steered' };
      },
      confirmHeld: async () => { confirmations += 1; return true; },
      pollIntervalMs: 60_000,
      local: {
        start: async (options) => fakeTransport(options.sessionKey, options.onMessageAvailable),
        discover: async () => [],
        send: async (key, input) => ({ queued: true, status: 'queued', transport: 'local', messageId: input.id!, targetSessionKey: key, acceptedAt: Date.now(), pending: 1, duplicate: false }),
        deviceId: () => '55555555-5555-4555-8555-555555555555',
      },
    });
    await service.start();
    await waitUntil(() => deliveries === 1);
    assert.equal(service.listHeld().find((message) => message.id === row.id)?.status, 'approved');
    assert.equal(confirmations, 1);
    assert.equal(acknowledgements.some((status) => ['rejected', 'declined', 'expired'].includes(status)), false);

    await wake?.({ sessionKey: 'desktop:recipient', messageIds: [row.id] });
    await waitUntil(() => deliveries === 2);
    assert.equal(confirmations, 1, 'approved replay retries without prompting again');
    assert.equal(acknowledgements.some((status) => ['rejected', 'declined', 'expired'].includes(status)), false);

    service.onPeerApplied('desktop:recipient', row.id);
    await waitUntil(() => acknowledgements.includes('applied'));
    assert.equal(acknowledgements.at(-1), 'applied');
    await service.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('remote acknowledgement retries tool errors and verifies an idempotent zero update by exact inbox row', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-desktop-peers-ack-retry-'));
  const senderRoute = {
    sessionKey: 'cli:pinned-sender',
    deviceId: '99999999-9999-4999-8999-999999999999',
    clientKind: 'brainrouter-cli',
    state: 'idle',
    lastHeartbeatAt: new Date().toISOString(),
    workspaceRoot: '/trusted/pinned-workspace',
    title: 'Pinned registration title',
    metadata: {},
  };
  const row = {
    id: 'inbox-ack-retry-1',
    fromSessionKey: senderRoute.sessionKey,
    toSessionKey: 'desktop:ack-recipient',
    kind: 'text',
    payload: {
      text: 'Apply once, then retry only the receipt.',
      senderDeviceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      senderClientKind: 'electron-desktop',
      senderTitle: 'Untrusted payload title',
      senderWorkspaceRoot: '/untrusted/payload-workspace',
    },
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  let wake: ((event: { sessionKey: string; messageIds: string[] }) => void | Promise<void>) | undefined;
  let ackAttempts = 0;
  let readbacks = 0;
  let deliveries = 0;
  let deliveredSender: PeerSessionSender | undefined;
  const readbackArgs: Record<string, unknown>[] = [];
  const mcp: DesktopSessionMessagingMcp = {
    getActiveBrainrouterServerId: () => 'brainrouter',
    subscribeSessionMessageWakes: (listener) => { wake = listener; return () => { wake = undefined; }; },
    callTool: async (name, args) => {
      if (name === 'session_register') return result({ session: { sessionKey: 'desktop:ack-recipient' } });
      if (name === 'session_list') return result({ sessions: [senderRoute] });
      if (name === 'session_inbox_read') {
        if (Array.isArray(args.statuses) && args.statuses[0] === 'applied') {
          readbackArgs.push(args);
          readbacks += 1;
          return result({ messages: readbacks === 1 ? [] : [{ id: row.id, status: 'applied' }] });
        }
        return result({ messages: [row] });
      }
      if (name === 'session_inbox_ack') {
        ackAttempts += 1;
        if (ackAttempts === 1) return result({ message: 'temporary structured failure' }, true);
        return result({ updated: 0 });
      }
      return result({ deleted: true });
    },
  };
  try {
    const service = new DesktopSessionMessaging({
      workspaceRoot: root,
      mcp,
      getActiveAgent: () => ({
        sessionKey: 'desktop:ack-recipient',
        getAccessMode: () => 'read',
        getSessionMessageRecipientAuthority: () => ({
          workspaceFiles: 'denied', shell: 'denied', computerUse: 'denied',
          externalWrites: 'confirm', remoteTools: 'confirm',
        }),
      }),
      deliverPeer: (_message, sender) => {
        deliveries += 1;
        deliveredSender = sender;
        return { accepted: true, state: 'steered' };
      },
      confirmHeld: async () => false,
      pollIntervalMs: 60_000,
      local: {
        start: async (options) => fakeTransport(options.sessionKey, options.onMessageAvailable),
        discover: async () => [],
        send: async (key, input) => ({ queued: true, status: 'queued', transport: 'local', messageId: input.id!, targetSessionKey: key, acceptedAt: Date.now(), pending: 1, duplicate: false }),
        deviceId: () => '55555555-5555-4555-8555-555555555555',
      },
    });
    await service.start();
    for (let index = 0; index < 20 && deliveries === 0; index += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(deliveries, 1);
    assert.equal(deliveredSender?.deviceId, senderRoute.deviceId, 'pinned registration identity wins over inbox payload');
    assert.equal(deliveredSender?.clientKind, 'cli');
    assert.equal(deliveredSender?.title, senderRoute.title);
    assert.equal(deliveredSender?.workspaceRoot, senderRoute.workspaceRoot);

    service.onPeerApplied('desktop:ack-recipient', row.id);
    for (let index = 0; index < 20 && ackAttempts < 1; index += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(ackAttempts, 1, 'structured tool errors are not accepted as acknowledgement success');

    wake?.({ sessionKey: 'desktop:ack-recipient', messageIds: [row.id] });
    for (let index = 0; index < 20 && ackAttempts < 2; index += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(ackAttempts, 2);
    assert.equal(readbacks, 1, 'zero updated rows require a durable status readback');

    wake?.({ sessionKey: 'desktop:ack-recipient', messageIds: [row.id] });
    for (let index = 0; index < 20 && ackAttempts < 3; index += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(ackAttempts, 3);
    assert.equal(readbacks, 2);
    assert.equal(readbackArgs.every((args) => args.includeDelivered === true), true);
    assert.equal(readbackArgs.every((args) => JSON.stringify(args.statuses) === '["applied"]'), true);

    wake?.({ sessionKey: 'desktop:ack-recipient', messageIds: [row.id] });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(ackAttempts, 3, 'verified terminal acknowledgement clears retry state');
    assert.equal(deliveries, 1, 'receipt retries never replay model input');
    await service.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a delayed remote poll cannot deliver into a newly activated Desktop session', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-desktop-peers-switch-race-'));
  const delayedRead = deferred<unknown>();
  const registered: string[] = [];
  const unregistered: string[] = [];
  const started: string[] = [];
  let delayNextRead = false;
  let delayedReadStarted = false;
  let wake: ((event: { sessionKey: string; messageIds: string[] }) => void | Promise<void>) | undefined;
  let deliveries = 0;
  const mcp: DesktopSessionMessagingMcp = {
    getActiveBrainrouterServerId: () => 'brainrouter',
    subscribeSessionMessageWakes: (listener) => { wake = listener; return () => { wake = undefined; }; },
    callTool: async (name, args) => {
      if (name === 'session_register') {
        const key = String(args.sessionKey);
        registered.push(key);
        return result({ session: { sessionKey: key } });
      }
      if (name === 'session_unregister') {
        unregistered.push(String(args.sessionKey));
        return result({ deleted: true });
      }
      if (name === 'session_list') return result({ sessions: [] });
      if (name === 'session_inbox_read') {
        if (delayNextRead) {
          delayNextRead = false;
          delayedReadStarted = true;
          return delayedRead.promise;
        }
        return result({ messages: [] });
      }
      return result({ updated: 1 });
    },
  };
  try {
    const agentA = { sessionKey: 'desktop:race-a', getAccessMode: () => 'read' as const };
    const agentB = { sessionKey: 'desktop:race-b', getAccessMode: () => 'read' as const };
    const service = new DesktopSessionMessaging({
      workspaceRoot: root,
      mcp,
      getActiveAgent: () => agentA,
      deliverPeer: () => { deliveries += 1; return { accepted: true, state: 'steered' }; },
      confirmHeld: async () => false,
      pollIntervalMs: 60_000,
      local: {
        start: async (options) => {
          started.push(options.sessionKey);
          return fakeTransport(options.sessionKey, options.onMessageAvailable);
        },
        discover: async () => [],
        send: async (key, input) => ({ queued: true, status: 'queued', transport: 'local', messageId: input.id!, targetSessionKey: key, acceptedAt: Date.now(), pending: 1, duplicate: false }),
        deviceId: () => '55555555-5555-4555-8555-555555555555',
      },
    });
    await service.start();
    delayNextRead = true;
    wake?.({ sessionKey: agentA.sessionKey, messageIds: ['stale-row'] });
    for (let index = 0; index < 20 && !delayedReadStarted; index += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(delayedReadStarted, true);
    const activation = service.activate(agentB);
    delayedRead.resolve(result({ messages: [{
      id: 'stale-row', fromSessionKey: 'cli:sender', toSessionKey: agentA.sessionKey,
      kind: 'text', payload: { text: 'Must stay with A.' }, status: 'pending', createdAt: new Date().toISOString(),
    }] }));
    await activation;
    assert.deepEqual(started, [agentA.sessionKey, agentB.sessionKey]);
    assert.deepEqual(registered, [agentA.sessionKey, agentB.sessionKey]);
    assert.equal(unregistered.includes(agentA.sessionKey), true);
    assert.equal(deliveries, 0, 'stale MCP work is discarded after the generation changes');
    assert.equal((await service.listPeers()).ownSessionKey, agentB.sessionKey);
    await service.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('close waits for an in-flight remote poll before unregistering the captured participant', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-desktop-peers-close-race-'));
  const delayedRead = deferred<unknown>();
  const operations: string[] = [];
  let delayNextRead = false;
  let delayedReadStarted = false;
  let wake: ((event: { sessionKey: string; messageIds: string[] }) => void | Promise<void>) | undefined;
  let deliveries = 0;
  const mcp: DesktopSessionMessagingMcp = {
    getActiveBrainrouterServerId: () => 'brainrouter',
    subscribeSessionMessageWakes: (listener) => { wake = listener; return () => { wake = undefined; }; },
    callTool: async (name, args) => {
      operations.push(`${name}:${String(args.sessionKey ?? '')}`);
      if (name === 'session_register') return result({ session: { sessionKey: String(args.sessionKey) } });
      if (name === 'session_unregister') return result({ deleted: true });
      if (name === 'session_list') return result({ sessions: [] });
      if (name === 'session_inbox_read') {
        if (delayNextRead) {
          delayNextRead = false;
          delayedReadStarted = true;
          return delayedRead.promise;
        }
        return result({ messages: [] });
      }
      return result({ updated: 1 });
    },
  };
  try {
    const sessionKey = 'desktop:close-race';
    const service = new DesktopSessionMessaging({
      workspaceRoot: root,
      mcp,
      getActiveAgent: () => ({ sessionKey, getAccessMode: () => 'read' }),
      deliverPeer: () => { deliveries += 1; return { accepted: true, state: 'steered' }; },
      confirmHeld: async () => false,
      pollIntervalMs: 60_000,
      local: {
        start: async (options) => fakeTransport(options.sessionKey, options.onMessageAvailable),
        discover: async () => [],
        send: async (key, input) => ({ queued: true, status: 'queued', transport: 'local', messageId: input.id!, targetSessionKey: key, acceptedAt: Date.now(), pending: 1, duplicate: false }),
        deviceId: () => '55555555-5555-4555-8555-555555555555',
      },
    });
    await service.start();
    delayNextRead = true;
    wake?.({ sessionKey, messageIds: ['late-row'] });
    for (let index = 0; index < 20 && !delayedReadStarted; index += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(delayedReadStarted, true);
    const closing = service.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(operations.some((operation) => operation.startsWith('session_unregister:')), false);
    delayedRead.resolve(result({ messages: [{
      id: 'late-row', fromSessionKey: 'cli:sender', toSessionKey: sessionKey,
      kind: 'text', payload: { text: 'Must not outlive close.' }, status: 'pending', createdAt: new Date().toISOString(),
    }] }));
    await closing;
    assert.equal(deliveries, 0);
    assert.equal(operations.at(-1), `session_unregister:${sessionKey}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('receipt wording distinguishes persistence, hold, and safe-boundary application', () => {
  assert.equal(desktopPeerReceiptWording('pending', 'remote'), 'Persisted for the recipient; not yet applied.');
  assert.equal(desktopPeerReceiptWording('held', 'remote'), 'Held by the recipient for human approval.');
  assert.equal(desktopPeerReceiptWording('applied', 'remote'), 'Applied by the recipient at a safe boundary.');
  assert.equal(desktopPeerReceiptWording('expired', 'remote'),
    'Expired without a durable application acknowledgement.');
});
