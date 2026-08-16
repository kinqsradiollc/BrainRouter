/**
 * ADR-034 CLI live-session rebind regressions. They drive the production
 * session-transition helper and stable federation facade, pinning old-address
 * isolation, exact outbound identity, durable peer deferral/recovery, metadata
 * switching, rollback, and a truthful recoverable detached state.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import {
  discoverLocalSessionRoutes,
  approveHeldSessionMessage,
  getSessionMeta,
  holdSessionMessage,
  listHeldSessionMessages,
  sendLocalSessionMessage,
  setSessionMeta,
  startLocalSessionTransport,
} from '@kinqs/brainrouter-core/session';
import { transitionLogicalSession, tryHandleSessionCommand } from '../cli/commands/session/index.js';
import { attachFederation } from '../runtime/federation/federationRegistration.js';

const ORIGINAL_HOME = process.env.BRAINROUTER_HOME;
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-session-rebind-'));
process.env.BRAINROUTER_HOME = path.join(TEST_ROOT, 'home');
after(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.BRAINROUTER_HOME;
  else process.env.BRAINROUTER_HOME = ORIGINAL_HOME;
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

function toolResult(payload: unknown) {
  return { isError: false, content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function remoteClient(extra: {
  tools?: string[];
  callTool?: (name: string, args: Record<string, unknown>) => Promise<unknown> | unknown;
  subscribe?: (listener: (wake: { sessionKey: string; messageIds: string[] }) => void | Promise<void>) => () => void;
} = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const tools = extra.tools ?? ['session_register', 'session_heartbeat', 'session_unregister', 'session_list'];
  const client = {
    listTools: async () => ({ tools: tools.map((name) => ({ name })) }),
    callTool: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (extra.callTool) {
        const custom = await extra.callTool(name, args);
        if (custom !== undefined) return custom;
      }
      if (name === 'session_register') return toolResult({ session: { sessionKey: args.sessionKey } });
      if (name === 'session_heartbeat') return toolResult({ updated: true });
      if (name === 'session_unregister') return toolResult({ deleted: true });
      if (name === 'session_list') return toolResult({ sessions: [] });
      return { isError: true, content: [{ type: 'text', text: 'unknown tool' }] };
    },
    ...(extra.subscribe ? { subscribeSessionMessageWakes: extra.subscribe } : {}),
  } as any;
  return { client, calls };
}

function fakeAgent(workspaceRoot: string, initialSessionKey: string) {
  let federationSessionKey = initialSessionKey;
  const pending: any[] = [];
  const agent: any = {
    workspaceRoot,
    sessionKey: initialSessionKey,
    getFederationSessionKey: () => federationSessionKey,
    setFederationSessionKey: (key: string) => { federationSessionKey = key; },
    consumePendingSteering: () => pending.splice(0, pending.length),
    requestSteer: (text: string, options: any) => {
      pending.push({
        id: options.id,
        text,
        source: options.source,
        createdAt: options.createdAt,
        sender: options.sender,
        expiresAt: options.expiresAt,
      });
    },
    pending,
  };
  return agent;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('timed out waiting for asynchronous federation delivery');
}

test('production session transition stops A before B, isolates old address, switches metadata, and recovers A peer input only on A resume', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(TEST_ROOT, 'live-'));
  const sessionA = 'cli:live-a';
  const sessionB = 'cli:live-b';
  const targetKey = 'cli:outbound-target';
  const senderKey = 'cli:inbound-sender';
  setSessionMeta(workspaceRoot, sessionA, { title: 'Session A', titleSource: 'human' });
  setSessionMeta(workspaceRoot, sessionB, { title: 'Session B', titleSource: 'hook' });
  const { client, calls } = remoteClient();
  const agent = fakeAgent(workspaceRoot, sessionA);
  const pendingExpiresAt = Date.now() + 60_000;
  agent.requestSteer('defer me on A', {
    id: 'pending-on-a', source: 'peer-session', createdAt: Date.now(),
    expiresAt: pendingExpiresAt,
    sender: {
      sessionKey: 'cli:sender-a',
      deviceId: '11111111-1111-4111-8111-111111111111',
      sentAt: Date.now() - 1,
      transport: 'remote',
    },
  });
  const observedInbound: Array<{ participant: string; id: string }> = [];
  const federation = await attachFederation({
    mcpClient: client,
    sessionKey: sessionA,
    workspaceRoot,
    intervalMs: 60_000,
    inboxIntervalMs: 60_000,
    title: 'Session A',
    titleSource: 'human',
    onPeerMessage: (message) => {
      observedInbound.push({ participant: agent.sessionKey, id: message.id });
      agent.requestSteer(message.text, {
        id: message.id,
        source: 'peer-session',
        createdAt: message.receivedAt,
        sender: {
          sessionKey: message.senderSessionKey,
          deviceId: message.senderDeviceId,
          sentAt: message.createdAt,
          transport: 'local',
        },
      });
      return 'queued';
    },
  });
  const ctx = { agent, repl: { federation } } as any;
  const target = await startLocalSessionTransport({
    sessionKey: targetKey,
    clientKind: 'cli',
    state: 'idle',
    workspaceRoot,
  });
  const sender = await startLocalSessionTransport({
    sessionKey: senderKey,
    clientKind: 'cli',
    state: 'idle',
    workspaceRoot,
  });
  try {
    await transitionLogicalSession(ctx, sessionB, () => { agent.sessionKey = sessionB; });
    assert.equal(agent.getFederationSessionKey(), sessionB);
    assert.equal(federation.sessionKey, sessionB);
    const unregisterA = calls.findIndex((call) => call.name === 'session_unregister' && call.args.sessionKey === sessionA);
    const registerB = calls.findIndex((call) => call.name === 'session_register' && call.args.sessionKey === sessionB);
    assert.ok(unregisterA >= 0 && registerB > unregisterA, 'A unregister completes before B registers');
    const routeB = (await discoverLocalSessionRoutes()).find((route) => route.sessionKey === sessionB);
    assert.equal(routeB?.title, 'Session B');
    assert.equal(agent.pending.some((input: any) => input.id === 'pending-on-a'), false);
    const deferredA = listHeldSessionMessages(workspaceRoot, sessionA, { status: 'approved' })
      .find((record) => record.id === 'pending-on-a' && record.appliedAt === undefined);
    assert.equal(deferredA?.expiresAt, pendingExpiresAt,
      'switch deferral must preserve the Brain-owned absolute deadline');

    const oldReceipt = await sendLocalSessionMessage(sessionA, {
      id: 'to-old-a', senderSessionKey: senderKey, text: 'must not reach B', createdAt: Date.now(),
    });
    assert.equal(oldReceipt.queued, false);
    const newReceipt = await sendLocalSessionMessage(sessionB, {
      id: 'to-new-b', senderSessionKey: senderKey, text: 'for B', createdAt: Date.now(),
    });
    assert.equal(newReceipt.queued, true);
    await waitFor(() => observedInbound.some((entry) => entry.id === 'to-new-b'));
    assert.deepEqual(observedInbound.find((entry) => entry.id === 'to-new-b'), {
      participant: sessionB,
      id: 'to-new-b',
    });

    const outbound = await federation.sendMessage({
      targetSessionKey: targetKey,
      kind: 'text',
      payload: { text: 'outbound from B' },
      localText: 'outbound from B',
    });
    assert.equal(outbound.accepted, true);
    assert.equal(target.drain().messages[0]?.senderSessionKey, sessionB);

    await transitionLogicalSession(ctx, sessionA, () => { agent.sessionKey = sessionA; });
    assert.equal(agent.pending.some((input: any) => input.id === 'pending-on-a'), true,
      'A approval recovers only when the exact A address resumes');
    assert.equal(agent.pending.find((input: any) => input.id === 'pending-on-a')?.expiresAt, pendingExpiresAt,
      'approval recovery must preserve the deadline into Agent pending steering');
    assert.equal(agent.pending.some((input: any) => input.id === 'to-new-b'), false,
      'B input was durably deferred to B instead of crossing into A');
  } finally {
    await federation.stop();
    await target.close();
    await sender.close();
  }
});

test('delayed A wake/poll settles only against A before the Agent transition and cannot enter B', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(TEST_ROOT, 'delayed-'));
  const sessionA = 'cli:delayed-a';
  const sessionB = 'cli:delayed-b';
  let wake: ((event: { sessionKey: string; messageIds: string[] }) => void | Promise<void>) | undefined;
  let releaseRead!: (value: unknown) => void;
  let markReadStarted!: () => void;
  const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve; });
  const delayedRead = new Promise<unknown>((resolve) => { releaseRead = resolve; });
  const { client } = remoteClient({
    tools: ['session_register', 'session_heartbeat', 'session_unregister', 'session_inbox_read'],
    subscribe: (listener) => { wake = listener; return () => { wake = undefined; }; },
    callTool: (name) => {
      if (name === 'session_inbox_read') {
        markReadStarted();
        return delayedRead;
      }
      return undefined;
    },
  });
  const observed: string[] = [];
  let activeSession = sessionA;
  const federation = await attachFederation({
    mcpClient: client,
    sessionKey: sessionA,
    workspaceRoot,
    intervalMs: 60_000,
    inboxIntervalMs: 60_000,
    onPeerMessage: () => { observed.push(activeSession); return 'queued'; },
  });
  try {
    const stalePoll = Promise.resolve(wake?.({ sessionKey: sessionA, messageIds: ['delayed-a-row'] }));
    await readStarted;
    const rebound = federation.rebindSession(sessionB, () => { activeSession = sessionB; });
    releaseRead(toolResult({ messages: [{
      id: 'delayed-a-row', fromSessionKey: 'cli:sender', toSessionKey: sessionA,
      kind: 'text', payload: { text: 'late A content' }, createdAt: new Date().toISOString(),
    }] }));
    await stalePoll;
    await rebound;
    assert.deepEqual(observed, [sessionA],
      'quiescent stop finishes already-acknowledged A work before the transition callback mutates the Agent');
    assert.equal(observed.includes(sessionB), false);
    assert.equal(federation.sessionKey, sessionB);
  } finally {
    await federation.stop();
  }
});

test('transition failure restores A; B attachment failure is detached truthfully and can retry', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(TEST_ROOT, 'rollback-'));
  const sessionA = 'cli:rollback-a';
  const sessionB = 'cli:rollback-b';
  const { client } = remoteClient();
  const agent = fakeAgent(workspaceRoot, sessionA);
  let failSessionBAttach = false;
  const federation = await attachFederation({
    mcpClient: client,
    sessionKey: sessionA,
    workspaceRoot,
    intervalMs: 60_000,
    inboxIntervalMs: 60_000,
    startLocalTransport: async (options) => {
      if (failSessionBAttach && options.sessionKey === sessionB) {
        throw new Error('synthetic B listener attachment failure');
      }
      return startLocalSessionTransport(options);
    },
  });
  const ctx = { agent, repl: { federation } } as any;
  try {
    agent.requestSteer('recover on rollback', {
      id: 'rollback-pending-a', source: 'peer-session', createdAt: Date.now(),
      sender: {
        sessionKey: 'cli:rollback-sender',
        deviceId: '22222222-2222-4222-8222-222222222222',
        sentAt: Date.now() - 1,
        transport: 'remote',
      },
    });
    await assert.rejects(
      transitionLogicalSession(ctx, sessionB, async () => { throw new Error('transition failed'); }),
      /transition failed/,
    );
    assert.equal(federation.sessionKey, sessionA);
    assert.equal((await discoverLocalSessionRoutes()).some((route) => route.sessionKey === sessionA), true);
    assert.equal(agent.pending.some((input: any) => input.id === 'rollback-pending-a'), true,
      'rollback immediately recovers A-addressed approved input into A');

    failSessionBAttach = true;
    await assert.rejects(
      transitionLogicalSession(ctx, sessionB, () => { agent.sessionKey = sessionB; }),
      /synthetic B listener attachment failure/i,
    );
    assert.equal(agent.sessionKey, sessionB);
    assert.equal(agent.getFederationSessionKey(), sessionB);
    assert.equal(federation.sessionKey, sessionB, 'facade reports the Agent identity, never stale A');
    await assert.rejects(federation.discoverSessions(), /detached/i);
    assert.equal((await discoverLocalSessionRoutes()).some((route) => route.sessionKey === sessionA), false);

    failSessionBAttach = false;
    await federation.rebindSession(sessionB, () => undefined);
    assert.equal((await federation.discoverSessions()).routes.some((route) => route.sessionKey === sessionB), true);
  } finally {
    await federation.stop();
  }
});

test('/rename changes only human display metadata and preserves the exact address and pending input', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(TEST_ROOT, 'rename-'));
  const sessionKey = 'cli:rename-stable';
  const agent = fakeAgent(workspaceRoot, sessionKey);
  agent.refreshSystemPrompt = () => undefined;
  agent.requestSteer('keep pending', {
    id: 'rename-pending', source: 'user', createdAt: Date.now(),
  });
  const registrations: Array<Record<string, unknown>> = [];
  const federation: any = {
    sessionKey,
    updateRegistration: async (patch: Record<string, unknown>) => {
      registrations.push(patch);
      return {};
    },
    rebindSession: async () => { throw new Error('/rename must not rebind'); },
  };
  const ctx: any = {
    command: '/rename', args: ['Release', 'readiness'], agent,
    mcpClient: {}, config: {}, rl: {}, repl: { federation },
  };

  assert.equal(await tryHandleSessionCommand(ctx), true);
  assert.equal(agent.sessionKey, sessionKey);
  assert.equal(agent.getFederationSessionKey(), sessionKey);
  assert.equal(agent.pending.some((input: any) => input.id === 'rename-pending'), true);
  assert.deepEqual(getSessionMeta(workspaceRoot, sessionKey), {
    title: 'Release readiness',
    titleSource: 'human',
  });
  assert.deepEqual(registrations, [{ title: 'Release readiness', titleSource: 'human' }]);
});

test('/new repeated label always mints a fresh address and never reclaims the old inbox', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(TEST_ROOT, 'new-unique-'));
  const agent = fakeAgent(workspaceRoot, 'cli:starting-address');
  agent.endSession = async () => undefined;
  agent.resetSessionCounters = () => undefined;
  agent.clearHistory = () => { agent.pending.splice(0, agent.pending.length); };
  const registrations: Array<{ key: string; title?: string; titleSource?: string }> = [];
  const federation: any = {
    sessionKey: agent.sessionKey,
    rebindSession: async (nextKey: string, transition: () => void | Promise<void>, meta: any) => {
      await transition();
      federation.sessionKey = nextKey;
      registrations.push({ key: nextKey, ...meta });
    },
  };
  const ctx: any = {
    command: '/new', args: ['Repeated', 'label'], agent,
    mcpClient: {}, config: {}, rl: {}, repl: { federation },
  };

  await tryHandleSessionCommand(ctx);
  const firstKey = agent.sessionKey;
  const now = Date.now();
  holdSessionMessage(workspaceRoot, {
    id: 'old-new-inbox',
    senderSessionKey: 'cli:sender',
    senderDeviceId: '33333333-3333-4333-8333-333333333333',
    targetSessionKey: firstKey,
    text: 'belongs only to the first new conversation',
    createdAt: now - 1,
    receivedAt: now,
    source: 'peer-session',
    trust: 'untrusted-session',
  }, 'Deferred old inbox.');
  approveHeldSessionMessage(workspaceRoot, firstKey, 'old-new-inbox');

  await tryHandleSessionCommand(ctx);
  const secondKey = agent.sessionKey;
  assert.notEqual(secondKey, firstKey);
  assert.match(firstKey, /^cli:new:[0-9a-f]{8}$/);
  assert.match(secondKey, /^cli:new:[0-9a-f]{8}$/);
  assert.equal(getSessionMeta(workspaceRoot, firstKey).title, 'Repeated label');
  assert.equal(getSessionMeta(workspaceRoot, secondKey).title, 'Repeated label');
  assert.equal(agent.pending.some((input: any) => input.id === 'old-new-inbox'), false);
  assert.equal(listHeldSessionMessages(workspaceRoot, firstKey, { status: 'approved' }).length, 1);
  assert.equal(listHeldSessionMessages(workspaceRoot, secondKey).length, 0);
  assert.deepEqual(registrations.map((entry) => entry.titleSource), ['human', 'human']);
});
