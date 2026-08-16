/**
 * Production CLI federation lifecycle regressions. They exercise exact-key
 * registration, delivery, receipt, rebind, and shutdown seams; no test may
 * treat persistence as application or renew a remote message deadline.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  LocalSessionMessage,
  LocalSessionTransportHandle,
} from '@kinqs/brainrouter-core/session';
import { attachFederation } from '../runtime/federation/federationRegistration.js';

const ORIGINAL_HOME = process.env.BRAINROUTER_HOME;
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-federation-'));
const REMOTE_DEVICE = '11111111-1111-4111-8111-111111111111';
process.env.BRAINROUTER_HOME = TEST_HOME;
after(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.BRAINROUTER_HOME;
  else process.env.BRAINROUTER_HOME = ORIGINAL_HOME;
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

/**
 * FED-S2-T6 — CLI federation registration lifecycle.
 *
 * Covers:
 *   - No-op when the brain lacks session_register / session_heartbeat
 *     (pre-0.4.0 brain compatibility).
 *   - On startup: registers once.
 *   - Heartbeat tick: calls session_heartbeat with the active sessionKey.
 *   - Re-register-on-falsy-update path: when the brain returns
 *     `{ updated: false }` (row swept), the next tick triggers a
 *     fresh session_register so federation view recovers automatically.
 *   - stop() halts heartbeats.
 */

interface RecordedCall {
  name: string;
  args: any;
}

function toolResult(payload: unknown) {
  return { isError: false, content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function makeStubClient(opts: {
  listTools: Array<{ name: string }>;
  heartbeatResults?: Array<{ updated: boolean }>;
}) {
  const calls: RecordedCall[] = [];
  let hbIdx = 0;
  const client = {
    async listTools() {
      return { tools: opts.listTools };
    },
    async callTool(name: string, args: any) {
      calls.push({ name, args });
      if (name === 'session_heartbeat') {
        const result = opts.heartbeatResults?.[hbIdx++] ?? { updated: true };
        return { isError: false, content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      if (name === 'session_register') {
        return { isError: false, content: [{ type: 'text', text: JSON.stringify({ session: { sessionKey: args.sessionKey } }) }] };
      }
      if (name === 'session_unregister') {
        return { isError: false, content: [{ type: 'text', text: JSON.stringify({ deleted: true }) }] };
      }
      return { isError: true, content: [{ type: 'text', text: 'unknown tool' }] };
    },
  } as any;
  return { client, calls };
}

test('attachFederation: starts local messaging when brain lacks federation tools', async () => {
  const { client, calls } = makeStubClient({ listTools: [{ name: 'memory_recall' }] });
  const handle = await attachFederation({
    mcpClient: client,
    sessionKey: 'sk-1',
    workspaceRoot: '/repos/alpha',
  });
  assert.equal(handle.sessionKey, 'sk-1');
  assert.equal((await handle.discoverSessions()).routes.some((route) =>
    route.sessionKey === 'sk-1' && route.transport === 'local'), true);
  assert.deepEqual(calls.filter((c) => c.name.startsWith('session_')), []);
  await handle.stop();
});

test('attachFederation: registers once on startup', async () => {
  const { client, calls } = makeStubClient({
    listTools: [{ name: 'session_register' }, { name: 'session_heartbeat' }],
  });
  const handle = await attachFederation({
    mcpClient: client,
    sessionKey: 'sk-startup',
    workspaceRoot: '/repos/alpha',
    state: 'working',
    title: 'Alpha session',
    titleSource: 'agent',
    intervalMs: 60_000,
  });
  assert.ok(handle);
  assert.equal(handle?.sessionKey, 'sk-startup');
  const registers = calls.filter((c) => c.name === 'session_register');
  assert.equal(registers.length, 1);
  assert.equal(registers[0].args.sessionKey, 'sk-startup');
  assert.equal(registers[0].args.workspaceRoot, '/repos/alpha');
  assert.equal(registers[0].args.clientKind, 'brainrouter-cli');
  assert.equal(registers[0].args.messageWakeVersion, 1);
  assert.match(registers[0].args.deviceId, /^[0-9a-f-]{36}$/);
  assert.equal(registers[0].args.title, 'Alpha session');
  assert.equal(registers[0].args.titleSource, 'agent');
  assert.equal(registers[0].args.state, 'working');
  assert.equal(registers[0].args.metadata.deviceId, undefined,
    'reserved registration fields must not be hidden in sanitized metadata');
  await handle?.stop();
});

test('attachFederation: heartbeat tick calls session_heartbeat', async () => {
  const { client, calls } = makeStubClient({
    listTools: [{ name: 'session_register' }, { name: 'session_heartbeat' }],
  });
  const handle = await attachFederation({
    mcpClient: client,
    sessionKey: 'sk-hb',
    workspaceRoot: '/repos/alpha',
    intervalMs: 10, // fire fast for the test
  });
  // Wait for ~3 ticks.
  await new Promise((resolve) => setTimeout(resolve, 45));
  await handle?.stop();
  const hbs = calls.filter((c) => c.name === 'session_heartbeat');
  assert.ok(hbs.length >= 2, `expected ≥2 heartbeats, got ${hbs.length}`);
  assert.equal(hbs[0].args.sessionKey, 'sk-hb');
});

test('attachFederation: re-registers when brain returns updated:false (row was swept)', async () => {
  const { client, calls } = makeStubClient({
    listTools: [{ name: 'session_register' }, { name: 'session_heartbeat' }],
    // Pretend the row was swept between startup and the first heartbeat.
    heartbeatResults: [{ updated: false }, { updated: true }],
  });
  const handle = await attachFederation({
    mcpClient: client,
    sessionKey: 'sk-resurrect',
    workspaceRoot: '/repos/alpha',
    intervalMs: 10,
  });
  // Two heartbeats + the swept-recovery re-register need a beat to land.
  await new Promise((resolve) => setTimeout(resolve, 50));
  await handle?.stop();
  const registers = calls.filter((c) => c.name === 'session_register');
  // Startup + at least one re-register after the swept heartbeat.
  assert.ok(registers.length >= 2, `expected ≥2 registers, got ${registers.length}`);
});

test('heartbeat and first-title registration are serialized so metadata is not lost', async () => {
  let releaseHeartbeat!: () => void;
  const heartbeatGate = new Promise<void>((resolve) => { releaseHeartbeat = resolve; });
  let heartbeatStarted!: () => void;
  const started = new Promise<void>((resolve) => { heartbeatStarted = resolve; });
  let firstHeartbeat = true;
  let remoteCallsInFlight = 0;
  let maxRemoteCallsInFlight = 0;
  const registrations: Array<Record<string, unknown>> = [];
  const client = {
    async listTools() {
      return { tools: [
        { name: 'session_register' },
        { name: 'session_heartbeat' },
        { name: 'session_unregister' },
      ] };
    },
    async callTool(name: string, args: Record<string, unknown>) {
      if (name === 'session_register' || name === 'session_heartbeat' || name === 'session_unregister') {
        remoteCallsInFlight += 1;
        maxRemoteCallsInFlight = Math.max(maxRemoteCallsInFlight, remoteCallsInFlight);
      }
      try {
        if (name === 'session_register') {
          registrations.push({ ...args });
          return toolResult({ session: { sessionKey: args.sessionKey } });
        }
        if (name === 'session_heartbeat') {
          if (firstHeartbeat) {
            firstHeartbeat = false;
            heartbeatStarted();
            await heartbeatGate;
          }
          return toolResult({ updated: true });
        }
        if (name === 'session_unregister') return toolResult({ deleted: true });
        return { isError: true, content: [{ type: 'text', text: 'unknown tool' }] };
      } finally {
        if (name === 'session_register' || name === 'session_heartbeat' || name === 'session_unregister') {
          remoteCallsInFlight -= 1;
        }
      }
    },
  } as any;
  const handle = await attachFederation({
    mcpClient: client,
    sessionKey: 'sk-title-heartbeat-race',
    workspaceRoot: '/repos/alpha',
    intervalMs: 10,
    inboxIntervalMs: 60_000,
  });
  try {
    await started;
    const titleUpdate = handle.updateRegistration({ title: 'First turn title', titleSource: 'agent' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(registrations.some((registration) => registration.title === 'First turn title'), false,
      'title update waits behind the active heartbeat instead of overlapping it');
    releaseHeartbeat();
    await titleUpdate;
    assert.equal(registrations.at(-1)?.title, 'First turn title');
    assert.equal(registrations.at(-1)?.titleSource, 'agent');
    assert.equal(maxRemoteCallsInFlight, 1);
  } finally {
    releaseHeartbeat();
    await handle.stop();
  }
});

test('attachFederation: stop() halts further heartbeats', async () => {
  const { client, calls } = makeStubClient({
    listTools: [{ name: 'session_register' }, { name: 'session_heartbeat' }],
  });
  const handle = await attachFederation({
    mcpClient: client,
    sessionKey: 'sk-stop',
    workspaceRoot: '/repos/alpha',
    intervalMs: 10,
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  await handle?.stop();
  const beforeStop = calls.filter((c) => c.name === 'session_heartbeat').length;
  await new Promise((resolve) => setTimeout(resolve, 40));
  const afterStop = calls.filter((c) => c.name === 'session_heartbeat').length;
  assert.equal(afterStop, beforeStop, 'no heartbeats fire after stop()');
});

test('attachFederation: stop() fires session_unregister exactly once', async () => {
  const { client, calls } = makeStubClient({
    listTools: [{ name: 'session_register' }, { name: 'session_heartbeat' }, { name: 'session_unregister' }],
  });
  const handle = await attachFederation({
    mcpClient: client,
    sessionKey: 'sk-bye',
    workspaceRoot: '/repos/alpha',
    intervalMs: 60_000,
  });
  await handle?.stop();
  await handle?.stop(); // second call must be a no-op — idempotent guard.
  const unregisters = calls.filter((c) => c.name === 'session_unregister');
  assert.equal(unregisters.length, 1, `expected 1 unregister call, got ${unregisters.length}`);
  assert.equal(unregisters[0].args.sessionKey, 'sk-bye');
});

test('attachFederation: stop drains a local POST acknowledged just before listener quiescence', async () => {
  const { client } = makeStubClient({ listTools: [] });
  const admitted: string[] = [];
  const rendered: string[] = [];
  let onMessageAvailable: ((message: LocalSessionMessage) => void) | undefined;
  let messages: LocalSessionMessage[] = [];
  let injected = false;
  const handle = await attachFederation({
    mcpClient: client,
    sessionKey: 'cli:stop-race-recipient',
    workspaceRoot: '/repos/alpha',
    onPeerMessage: async (message) => {
      admitted.push(message.id);
      return 'queued' as const;
    },
    onInboxText: async (batch) => { rendered.push(...batch.map((message) => message.id)); },
    startLocalTransport: async (options): Promise<LocalSessionTransportHandle> => {
      onMessageAvailable = options.onMessageAvailable;
      return {
        host: '127.0.0.1',
        port: 49152,
        registration: () => ({
          sessionKey: options.sessionKey,
          deviceId: '11111111-1111-4111-8111-111111111111',
          clientKind: 'cli',
          state: 'idle',
          transport: 'local',
          lastSeenAt: Date.now(),
          instanceCount: 1,
        }),
        pendingCount: () => messages.length,
        drain: () => {
          const drained = messages;
          messages = [];
          return { messages: drained, expired: [], expiredOmitted: 0 };
        },
        acceptPeerMessage: (message) => ({
          queued: false, status: 'not_queued', transport: 'local',
          targetSessionKey: message.targetSessionKey, messageId: message.id, reason: 'rejected',
        }),
        updateRegistration: () => ({
          sessionKey: options.sessionKey,
          deviceId: '11111111-1111-4111-8111-111111111111',
          clientKind: 'cli', state: 'idle', transport: 'local', lastSeenAt: Date.now(), instanceCount: 1,
        }),
        close: async () => {
          if (injected) return;
          injected = true;
          const message: LocalSessionMessage = {
            id: 'accepted-during-stop',
            senderSessionKey: 'desktop:sender',
            senderDeviceId: '22222222-2222-4222-8222-222222222222',
            targetSessionKey: options.sessionKey,
            text: 'Accepted immediately before the quiescence barrier.',
            source: 'peer-session',
            trust: 'untrusted-session',
            createdAt: Date.now() - 1,
            receivedAt: Date.now(),
          };
          messages.push(message);
          onMessageAvailable?.(message);
        },
      };
    },
  });

  await handle.stop();
  assert.equal(injected, true, 'fixture models a POST that received 202 before close completed');
  assert.deepEqual(admitted, ['accepted-during-stop']);
  assert.deepEqual(rendered, ['accepted-during-stop']);
});

test('attachFederation: stop() returns promptly when the unregister never resolves (hung brain)', async () => {
  let unregistered = 0;
  const client = {
    async listTools() {
      return { tools: [{ name: 'session_register' }, { name: 'session_heartbeat' }, { name: 'session_unregister' }] };
    },
    async callTool(name: string) {
      if (name === 'session_register') {
        return { isError: false, content: [{ type: 'text', text: JSON.stringify({ session: {} }) }] };
      }
      if (name === 'session_unregister') {
        unregistered++;
        // Never resolves — `stop()` must hit its internal 1.5 s timeout.
        return new Promise(() => {});
      }
      return { isError: false, content: [{ type: 'text', text: JSON.stringify({ updated: true }) }] };
    },
  } as any;
  const handle = await attachFederation({
    mcpClient: client,
    sessionKey: 'sk-hang',
    workspaceRoot: '/repos/alpha',
    intervalMs: 60_000,
  });
  const t0 = Date.now();
  await handle?.stop();
  const elapsed = Date.now() - t0;
  assert.equal(unregistered, 1, 'unregister must be attempted');
  assert.ok(elapsed < 2_500, `stop() must respect the timeout; took ${elapsed}ms`);
});

test('attachFederation: inbox poller fires session_inbox_read on its own cadence and dispatches text messages', async () => {
  const recordedCalls: Array<{ name: string; args: any }> = [];
  const queuedMessages = [
    [
      { id: 'm-1', kind: 'text', fromSessionKey: 'peer-a', payload: { text: 'hi', messageId: 'm-1', senderDeviceId: REMOTE_DEVICE }, createdAt: new Date().toISOString() },
    ],
    [], // empty subsequent ticks
  ];
  let pollIdx = 0;
  const client = {
    async listTools() {
      return {
        tools: [
          { name: 'session_register' },
          { name: 'session_heartbeat' },
          { name: 'session_unregister' },
          { name: 'session_inbox_read' },
        ],
      };
    },
    async callTool(name: string, args: any) {
      recordedCalls.push({ name, args });
      if (name === 'session_register') {
        return { isError: false, content: [{ type: 'text', text: JSON.stringify({ session: { sessionKey: args.sessionKey } }) }] };
      }
      if (name === 'session_heartbeat') {
        return { isError: false, content: [{ type: 'text', text: JSON.stringify({ updated: true }) }] };
      }
      if (name === 'session_inbox_read') {
        const messages = queuedMessages[pollIdx++] ?? [];
        return { isError: false, content: [{ type: 'text', text: JSON.stringify({ messages }) }] };
      }
      if (name === 'session_unregister') {
        return { isError: false, content: [{ type: 'text', text: JSON.stringify({ deleted: true }) }] };
      }
      return { isError: true, content: [{ type: 'text', text: 'unknown tool' }] };
    },
  } as any;

  const dispatched: Array<Array<{ id: string; text: string }>> = [];
  const handle = await attachFederation({
    mcpClient: client,
    sessionKey: 'sk-inbox',
    workspaceRoot: '/repos/alpha',
    intervalMs: 60_000, // never heartbeat during the test
    inboxIntervalMs: 10, // poll quickly
    onInboxText: (messages) => {
      dispatched.push(messages.map((m) => ({ id: m.id, text: m.text })));
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await handle?.stop();

  const reads = recordedCalls.filter((c) => c.name === 'session_inbox_read');
  assert.ok(reads.length >= 2, `expected ≥2 inbox polls, got ${reads.length}`);
  assert.equal(reads[0].args.peek, true, 'background banner poll must not consume inbox rows');
  assert.ok(dispatched.length >= 1, 'callback must have fired at least once');
  assert.deepEqual(dispatched[0], [{ id: 'm-1', text: 'hi' }]);
});

test('remote inbox polling preserves the Brain deadline and expires delayed rows without application', async () => {
  const now = Date.now();
  const nearExpiry = now + 60_000;
  const alreadyExpired = now - 1;
  const rows = [
    {
      id: 'near-expiry-row', kind: 'text', fromSessionKey: 'peer:near',
      toSessionKey: 'deadline:recipient',
      payload: {
        text: 'Still eligible briefly.',
        senderDeviceId: REMOTE_DEVICE,
        createdAt: nearExpiry - 24 * 60 * 60 * 1_000 - 5_000,
      },
      createdAt: new Date(nearExpiry - 24 * 60 * 60 * 1_000).toISOString(),
      expiresAt: new Date(nearExpiry).toISOString(),
    },
    {
      id: 'already-expired-row', kind: 'text', fromSessionKey: 'peer:late',
      toSessionKey: 'deadline:recipient',
      payload: { text: 'Must never be applied.', senderDeviceId: REMOTE_DEVICE },
      createdAt: new Date(alreadyExpired - 24 * 60 * 60 * 1_000).toISOString(),
      expiresAt: new Date(alreadyExpired).toISOString(),
    },
  ];
  const transitions: Array<{ id: string; status: string }> = [];
  const admitted: Array<{ id: string; createdAt: number; expiresAt?: number }> = [];
  const client = {
    async listTools() {
      return { tools: [
        { name: 'session_register' }, { name: 'session_heartbeat' },
        { name: 'session_unregister' }, { name: 'session_inbox_read' },
        { name: 'session_inbox_ack' },
      ] };
    },
    async callTool(name: string, args: any) {
      if (name === 'session_register') return toolResult({ session: { sessionKey: args.sessionKey } });
      if (name === 'session_heartbeat') return toolResult({ updated: true });
      if (name === 'session_unregister') return toolResult({ deleted: true });
      if (name === 'session_inbox_read') return toolResult({ messages: rows });
      if (name === 'session_inbox_ack') {
        transitions.push({ id: String(args.ids[0]), status: String(args.status) });
        return toolResult({ updated: 1, status: args.status });
      }
      return { isError: true, content: [{ type: 'text', text: 'unknown tool' }] };
    },
  } as any;
  const handle = await attachFederation({
    mcpClient: client,
    sessionKey: 'deadline:recipient',
    workspaceRoot: fs.mkdtempSync(path.join(TEST_HOME, 'deadline-recipient-')),
    intervalMs: 60_000,
    inboxIntervalMs: 60_000,
    onPeerMessage: (message) => {
      admitted.push({ id: message.id, createdAt: message.createdAt, expiresAt: message.expiresAt });
      return 'held';
    },
  });
  try {
    await handle.pollNow();
    assert.deepEqual(admitted, [{
      id: 'near-expiry-row',
      createdAt: nearExpiry - 24 * 60 * 60 * 1_000,
      expiresAt: nearExpiry,
    }]);
    assert.deepEqual(
      transitions.sort((left, right) => left.id.localeCompare(right.id)),
      [
        { id: 'already-expired-row', status: 'expired' },
        { id: 'near-expiry-row', status: 'held' },
      ],
    );
    assert.equal(transitions.some((transition) => transition.status === 'applied'), false);
  } finally {
    await handle.stop();
  }
});

test('attachFederation: peeked inbox messages are de-duplicated locally between polls', async () => {
  const repeated = { id: 'repeat-1', kind: 'text', fromSessionKey: 'peer-a', payload: { text: 'same row', messageId: 'repeat-1', senderDeviceId: REMOTE_DEVICE }, createdAt: new Date().toISOString() };
  let pollCount = 0;
  const client = {
    async listTools() {
      return {
        tools: [
          { name: 'session_register' },
          { name: 'session_heartbeat' },
          { name: 'session_unregister' },
          { name: 'session_inbox_read' },
        ],
      };
    },
    async callTool(name: string, args: any) {
      if (name === 'session_register') {
        return { isError: false, content: [{ type: 'text', text: JSON.stringify({ session: { sessionKey: args.sessionKey } }) }] };
      }
      if (name === 'session_heartbeat') {
        return { isError: false, content: [{ type: 'text', text: JSON.stringify({ updated: true }) }] };
      }
      if (name === 'session_inbox_read') {
        pollCount++;
        return { isError: false, content: [{ type: 'text', text: JSON.stringify({ messages: [repeated] }) }] };
      }
      if (name === 'session_unregister') {
        return { isError: false, content: [{ type: 'text', text: JSON.stringify({ deleted: true }) }] };
      }
      return { isError: true, content: [{ type: 'text', text: 'unknown tool' }] };
    },
  } as any;

  const dispatched: string[] = [];
  const handle = await attachFederation({
    mcpClient: client,
    sessionKey: 'sk-dedupe',
    workspaceRoot: '/repos/alpha',
    intervalMs: 60_000,
    inboxIntervalMs: 10,
    onInboxText: (messages) => {
      for (const m of messages) dispatched.push(m.id);
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await handle?.stop();

  assert.ok(pollCount >= 2, `expected repeated polling, got ${pollCount}`);
  assert.deepEqual(dispatched, ['repeat-1']);
});

test('attachFederation: inbox poll is skipped entirely when the brain lacks session_inbox_read', async () => {
  const recordedCalls: Array<{ name: string; args: any }> = [];
  const client = {
    async listTools() {
      return {
        tools: [
          { name: 'session_register' },
          { name: 'session_heartbeat' },
          // No session_inbox_read — older brain or partial deployment.
        ],
      };
    },
    async callTool(name: string, args: any) {
      recordedCalls.push({ name, args });
      if (name === 'session_register') {
        return { isError: false, content: [{ type: 'text', text: JSON.stringify({ session: {} }) }] };
      }
      return { isError: false, content: [{ type: 'text', text: JSON.stringify({ updated: true }) }] };
    },
  } as any;

  let dispatched = 0;
  const handle = await attachFederation({
    mcpClient: client,
    sessionKey: 'sk-no-inbox',
    workspaceRoot: '/repos/alpha',
    intervalMs: 60_000,
    inboxIntervalMs: 10,
    onInboxText: () => { dispatched++; },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await handle?.stop();
  assert.equal(dispatched, 0, 'callback must not fire when the brain lacks the inbox tool');
  assert.equal(
    recordedCalls.filter((c) => c.name === 'session_inbox_read').length,
    0,
    'no inbox polls when the tool is unavailable',
  );
});

test('attachFederation: setOnInboxText swap replays messages that arrived before a handler was set', async () => {
  // Production scenario: federation poller starts BEFORE the Ink REPL
  // has a controller, so the initial `onInboxText` may be undefined
  // (or a stdout fallback we want to upgrade). Messages that landed
  // during that gap must replay when the real handler swaps in —
  // otherwise an incoming /dm during startup vanishes.
  const queuedMessages = [
    [
      { id: 'pre-1', kind: 'text', fromSessionKey: 'peer-a', payload: { text: 'arrived early', messageId: 'pre-1', senderDeviceId: REMOTE_DEVICE }, createdAt: new Date().toISOString() },
    ],
    [],
  ];
  let pollIdx = 0;
  const client = {
    async listTools() {
      return {
        tools: [
          { name: 'session_register' },
          { name: 'session_heartbeat' },
          { name: 'session_unregister' },
          { name: 'session_inbox_read' },
        ],
      };
    },
    async callTool(name: string, args: any) {
      if (name === 'session_register') {
        return { isError: false, content: [{ type: 'text', text: JSON.stringify({ session: { sessionKey: args.sessionKey } }) }] };
      }
      if (name === 'session_heartbeat') {
        return { isError: false, content: [{ type: 'text', text: JSON.stringify({ updated: true }) }] };
      }
      if (name === 'session_inbox_read') {
        const messages = queuedMessages[pollIdx++] ?? [];
        return { isError: false, content: [{ type: 'text', text: JSON.stringify({ messages }) }] };
      }
      if (name === 'session_unregister') {
        return { isError: false, content: [{ type: 'text', text: JSON.stringify({ deleted: true }) }] };
      }
      return { isError: true, content: [{ type: 'text', text: 'unknown tool' }] };
    },
  } as any;

  // Attach with NO handler — the federation handle should buffer the
  // first poll's messages internally.
  const handle = await attachFederation({
    mcpClient: client,
    sessionKey: 'sk-replay',
    workspaceRoot: '/repos/alpha',
    intervalMs: 60_000,
    inboxIntervalMs: 10,
  });
  // Let the first poll tick land.
  await new Promise((resolve) => setTimeout(resolve, 30));

  // Now swap in a real handler — buffered message must replay.
  const received: Array<Array<{ id: string; text: string }>> = [];
  handle?.setOnInboxText((messages) => {
    received.push(messages.map((m) => ({ id: m.id, text: m.text })));
  });
  // Small delay to let the buffered replay land.
  await new Promise((resolve) => setTimeout(resolve, 15));
  await handle?.stop();

  // The buffered batch must have replayed via the new handler.
  assert.ok(
    received.some((batch) => batch.some((m) => m.id === 'pre-1' && m.text === 'arrived early')),
    `expected buffered message to replay, got ${JSON.stringify(received)}`,
  );
});

test('attachFederation: setOnInboxText(null) detaches without buffering replays on next swap', async () => {
  // A user who calls /persona off mid-session shouldn't replay every
  // banner they previously dismissed. Once the handler is set, the
  // buffer is flushed; subsequent set(null) + set(handler) sequences
  // only deliver new messages, not historical ones.
  const queuedMessages = [
    [{ id: 'first', kind: 'text', fromSessionKey: 'peer', payload: { text: 'one', messageId: 'first', senderDeviceId: REMOTE_DEVICE }, createdAt: new Date().toISOString() }],
    [{ id: 'second', kind: 'text', fromSessionKey: 'peer', payload: { text: 'two', messageId: 'second', senderDeviceId: REMOTE_DEVICE }, createdAt: new Date().toISOString() }],
  ];
  let pollIdx = 0;
  const client = {
    async listTools() {
      return { tools: [{ name: 'session_register' }, { name: 'session_heartbeat' }, { name: 'session_inbox_read' }] };
    },
    async callTool(name: string, args: any) {
      if (name === 'session_register') {
        return { isError: false, content: [{ type: 'text', text: JSON.stringify({ session: { sessionKey: args.sessionKey } }) }] };
      }
      if (name === 'session_inbox_read') {
        const messages = queuedMessages[pollIdx++] ?? [];
        return { isError: false, content: [{ type: 'text', text: JSON.stringify({ messages }) }] };
      }
      return { isError: false, content: [{ type: 'text', text: JSON.stringify({ updated: true }) }] };
    },
  } as any;

  const collected: Array<{ id: string }> = [];
  const handle = await attachFederation({
    mcpClient: client,
    sessionKey: 'sk-detach',
    workspaceRoot: '/repos/alpha',
    intervalMs: 60_000,
    inboxIntervalMs: 10,
    onInboxText: (messages) => {
      for (const m of messages) collected.push({ id: m.id });
    },
  });
  // Let the first poll land + handler fire.
  await new Promise((resolve) => setTimeout(resolve, 30));
  // Detach.
  handle?.setOnInboxText(null);
  // Let one more poll fire while detached.
  await new Promise((resolve) => setTimeout(resolve, 30));
  await handle?.stop();

  // First message was delivered live; second message arrived while
  // detached and may have buffered. The detach itself must not throw.
  assert.ok(collected.some((m) => m.id === 'first'));
});

test('ADR-034 attachFederation delivers locally while Brain is offline', async () => {
  const offline = {
    async listTools() { throw new Error('brain offline'); },
    async callTool() { throw new Error('brain offline'); },
  } as any;
  const errors: string[] = [];
  const received: string[] = [];
  let receivedDetails: Record<string, unknown> | undefined;
  const sender = await attachFederation({
    mcpClient: offline,
    sessionKey: 'offline:sender',
    workspaceRoot: '/repos/offline',
    title: 'Offline sender',
    intervalMs: 60_000,
    inboxIntervalMs: 60_000,
    onInboxError: (error) => errors.push(error.message),
  });
  const recipient = await attachFederation({
    mcpClient: offline,
    sessionKey: 'offline:recipient',
    workspaceRoot: '/repos/offline',
    intervalMs: 60_000,
    inboxIntervalMs: 60_000,
    onInboxError: (error) => errors.push(error.message),
    onPeerMessage: (message, senderDetails) => {
      received.push(message.text);
      receivedDetails = senderDetails;
      return 'queued';
    },
  });
  try {
    const receipt = await sender.sendMessage({
      targetSessionKey: 'offline:recipient',
      kind: 'text',
      payload: { text: 'works without Brain' },
      localText: 'works without Brain',
    });
    assert.equal(receipt.accepted, true);
    assert.equal(receipt.accepted ? receipt.state : '', 'queued');
    assert.equal(receipt.accepted ? receipt.transport : '', 'local');
    assert.match(receipt.messageId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(received, ['works without Brain']);
    assert.deepEqual(receivedDetails, {
      transport: 'local',
      clientKind: 'cli',
      workspaceRoot: '/repos/offline',
      title: 'Offline sender',
    });
    assert.ok(errors.some((message) => message.includes('brain offline')),
      'offline inbox capability failures must be surfaced');
  } finally {
    await Promise.all([sender.stop(), recipient.stop()]);
  }
});

test('ADR-034 resumed logical session reclaims and polls a durable row after host exit', async () => {
  const logicalSessionKey = 'resume:logical-session';
  const row = {
    id: 'resume-inbox-row',
    messageId: 'resume-logical-message',
    kind: 'text',
    fromSessionKey: 'resume:sender',
    toSessionKey: logicalSessionKey,
    payload: {
      text: 'survives recipient restart',
      senderDeviceId: REMOTE_DEVICE,
      senderClientKind: 'brainrouter-cli',
      senderWorkspaceRoot: '/repos/sender-before-exit',
      senderTitle: 'Exited sender',
    },
    createdAt: new Date().toISOString(),
  };
  let active = false;
  const calls: RecordedCall[] = [];
  const client = {
    async listTools() {
      return { tools: [
        { name: 'session_register' },
        { name: 'session_heartbeat' },
        { name: 'session_unregister' },
        { name: 'session_inbox_read' },
        { name: 'session_inbox_ack' },
      ] };
    },
    async callTool(name: string, args: any) {
      calls.push({ name, args });
      if (name === 'session_register') {
        assert.equal(active, false, 'the prior incarnation must unregister before resume reclaims the key');
        active = true;
        return toolResult({ session: { sessionKey: args.sessionKey } });
      }
      if (name === 'session_heartbeat') return toolResult({ updated: active });
      if (name === 'session_unregister') { active = false; return toolResult({ deleted: true }); }
      if (name === 'session_inbox_read') return toolResult({ messages: [row] });
      if (name === 'session_inbox_ack') return toolResult({ updated: 1, status: args.status });
      return { isError: true, content: [{ type: 'text', text: 'unknown tool' }] };
    },
  } as any;

  const firstAdmissions: string[] = [];
  const first = await attachFederation({
    mcpClient: client,
    sessionKey: logicalSessionKey,
    workspaceRoot: '/repos/resume-recipient',
    intervalMs: 60_000,
    inboxIntervalMs: 60_000,
    onPeerMessage: (message) => { firstAdmissions.push(message.id); return 'held'; },
  });
  await first.pollNow();
  await first.stop();

  const resumedAdmissions: Array<{ id: string; details: Record<string, unknown> }> = [];
  const resumed = await attachFederation({
    mcpClient: client,
    sessionKey: logicalSessionKey,
    workspaceRoot: '/repos/resume-recipient',
    intervalMs: 60_000,
    inboxIntervalMs: 60_000,
    onPeerMessage: (message, details) => {
      resumedAdmissions.push({ id: message.id, details });
      return 'held';
    },
  });
  try {
    await resumed.pollNow();
    assert.deepEqual(firstAdmissions, ['resume-inbox-row']);
    assert.deepEqual(resumedAdmissions, [{
      id: 'resume-inbox-row',
      details: {
        transport: 'remote',
        clientKind: 'cli',
        workspaceRoot: '/repos/sender-before-exit',
        title: 'Exited sender',
      },
    }]);
    assert.equal(calls.filter((call) => call.name === 'session_register' &&
      call.args.sessionKey === logicalSessionKey).length, 2);
  } finally {
    await resumed.stop();
  }
});

test('ADR-034 simultaneous local claims for one logical key refuse routing as ambiguous', async () => {
  const offline = {
    async listTools() { return { tools: [] }; },
    async callTool() { throw new Error('unexpected remote call'); },
  } as any;
  const first = await attachFederation({
    mcpClient: offline,
    sessionKey: 'duplicate:logical-key',
    workspaceRoot: '/repos/duplicate-claim',
    intervalMs: 60_000,
    inboxIntervalMs: 60_000,
  });
  const second = await attachFederation({
    mcpClient: offline,
    sessionKey: 'duplicate:logical-key',
    workspaceRoot: '/repos/duplicate-claim',
    intervalMs: 60_000,
    inboxIntervalMs: 60_000,
  });
  const sender = await attachFederation({
    mcpClient: offline,
    sessionKey: 'duplicate:sender',
    workspaceRoot: '/repos/duplicate-claim',
    intervalMs: 60_000,
    inboxIntervalMs: 60_000,
  });
  try {
    const discovery = await sender.discoverSessions();
    assert.equal(discovery.routes.find((route) => route.sessionKey === 'duplicate:logical-key')?.ambiguous, true);
    const receipt = await sender.sendMessage({
      targetSessionKey: 'duplicate:logical-key',
      kind: 'text',
      payload: { text: 'must not guess' },
      localText: 'must not guess',
    });
    assert.equal(receipt.accepted, false);
    assert.equal(receipt.accepted ? '' : receipt.reason, 'ambiguous');
  } finally {
    await Promise.all([first.stop(), second.stop(), sender.stop()]);
  }
});

test('ADR-034 same-machine route wins over a duplicate remote exact route', async () => {
  const recipientKey = 'local-wins:recipient';
  const offline = {
    async listTools() { return { tools: [] }; },
    async callTool() { throw new Error('unexpected remote call'); },
  } as any;
  const remoteCalls: RecordedCall[] = [];
  const senderClient = {
    async listTools() {
      return { tools: [
        { name: 'session_register' },
        { name: 'session_heartbeat' },
        { name: 'session_unregister' },
        { name: 'session_list' },
        { name: 'session_send' },
      ] };
    },
    async callTool(name: string, args: any) {
      remoteCalls.push({ name, args });
      if (name === 'session_register') return toolResult({ session: { sessionKey: args.sessionKey } });
      if (name === 'session_heartbeat') return toolResult({ updated: true });
      if (name === 'session_unregister') return toolResult({ deleted: true });
      if (name === 'session_list') return toolResult({ sessions: [{
        sessionKey: recipientKey,
        clientKind: 'brainrouter-cli',
        deviceId: REMOTE_DEVICE,
        state: 'idle',
        lastHeartbeatAt: new Date().toISOString(),
      }] });
      if (name === 'session_send') return toolResult({ accepted: 1 });
      return { isError: true, content: [{ type: 'text', text: 'unknown tool' }] };
    },
  } as any;
  const received: string[] = [];
  const recipient = await attachFederation({
    mcpClient: offline,
    sessionKey: recipientKey,
    workspaceRoot: '/repos/local-wins',
    intervalMs: 60_000,
    inboxIntervalMs: 60_000,
    onPeerMessage: (message) => { received.push(message.text); return 'queued'; },
  });
  const sender = await attachFederation({
    mcpClient: senderClient,
    sessionKey: 'local-wins:sender',
    workspaceRoot: '/repos/local-wins',
    intervalMs: 60_000,
    inboxIntervalMs: 60_000,
  });
  try {
    const discovery = await sender.discoverSessions();
    assert.equal(discovery.routes.find((route) => route.sessionKey === recipientKey)?.transport, 'local');
    const receipt = await sender.sendMessage({
      targetSessionKey: recipientKey,
      kind: 'text',
      payload: { text: 'prefer loopback' },
      localText: 'prefer loopback',
    });
    assert.equal(receipt.accepted, true);
    assert.equal(receipt.accepted ? receipt.transport : '', 'local');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(received, ['prefer loopback']);
    assert.equal(remoteCalls.filter((call) => call.name === 'session_send').length, 0);
  } finally {
    await Promise.all([sender.stop(), recipient.stop()]);
  }
});

test('ADR-034 notification and polling races admit one peer message', async () => {
  let wakeListener: ((wake: { sessionKey: string; messageIds: string[] }) => void | Promise<void>) | undefined;
  const row = {
    id: 'receipt-race',
    messageId: 'message-race',
    kind: 'text',
    fromSessionKey: 'peer:race',
    toSessionKey: 'race:recipient',
    payload: {
      text: 'apply exactly once',
      messageId: 'message-race',
      senderDeviceId: REMOTE_DEVICE,
    },
    createdAt: new Date().toISOString(),
  };
  const client = {
    async listTools() {
      return { tools: [
        { name: 'session_register' },
        { name: 'session_heartbeat' },
        { name: 'session_unregister' },
        { name: 'session_inbox_read' },
      ] };
    },
    subscribeSessionMessageWakes(listener: typeof wakeListener) {
      wakeListener = listener;
      return () => { wakeListener = undefined; };
    },
    async callTool(name: string, args: any) {
      if (name === 'session_register') return toolResult({ session: { sessionKey: args.sessionKey } });
      if (name === 'session_heartbeat') return toolResult({ updated: true });
      if (name === 'session_unregister') return toolResult({ deleted: true });
      if (name === 'session_inbox_read') return toolResult({ messages: [row] });
      return { isError: true, content: [{ type: 'text', text: 'unknown tool' }] };
    },
  } as any;
  let admitted = 0;
  const handle = await attachFederation({
    mcpClient: client,
    sessionKey: 'race:recipient',
    workspaceRoot: '/repos/race',
    intervalMs: 60_000,
    inboxIntervalMs: 60_000,
    onPeerMessage: () => { admitted += 1; return 'queued'; },
  });
  try {
    assert.ok(wakeListener, 'authenticated wake listener must be subscribed');
    await Promise.all([
      Promise.resolve(wakeListener?.({ sessionKey: 'race:recipient', messageIds: ['receipt-race'] })),
      handle.pollNow(),
    ]);
    await handle.pollNow();
    assert.equal(admitted, 1, 'wake, concurrent poll, and fallback poll share one idempotency gate');
  } finally {
    await handle.stop();
  }
});

test('ADR-034 two senders may reuse one logical id and each receipt applies exactly once', async () => {
  const sharedLogicalId = 'sender-scoped-idempotency-key';
  let activeRows = [
    {
      id: 'receipt-from-sender-a',
      messageId: sharedLogicalId,
      kind: 'text',
      fromSessionKey: 'peer:sender-a',
      toSessionKey: 'collision:recipient',
      payload: {
        text: 'message from A',
        messageId: sharedLogicalId,
        senderDeviceId: REMOTE_DEVICE,
      },
      createdAt: new Date().toISOString(),
    },
    {
      id: 'receipt-from-sender-b',
      messageId: sharedLogicalId,
      kind: 'text',
      fromSessionKey: 'peer:sender-b',
      toSessionKey: 'collision:recipient',
      payload: {
        text: 'message from B',
        messageId: sharedLogicalId,
        senderDeviceId: '22222222-2222-4222-8222-222222222222',
      },
      createdAt: new Date().toISOString(),
    },
  ];
  const applied: string[] = [];
  const admitted: Array<{ id: string; sender: string }> = [];
  const errors: string[] = [];
  const client = {
    async listTools() {
      return { tools: [
        { name: 'session_register' },
        { name: 'session_heartbeat' },
        { name: 'session_unregister' },
        { name: 'session_inbox_read' },
        { name: 'session_inbox_ack' },
      ] };
    },
    async callTool(name: string, args: any) {
      if (name === 'session_register') return toolResult({ session: { sessionKey: args.sessionKey } });
      if (name === 'session_heartbeat') return toolResult({ updated: true });
      if (name === 'session_unregister') return toolResult({ deleted: true });
      if (name === 'session_inbox_read') return toolResult({ messages: activeRows });
      if (name === 'session_inbox_ack') {
        if (args.status === 'applied') applied.push(...args.ids);
        activeRows = activeRows.filter((row) => !args.ids.includes(row.id));
        return toolResult({ updated: args.ids.length, status: args.status });
      }
      return { isError: true, content: [{ type: 'text', text: 'unknown tool' }] };
    },
  } as any;
  const handle = await attachFederation({
    mcpClient: client,
    sessionKey: 'collision:recipient',
    workspaceRoot: '/repos/collision',
    intervalMs: 60_000,
    inboxIntervalMs: 60_000,
    onPeerMessage: (message) => {
      admitted.push({ id: message.id, sender: message.senderSessionKey });
      return 'queued';
    },
    onInboxError: (error) => errors.push(error.message),
  });
  try {
    await handle.pollNow();
    await handle.pollNow();
    assert.deepEqual(admitted, [
      { id: 'receipt-from-sender-a', sender: 'peer:sender-a' },
      { id: 'receipt-from-sender-b', sender: 'peer:sender-b' },
    ], 'receipt ids, not sender-scoped logical ids, own recipient dedupe');

    assert.equal(await handle.transitionInbound('receipt-from-sender-a', 'applied'), true);
    assert.equal(await handle.transitionInbound('receipt-from-sender-b', 'applied'), true);
    assert.deepEqual(applied.sort(), ['receipt-from-sender-a', 'receipt-from-sender-b']);
    assert.equal(errors.some((message) => message.includes('id_conflict')), false);
  } finally {
    await handle.stop();
  }
});

test('ADR-034 remote rows stay pending until held or safe-boundary lifecycle transitions', async () => {
  const row = {
    id: 'inbox-held-1',
    messageId: 'logical-held-1',
    kind: 'text',
    fromSessionKey: 'legacy:sender',
    toSessionKey: 'lifecycle:recipient',
    payload: { text: 'requires recipient approval' },
    createdAt: new Date().toISOString(),
  };
  const calls: RecordedCall[] = [];
  const sequence: string[] = [];
  let rowActive = true;
  let admittedDeviceId = '';
  let admittedDetails: Record<string, unknown> | undefined;
  let admitted = 0;
  const client = {
    async listTools() {
      return { tools: [
        { name: 'session_register' },
        { name: 'session_heartbeat' },
        { name: 'session_unregister' },
        { name: 'session_inbox_read' },
        { name: 'session_inbox_ack' },
        { name: 'session_receipts' },
        { name: 'session_receipts_ack' },
        { name: 'session_list' },
      ] };
    },
    async callTool(name: string, args: any) {
      calls.push({ name, args });
      if (name === 'session_register') return toolResult({ session: { sessionKey: args.sessionKey } });
      if (name === 'session_heartbeat') return toolResult({ updated: true });
      if (name === 'session_unregister') return toolResult({ deleted: true });
      if (name === 'session_list') return toolResult({ sessions: [{
        sessionKey: 'legacy:sender',
        clientKind: 'brainrouter-desktop',
        workspaceRoot: '/repos/remote-sender',
        title: 'Remote sender',
        state: 'idle',
        lastHeartbeatAt: new Date().toISOString(),
      }] });
      if (name === 'session_inbox_read') return toolResult({ messages: rowActive ? [row] : [] });
      if (name === 'session_inbox_ack') {
        sequence.push(`inbox:${args.status}:${args.ids.join(',')}`);
        if (args.status === 'applied') rowActive = false;
        return toolResult({ updated: args.ids.length, status: args.status });
      }
      if (name === 'session_receipts') {
        return toolResult({ receipts: [{
          id: 'sender-receipt-1',
          messageId: 'logical-outbound-1',
          toSessionKey: 'remote:recipient',
          status: 'applied',
        }] });
      }
      if (name === 'session_receipts_ack') {
        sequence.push(`receipt-ack:${args.ids.join(',')}`);
        return toolResult({ acknowledged: args.ids.length });
      }
      return { isError: true, content: [{ type: 'text', text: 'unknown tool' }] };
    },
  } as any;
  const handle = await attachFederation({
    mcpClient: client,
    sessionKey: 'lifecycle:recipient',
    workspaceRoot: '/repos/lifecycle',
    intervalMs: 60_000,
    inboxIntervalMs: 60_000,
    onPeerMessage: (message, senderDetails) => {
      admitted += 1;
      admittedDeviceId = message.senderDeviceId;
      admittedDetails = senderDetails;
      return 'held';
    },
    onReceipts: (receipts) => {
      sequence.push(`display:${receipts.map((receipt) => receipt.status).join(',')}`);
    },
  });
  try {
    await handle.pollNow();
    assert.equal(admitted, 1);
    assert.match(admittedDeviceId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      'legacy rows receive a deterministic valid untrusted device UUID');
    assert.deepEqual(admittedDetails, {
      transport: 'remote',
      clientKind: 'desktop',
      workspaceRoot: '/repos/remote-sender',
      title: 'Remote sender',
    });
    assert.ok(calls.some((call) => call.name === 'session_inbox_read' &&
      call.args.peek === true && call.args.statuses.join(',') === 'pending,held'));
    assert.ok(sequence.includes('inbox:held:inbox-held-1'),
      'held transition uses the durable inbox receipt id, not the logical message id');
    assert.ok(sequence.indexOf('display:applied') < sequence.indexOf('receipt-ack:sender-receipt-1'),
      'terminal sender receipt is acknowledged only after the UI handler returns');

    const transitioned = await handle.transitionInbound('inbox-held-1', 'applied');
    assert.equal(transitioned, true);
    assert.ok(sequence.includes('inbox:applied:inbox-held-1'));
    await handle.pollNow();
    assert.equal(admitted, 1, 'held replay remains idempotent across later polls');
  } finally {
    await handle.stop();
  }
});

test('recipient held-store capacity transitions the exact remote row to queue_full', async () => {
  const statuses: string[] = [];
  const row = {
    id: 'inbox-capacity-full',
    messageId: 'logical-capacity-full',
    kind: 'text',
    fromSessionKey: 'peer:capacity-sender',
    toSessionKey: 'capacity:recipient',
    payload: { text: 'Must receive a capacity receipt.', senderDeviceId: REMOTE_DEVICE },
    createdAt: new Date().toISOString(),
  };
  const client = {
    async listTools() {
      return { tools: [
        { name: 'session_register' },
        { name: 'session_heartbeat' },
        { name: 'session_unregister' },
        { name: 'session_inbox_read' },
        { name: 'session_inbox_ack' },
      ] };
    },
    async callTool(name: string, args: any) {
      if (name === 'session_register') return toolResult({ session: { sessionKey: args.sessionKey } });
      if (name === 'session_heartbeat') return toolResult({ updated: true });
      if (name === 'session_unregister') return toolResult({ deleted: true });
      if (name === 'session_inbox_read') return toolResult({ messages: [row] });
      if (name === 'session_inbox_ack') {
        statuses.push(args.status);
        return toolResult({ updated: 1, status: args.status });
      }
      return { isError: true, content: [{ type: 'text', text: 'unknown tool' }] };
    },
  } as any;
  const handle = await attachFederation({
    mcpClient: client,
    sessionKey: 'capacity:recipient',
    workspaceRoot: '/repos/capacity',
    intervalMs: 60_000,
    inboxIntervalMs: 60_000,
    onPeerMessage: () => 'queue_full',
  });
  try {
    await handle.pollNow();
    assert.deepEqual(statuses, ['queue_full']);
  } finally {
    await handle.stop();
  }
});

test('ADR-034 remote discovery, send receipts, self refusal, and broadcast idempotency are exact', async () => {
  const targetA = 'remote:alpha:exact';
  const targetB = 'remote:beta:exact';
  const calls: RecordedCall[] = [];
  const client = {
    async listTools() {
      return { tools: [
        { name: 'session_register' },
        { name: 'session_heartbeat' },
        { name: 'session_unregister' },
        { name: 'session_list' },
        { name: 'session_send' },
      ] };
    },
    async callTool(name: string, args: any) {
      calls.push({ name, args });
      if (name === 'session_register') return toolResult({ session: { sessionKey: args.sessionKey } });
      if (name === 'session_heartbeat') return toolResult({ updated: true });
      if (name === 'session_unregister') return toolResult({ deleted: true });
      if (name === 'session_list') return toolResult({ sessions: [
        {
          sessionKey: targetA,
          clientKind: 'desktop',
          workspaceRoot: '/repos/alpha',
          lastHeartbeatAt: new Date().toISOString(),
          deviceId: REMOTE_DEVICE,
          title: 'Alpha desktop',
          titleSource: 'human',
          state: 'working',
          metadata: { deviceId: 'ignored', title: 'ignored', state: 'idle' },
        },
        {
          sessionKey: targetB,
          clientKind: 'desktop',
          workspaceRoot: '/repos/beta',
          lastHeartbeatAt: new Date().toISOString(),
          deviceId: '22222222-2222-4222-8222-222222222222',
          state: 'waiting',
        },
      ] });
      if (name === 'session_send') return toolResult({
        messageId: args.messageId,
        accepted: 1,
        recipients: [{
          sessionKey: args.to,
          inboxId: `inbox:${args.to}`,
          status: 'pending',
          wake: 'pushed',
        }],
      });
      return { isError: true, content: [{ type: 'text', text: 'unknown tool' }] };
    },
  } as any;
  const handle = await attachFederation({
    mcpClient: client,
    sessionKey: 'remote:sender:self',
    workspaceRoot: '/repos/sender',
    title: 'CLI sender session',
    intervalMs: 60_000,
    inboxIntervalMs: 60_000,
  });
  try {
    const discovery = await handle.discoverSessions();
    const alpha = discovery.routes.find((route) => route.sessionKey === targetA);
    assert.deepEqual(alpha && {
      deviceId: alpha.deviceId,
      title: alpha.title,
      titleSource: alpha.titleSource,
      state: alpha.state,
      transport: alpha.transport,
    }, {
      deviceId: REMOTE_DEVICE,
      title: 'Alpha desktop',
      titleSource: 'human',
      state: 'working',
      transport: 'remote',
    });

    const self = await handle.sendMessage({
      targetSessionKey: handle.sessionKey,
      kind: 'text',
      payload: { text: 'no' },
      localText: 'no',
    });
    assert.equal(self.accepted, false);
    assert.equal(self.accepted ? '' : self.reason, 'self_send');

    const unknown = await handle.sendMessage({
      targetSessionKey: 'remote:unknown:full-key',
      kind: 'text',
      payload: { text: 'no fallback' },
      localText: 'no fallback',
    });
    assert.equal(unknown.accepted, false);
    assert.equal(unknown.accepted ? '' : unknown.reason, 'not_found');

    const direct = await handle.sendMessage({
      targetSessionKey: targetA,
      kind: 'text',
      payload: { text: 'hello' },
      localText: 'hello',
    });
    assert.equal(direct.accepted, true);
    if (direct.accepted) {
      assert.equal(direct.inboxId, `inbox:${targetA}`);
      assert.equal(direct.recipientStatus, 'pending');
      assert.equal(direct.wake, 'pushed');
    }
    const directCall = calls.filter((call) => call.name === 'session_send').at(-1);
    assert.equal(directCall?.args.payload.senderClientKind, 'brainrouter-cli');
    assert.equal(directCall?.args.payload.senderWorkspaceRoot, '/repos/sender');
    assert.equal(directCall?.args.payload.senderTitle, 'CLI sender session');

    const beforeBroadcast = calls.filter((call) => call.name === 'session_send').length;
    const broadcast = await handle.broadcastText('per-target idempotency', 'desktop');
    assert.equal(broadcast.length, 2);
    const broadcastCalls = calls.filter((call) => call.name === 'session_send').slice(beforeBroadcast);
    assert.equal(broadcastCalls.length, 2);
    assert.notEqual(broadcastCalls[0]!.args.messageId, broadcastCalls[1]!.args.messageId,
      'exact remote sends require distinct idempotency keys because their target addresses differ');
    for (const call of broadcastCalls) {
      assert.equal(call.args.messageId, call.args.payload.messageId);
      assert.match(call.args.payload.senderDeviceId,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  } finally {
    await handle.stop();
  }
});

test('broadcast preflights the 100-recipient bound and sends nothing on overflow', async () => {
  const calls: RecordedCall[] = [];
  const sessions = Array.from({ length: 101 }, (_, index) => ({
    sessionKey: `remote:overflow:${String(index).padStart(3, '0')}`,
    clientKind: 'desktop',
    lastHeartbeatAt: new Date().toISOString(),
    deviceId: `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`,
    state: 'idle',
  }));
  const client = {
    async listTools() {
      return { tools: [
        { name: 'session_register' },
        { name: 'session_heartbeat' },
        { name: 'session_unregister' },
        { name: 'session_list' },
        { name: 'session_send' },
      ] };
    },
    async callTool(name: string, args: any) {
      calls.push({ name, args });
      if (name === 'session_register') return toolResult({ session: { sessionKey: args.sessionKey } });
      if (name === 'session_heartbeat') return toolResult({ updated: true });
      if (name === 'session_unregister') return toolResult({ deleted: true });
      if (name === 'session_list') return toolResult({ sessions });
      if (name === 'session_send') return toolResult({ accepted: 1 });
      return { isError: true, content: [{ type: 'text', text: 'unknown tool' }] };
    },
  } as any;
  const handle = await attachFederation({
    mcpClient: client,
    sessionKey: 'remote:overflow:self',
    workspaceRoot: '/repos/sender',
    intervalMs: 60_000,
    inboxIntervalMs: 60_000,
  });
  try {
    const receipts = await handle.broadcastText('must not partially fan out', 'desktop');
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]?.accepted, false);
    if (!receipts[0]?.accepted) assert.equal(receipts[0]?.reason, 'fanout_limit');
    assert.equal(calls.some((call) => call.name === 'session_send'), false);
  } finally {
    await handle.stop();
  }
});
