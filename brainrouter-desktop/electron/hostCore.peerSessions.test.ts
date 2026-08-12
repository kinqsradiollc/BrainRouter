/**
 * ADR-034 Desktop HostCore regressions: peer content uses typed safe-boundary
 * steering, while title callbacks update only the exact active participant.
 * Protocol events never bypass recipient authority or a session generation.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InteractionBroker, type AgentEventMessage } from '@kinqs/brainrouter-agent-protocol';
import type {
  LocalSessionMessage,
  LocalSessionTransportHandle,
  PeerSessionSender,
  SteeringInput,
} from '@kinqs/brainrouter-core/session';
import { createBrokerPort, createHostCore, type AgentLike } from './hostCore.js';
import { DesktopSessionMessaging } from './host/sessionMessaging.js';

class PeerAgent implements AgentLike {
  sessionKey = 'desktop:recipient';
  interrupts = 0;
  prompts: Array<{ text: string; hidden: boolean }> = [];
  pending: SteeringInput[] = [];
  accepted: SteeringInput[] = [];

  get pendingSteeringCount(): number { return this.pending.length; }

  requestInterrupt(): void { this.interrupts += 1; }

  requestPeerSessionSteer(
    message: LocalSessionMessage,
    sender: Partial<Omit<PeerSessionSender, 'sessionKey' | 'deviceId' | 'sentAt'>> = {},
  ): SteeringInput {
    const input: SteeringInput = {
      id: message.id,
      text: message.text,
      source: 'peer-session',
      createdAt: message.createdAt,
      expiresAt: message.expiresAt,
      sender: { sessionKey: message.senderSessionKey, deviceId: message.senderDeviceId, sentAt: message.createdAt, ...sender },
    };
    this.pending.push(input);
    this.accepted.push(input);
    return input;
  }

  consumePendingSteering(): SteeringInput[] {
    const pending = this.pending;
    this.pending = [];
    return pending;
  }

  async runTurn(prompt: string, _callbacks: unknown, options?: { hiddenPrompt?: boolean }): Promise<string> {
    this.prompts.push({ text: prompt, hidden: options?.hiddenPrompt === true });
    // beginLoop consumes the typed peer queue before the model call.
    this.pending = [];
    return 'Peer observation processed.';
  }
}

test('idle peer delivery uses typed steering and a hidden wake without interrupting or rendering peer text as user', async () => {
  const agent = new PeerAgent();
  const events: AgentEventMessage[] = [];
  const core = createHostCore({ agent, send: (message) => events.push(message) });
  const message: LocalSessionMessage = {
    id: 'inbox-1', senderSessionKey: 'cli:sender', senderDeviceId: '11111111-1111-4111-8111-111111111111',
    targetSessionKey: agent.sessionKey, text: 'Inspect the failed release check.',
    createdAt: Date.now(), receivedAt: Date.now(), source: 'peer-session', trust: 'untrusted-session',
  };

  const result = core.deliverPeerMessage(message, {
    sessionKey: message.senderSessionKey,
    deviceId: message.senderDeviceId,
    clientKind: 'cli',
    title: 'Release verifier',
    workspaceRoot: '/repos/release',
    transport: 'local',
    sentAt: message.createdAt,
  });
  assert.deepEqual(result, { accepted: true, state: 'steered' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(agent.interrupts, 0);
  assert.equal(agent.prompts.length, 1);
  assert.equal(agent.prompts[0]?.hidden, true);
  assert.notEqual(agent.prompts[0]?.text, message.text);
  assert.deepEqual(
    agent.accepted[0]?.source === 'peer-session' ? agent.accepted[0].sender : undefined,
    {
      sessionKey: 'cli:sender',
      deviceId: message.senderDeviceId,
      clientKind: 'cli',
      title: 'Release verifier',
      workspaceRoot: '/repos/release',
      transport: 'local',
      sentAt: message.createdAt,
    },
  );
  const peerEvent = events.find((entry) => entry.event.kind === 'input-delivery' && entry.event.source === 'peer-session');
  assert.ok(peerEvent);
  if (peerEvent?.event.kind === 'input-delivery') {
    assert.equal(peerEvent.event.sender?.sessionKey, 'cli:sender');
    assert.equal(peerEvent.event.sender?.transport, 'local');
  }
  assert.equal(events.some((entry) => entry.event.kind === 'turn-start' && entry.event.prompt === message.text), false);
});

test('late peer follow-up preserves its absolute deadline and expires before hidden-turn application', async () => {
  const events: AgentEventMessage[] = [];
  const expired: Array<{ sessionKey: string; id: string }> = [];
  const startedAt = Date.now();
  const deadline = startedAt + 10;
  let turns = 0;
  let requeuedDeadline: number | undefined;
  let pending: SteeringInput[] = [{
    id: 'late-peer-deadline',
    text: 'Do not renew this observation.',
    source: 'peer-session',
    createdAt: startedAt,
    expiresAt: deadline,
    sender: {
      sessionKey: 'cli:deadline-sender',
      deviceId: '11111111-1111-4111-8111-111111111111',
      sentAt: startedAt,
      transport: 'remote',
    },
  }];
  const agent: AgentLike = {
    sessionKey: 'desktop:late-deadline',
    get pendingSteeringCount() { return pending.length; },
    consumePendingSteering: () => {
      const consumed = pending;
      pending = [];
      return consumed;
    },
    requestPeerSessionSteer: (message, sender = {}) => {
      requeuedDeadline = message.expiresAt;
      const input: SteeringInput = {
        id: message.id,
        text: message.text,
        source: 'peer-session',
        createdAt: message.receivedAt,
        expiresAt: message.expiresAt,
        sender: {
          sessionKey: message.senderSessionKey,
          deviceId: message.senderDeviceId,
          sentAt: message.createdAt,
          ...sender,
        },
      };
      pending.push(input);
      return input;
    },
    runTurn: async (_prompt, callbacks: any) => {
      turns += 1;
      if (turns === 2) {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        const input = pending.shift();
        if (input?.source === 'peer-session') callbacks.onSteerExpired(input);
      }
      return 'No stale peer content applied.';
    },
  };
  const core = createHostCore({
    agent,
    send: (message) => events.push(message),
    onPeerSteerExpired: (sessionKey, input) => expired.push({ sessionKey, id: input.id }),
  });

  await core.handle({ kind: 'start-turn', prompt: 'finish the active turn' });
  for (let index = 0; index < 50 && expired.length === 0; index += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(requeuedDeadline, deadline,
    'late-finalization requeue must not restart the remote absolute deadline');
  assert.deepEqual(expired, [{ sessionKey: agent.sessionKey, id: 'late-peer-deadline' }]);
  assert.equal(events.some((message) =>
    message.event.kind === 'input-delivery'
    && message.event.id === 'late-peer-deadline'
    && message.event.state === 'applied'), false);
});

test('HostCore forwards Core safe-boundary peer expiry without claiming application', async () => {
  const events: AgentEventMessage[] = [];
  const expired: Array<{ sessionKey: string; id: string }> = [];
  const agent: AgentLike = {
    sessionKey: 'desktop:expiry-callback',
    runTurn: async (_prompt, callbacks: any) => {
      callbacks.onSteerExpired({
        id: 'expired-at-boundary',
        text: 'Must never reach model history.',
        source: 'peer-session',
        createdAt: Date.now() - 24 * 60 * 60 * 1_000 - 1,
        sender: {
          sessionKey: 'cli:sender',
          deviceId: '11111111-1111-4111-8111-111111111111',
        },
      });
      return 'No peer content applied.';
    },
  };
  const core = createHostCore({
    agent,
    send: (message) => events.push(message),
    onPeerSteerExpired: (sessionKey, input) => expired.push({ sessionKey, id: input.id }),
  });

  await core.handle({ kind: 'start-turn', prompt: 'safe boundary' });
  assert.deepEqual(expired, [{ sessionKey: agent.sessionKey, id: 'expired-at-boundary' }]);
  assert.equal(events.some((message) =>
    message.event.kind === 'input-delivery'
    && message.event.id === 'expired-at-boundary'
    && message.event.state === 'expired'), true);
  assert.equal(events.some((message) =>
    message.event.kind === 'input-delivery'
    && message.event.id === 'expired-at-boundary'
    && message.event.state === 'applied'), false);
});

function titleTransport(
  sessionKey: string,
  updates: Array<{ sessionKey: string; title?: string; titleSource?: string }>,
): LocalSessionTransportHandle {
  let state: 'idle' | 'working' | 'waiting' = 'idle';
  let title: string | undefined;
  return {
    host: '127.0.0.1',
    port: 49152,
    registration: () => ({
      sessionKey,
      deviceId: '11111111-1111-4111-8111-111111111111',
      clientKind: 'desktop', state, transport: 'local', lastSeenAt: Date.now(),
      ...(title ? { title } : {}),
    }),
    pendingCount: () => 0,
    drain: () => ({ messages: [], expired: [], expiredOmitted: 0 }),
    acceptPeerMessage: (input) => ({
      queued: false, status: 'not_queued', transport: 'local',
      targetSessionKey: sessionKey, messageId: input.id, reason: 'rejected',
    }),
    updateRegistration: (patch) => {
      state = patch.state ?? state;
      if (patch.title !== undefined) title = patch.title;
      updates.push({ sessionKey, ...(patch.title !== undefined ? { title: patch.title } : {}) });
      return {
        sessionKey,
        deviceId: '11111111-1111-4111-8111-111111111111',
        clientKind: 'desktop', state, transport: 'local', lastSeenAt: Date.now(),
        ...(title ? { title } : {}),
      };
    },
    close: async () => undefined,
  };
}

function toolResult(payload: unknown): unknown {
  return { isError: false, content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

test('HostCore derived/agent title events publish to active Desktop registration and stale session events are ignored', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'br-desktop-title-chain-'));
  const localUpdates: Array<{ sessionKey: string; title?: string; titleSource?: string }> = [];
  const remoteCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const activeA = { sessionKey: 'desktop:title-a', getAccessMode: () => 'read' as const };
  const activeB = { sessionKey: 'desktop:title-b', getAccessMode: () => 'read' as const };
  const service = new DesktopSessionMessaging({
    workspaceRoot,
    mcp: {
      getActiveBrainrouterServerId: () => 'brainrouter',
      callTool: async (name, args) => {
        remoteCalls.push({ name, args });
        if (name === 'session_register') return toolResult({ session: { sessionKey: args.sessionKey } });
        if (name === 'session_list') return toolResult({ sessions: [] });
        if (name === 'session_inbox_read') return toolResult({ messages: [] });
        return toolResult({ updated: true, deleted: true });
      },
    },
    getActiveAgent: () => activeA,
    deliverPeer: () => ({ accepted: true, state: 'steered' }),
    confirmHeld: async () => null,
    pollIntervalMs: 60_000,
    local: {
      start: async (options) => titleTransport(options.sessionKey, localUpdates),
      discover: async () => [],
      send: async (key, input) => ({ queued: false, status: 'not_queued', transport: 'local', targetSessionKey: key, messageId: input.id!, reason: 'not_found' }),
      deviceId: () => '11111111-1111-4111-8111-111111111111',
    },
  });
  try {
    await service.start(activeA);
    let delayedCallbacks: any;
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((resolve) => { releaseTurn = resolve; });
    const agent: AgentLike = {
      sessionKey: activeA.sessionKey,
      runTurn: async (_prompt, callbacks: any) => {
        callbacks.onSessionTitle({ title: 'Derived first turn', source: 'derived' });
        callbacks.onSessionTitle({ title: 'Agent release title', source: 'agent' });
        delayedCallbacks = callbacks;
        await turnGate;
        return 'done';
      },
    };
    const core = createHostCore({
      agent,
      send: () => undefined,
      onSessionTitle: (sessionKey, title, source) => service.setTitle(sessionKey, title, source),
    });
    const running = core.handle({ kind: 'start-turn', prompt: 'first title' });
    while (!delayedCallbacks) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(localUpdates.some((update) => update.sessionKey === activeA.sessionKey && update.title === 'Derived first turn'), true);
    assert.equal(localUpdates.some((update) => update.sessionKey === activeA.sessionKey && update.title === 'Agent release title'), true);
    await service.refreshRemote();

    await service.activate(activeB);
    delayedCallbacks.onSessionTitle({ title: 'Stale A title', source: 'agent' });
    releaseTurn();
    await running;
    await service.refreshRemote();
    assert.equal(localUpdates.some((update) => update.sessionKey === activeB.sessionKey && update.title === 'Stale A title'), false);
    assert.equal(remoteCalls.some((call) => call.name === 'session_register' && call.args.sessionKey === activeB.sessionKey && call.args.title === 'Stale A title'), false);
    assert.equal(remoteCalls.some((call) => call.name === 'session_register' && call.args.sessionKey === activeA.sessionKey && call.args.title === 'Agent release title'), true);
  } finally {
    await service.close();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('production Desktop broker port preserves explicit approval, decline, and dismissal', async () => {
  const broker = new InteractionBroker();
  const requestIds: string[] = [];
  const port = createBrokerPort(broker, ({ request }) => requestIds.push(request.id), 1_000);

  const approved = port.confirmExplicit?.({ title: 'Apply peer message?' });
  assert.ok(approved);
  broker.resolve(requestIds.at(-1)!, { type: 'confirm', approved: true });
  assert.equal(await approved, 'approved');

  const declined = port.confirmExplicit?.({ title: 'Apply peer message?' });
  assert.ok(declined);
  broker.resolve(requestIds.at(-1)!, { type: 'confirm', approved: false });
  assert.equal(await declined, 'declined');

  const dismissed = port.confirmExplicit?.({ title: 'Apply peer message?' });
  assert.ok(dismissed);
  broker.resolve(requestIds.at(-1)!, { type: 'dismissed' });
  assert.equal(await dismissed, 'dismissed');
});

test('repeated Desktop new-session labels mint distinct exact keys and remain human titles only', async () => {
  const initial = new PeerAgent();
  initial.sessionKey = 'desktop:starting-address';
  const spawned: PeerAgent[] = [];
  const titles: Array<{ sessionKey: string; title: string; source: string }> = [];
  const events: AgentEventMessage[] = [];
  const core = createHostCore({
    agent: initial,
    send: (message) => events.push(message),
    spawnAgent: (sessionKey) => {
      const agent = new PeerAgent();
      agent.sessionKey = sessionKey;
      spawned.push(agent);
      return agent;
    },
    onSessionTitle: (sessionKey, title, source) => titles.push({ sessionKey, title, source }),
  });

  await core.handle({ kind: 'new-session', label: 'Repeated release label' });
  const firstKey = initial.sessionKey;
  initial.pending.push({
    id: 'old-address-inbox',
    text: 'Must remain with the first exact address.',
    source: 'peer-session',
    createdAt: Date.now(),
    sender: { sessionKey: 'cli:sender', deviceId: '11111111-1111-4111-8111-111111111111', sentAt: Date.now() },
  });

  await core.handle({ kind: 'new-session', label: 'Repeated release label' });
  const changed = events
    .filter((message) => message.event.kind === 'session-changed')
    .map((message) => (message.event as Extract<AgentEventMessage['event'], { kind: 'session-changed' }>).sessionKey);
  const secondKey = changed.at(-1)!;

  assert.match(firstKey, /^desktop:new-[0-9a-f-]{36}$/);
  assert.match(secondKey, /^desktop:new-[0-9a-f-]{36}$/);
  assert.notEqual(secondKey, firstKey);
  assert.equal(secondKey.includes('Repeated'), false, 'the display label never enters the exact address');
  assert.equal(initial.sessionKey, firstKey, 'the runtime holding A inbox input remains bound to A');
  assert.equal(initial.pending.some((input) => input.id === 'old-address-inbox'), true);
  assert.equal(spawned.at(-1)?.sessionKey, secondKey);
  assert.equal(spawned.at(-1)?.pending.length, 0, 'A pending inbox input never enters B');
  assert.deepEqual(titles, [
    { sessionKey: firstKey, title: 'Repeated release label', source: 'human' },
    { sessionKey: secondKey, title: 'Repeated release label', source: 'human' },
  ]);
});
