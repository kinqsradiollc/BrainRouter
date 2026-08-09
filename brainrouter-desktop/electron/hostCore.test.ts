import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrokerPort, createHostCore, isUnsavedNewSessionKey, type AgentLike } from './hostCore.js';
import { InteractionBroker } from '@kinqs/brainrouter-agent-protocol';
import type { AgentEventMessage } from '@kinqs/brainrouter-agent-protocol';
import {
  __resetExternalSteering,
  publishExternalSteering,
} from '@kinqs/brainrouter-core/session';

function fakeAgent(behavior?: (prompt: string, cb: Record<string, unknown>) => Promise<string>): AgentLike {
  return {
    sessionKey: 'sess-test',
    runTurn: behavior ?? (async (prompt, cb) => {
      (cb.onStatusUpdate as (t: string) => void)('working');
      (cb.onAssistantDelta as (t: string) => void)('hi');
      return `answer to: ${prompt}`;
    }),
  };
}

const collect = () => {
  const out: AgentEventMessage[] = [];
  return { out, send: (m: AgentEventMessage) => out.push(m) };
};

test('start-turn: streams bridged events between turn-start and turn-complete', async () => {
  const { out, send } = collect();
  const core = createHostCore({ agent: fakeAgent(), send });
  await core.handle({ kind: 'start-turn', prompt: 'do it' });
  const kinds = out.map((m) => m.event.kind);
  assert.deepEqual(kinds, ['turn-start', 'status', 'assistant-delta', 'turn-complete']);
  assert.deepEqual(out.map((m) => m.seq), [1, 2, 3, 4], 'monotonic envelope seq');
  const done = out[3].event as Extract<AgentEventMessage['event'], { kind: 'turn-complete' }>;
  assert.equal(done.answer, 'answer to: do it');
  assert.ok(out.every((m) => m.sessionKey === 'sess-test'));
});

test('start-turn: preserves the shared interrupted child receipt verbatim', async () => {
  const receipt = {
    childId: 'child-1',
    role: 'worker',
    status: 'interrupted' as const,
    completedAt: '2026-07-30T00:00:00.000Z',
    summary: 'Child execution interrupted by the parent request.',
  };
  const { out, send } = collect();
  const core = createHostCore({
    agent: fakeAgent(async (_prompt, cb) => {
      (cb.onChildComplete as (value: typeof receipt) => void)(receipt);
      return 'parent interrupted';
    }),
    send,
  });

  await core.handle({ kind: 'start-turn', prompt: 'stop' });

  const event = out.find(
    (message) => message.event.kind === 'child-complete',
  )?.event;
  assert.ok(event?.kind === 'child-complete');
  assert.deepEqual(event.receipt, receipt);
});

test('start-turn: forwards inline images to runTurn opts (vision)', async () => {
  const { send } = collect();
  let seenImages: unknown;
  const agent: AgentLike = {
    sessionKey: 'sess-img',
    runTurn: async (_p, _cb, opts) => { seenImages = opts?.images; return 'ok'; },
  };
  const core = createHostCore({ agent, send });
  await core.handle({ kind: 'start-turn', prompt: 'what is this?', images: [{ mediaType: 'image/png', dataBase64: 'AAAA' }] });
  assert.deepEqual(seenImages, [{ mediaType: 'image/png', dataBase64: 'AAAA' }]);
});

test('observeTurnEvent: receives the turn tool stream tagged with the turn sessionKey (verification scoping)', async () => {
  const { send } = collect();
  const seen: Array<{ sessionKey: string; kind: string; tool?: string; command?: unknown; callId?: string; ok?: boolean }> = [];
  const agent: AgentLike = {
    sessionKey: 'sess-A',
    runTurn: async (_p, cb) => {
      (cb.onToolStart as (t: string, a: Record<string, unknown>, id?: string) => void)('run_command', { command: 'npm test' }, 'c1');
      (cb.onToolEnd as (t: string, r: { success: boolean; summary: string }, id?: string) => void)('run_command', { success: true, summary: '12 passed' }, 'c1');
      return 'done';
    },
  };
  const core = createHostCore({
    agent,
    send,
    observeTurnEvent: (sessionKey, event) => {
      if (event.kind === 'tool-start') seen.push({ sessionKey, kind: event.kind, tool: event.tool, command: event.args?.command, callId: event.callId });
      else if (event.kind === 'tool-end') seen.push({ sessionKey, kind: event.kind, tool: event.tool, callId: event.callId, ok: event.ok });
    },
  });
  await core.handle({ kind: 'start-turn', prompt: 'run the tests' });
  const start = seen.find((s) => s.kind === 'tool-start');
  const end = seen.find((s) => s.kind === 'tool-end');
  assert.ok(start, 'observer saw tool-start');
  assert.equal(start?.sessionKey, 'sess-A', 'tagged with the turn session key (survives a later switch)');
  assert.equal(start?.tool, 'run_command');
  assert.equal(start?.command, 'npm test');
  assert.equal(start?.callId, 'c1');
  assert.equal(end?.callId, 'c1');
  assert.equal(end?.ok, true);
});

test('start-turn: a throwing turn emits turn-error and unlocks the next turn', async () => {
  const { out, send } = collect();
  let calls = 0;
  const core = createHostCore({
    agent: fakeAgent(async () => { calls++; if (calls === 1) throw new Error('boom'); return 'ok'; }),
    send,
  });
  await core.handle({ kind: 'start-turn', prompt: 'a' });
  assert.equal(out[out.length - 1].event.kind, 'turn-error');
  await core.handle({ kind: 'start-turn', prompt: 'b' });
  assert.equal(out[out.length - 1].event.kind, 'turn-complete', 'turnRunning latch released after error');
});

test('start-turn while running → turn-error (no concurrent turns)', async () => {
  const { out, send } = collect();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const core = createHostCore({
    agent: fakeAgent(async () => { await gate; return 'done'; }),
    send,
  });
  const first = core.handle({ kind: 'start-turn', prompt: 'long' });
  await core.handle({ kind: 'start-turn', prompt: 'second' });
  assert.ok(out.some((m) => m.event.kind === 'turn-error' &&
    (m.event as { message: string }).message.includes('already running')));
  release();
  await first;
});

test('Queue accepts input during a turn and runs it FIFO after the turn settles', async () => {
  const { out, send } = collect();
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const prompts: string[] = [];
  let resolveSecond!: () => void;
  const secondDone = new Promise<void>((resolve) => { resolveSecond = resolve; });
  const agent: AgentLike = {
    sessionKey: 'sess-queue',
    runTurn: async (prompt) => {
      prompts.push(prompt);
      if (prompts.length === 1) await firstGate;
      else resolveSecond();
      return `done:${prompt}`;
    },
  };
  const core = createHostCore({ agent, send });

  const first = core.handle({ kind: 'start-turn', prompt: 'first' });
  await core.handle({ kind: 'start-turn', prompt: 'second', delivery: 'queue', deliveryId: 'q1' });
  const queued = out.find((message) => message.event.kind === 'input-delivery' && message.event.id === 'q1');
  assert.ok(queued && queued.event.kind === 'input-delivery');
  assert.equal(queued.event.state, 'queued');
  assert.equal(queued.event.position, 1);

  releaseFirst();
  await first;
  await secondDone;
  assert.deepEqual(prompts, ['first', 'second']);
  assert.ok(out.some((message) =>
    message.event.kind === 'input-delivery'
    && message.event.id === 'q1'
    && message.event.state === 'running'));
});

test('Steer enters the running Agent and reports when the safe boundary applies it', async () => {
  const { out, send } = collect();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let callbacks: Record<string, unknown> = {};
  const pending: Array<{ id: string; text: string; source: 'user' | 'extension'; createdAt: number }> = [];
  const agent: AgentLike = {
    sessionKey: 'sess-steer',
    runTurn: async (_prompt, cb) => {
      callbacks = cb;
      await gate;
      const steering = pending.shift();
      if (steering) (callbacks.onSteerApplied as (input: typeof steering) => void)(steering);
      return 'done';
    },
    requestSteer: (text, options) => {
      const steering = { id: options?.id ?? 'generated', text, source: options?.source ?? 'user', createdAt: Date.now() };
      pending.push(steering);
      return steering;
    },
    consumePendingSteering: () => pending.splice(0),
    get pendingSteeringCount() { return pending.length; },
  };
  const core = createHostCore({ agent, send });

  const first = core.handle({ kind: 'start-turn', prompt: 'first' });
  await core.handle({ kind: 'start-turn', prompt: 'new direction', delivery: 'steer', deliveryId: 's1' });
  assert.ok(out.some((message) =>
    message.event.kind === 'input-delivery'
    && message.event.id === 's1'
    && message.event.state === 'steered'));
  release();
  await first;
  assert.ok(out.some((message) =>
    message.event.kind === 'input-delivery'
    && message.event.id === 's1'
    && message.event.state === 'applied'));
});

test('extension results steer a running desktop session without blocking it', async () => {
  __resetExternalSteering();
  const { out, send } = collect();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const received: Array<{ text: string; source?: string }> = [];
  const agent: AgentLike = {
    sessionKey: 'sess-extension-running',
    runTurn: async () => { await gate; return 'done'; },
    requestSteer: (text, options) => {
      received.push({ text, source: options?.source });
      return {
        id: options?.id ?? 'generated',
        text,
        source: options?.source ?? 'user',
        createdAt: Date.now(),
      };
    },
  };
  const core = createHostCore({ agent, send });

  const turn = core.handle({ kind: 'start-turn', prompt: 'keep coding' });
  publishExternalSteering('sess-extension-running', 'CI failed', { id: 'ci-failed-1' });

  assert.deepEqual(received, [{ text: 'CI failed', source: 'extension' }]);
  assert.ok(out.some((message) =>
    message.event.kind === 'input-delivery'
    && message.event.id === 'ci-failed-1'
    && message.event.state === 'steered'
    && message.event.source === 'extension'));

  release();
  await turn;
  await core.handle({ kind: 'shutdown' });
  __resetExternalSteering();
});

test('extension results start an idle desktop follow-up with visible delivery state', async () => {
  __resetExternalSteering();
  const { out, send } = collect();
  let resolveTurn!: () => void;
  const turnStarted = new Promise<void>((resolve) => { resolveTurn = resolve; });
  const prompts: string[] = [];
  const agent: AgentLike = {
    sessionKey: 'sess-extension-idle',
    runTurn: async (prompt) => {
      prompts.push(prompt);
      resolveTurn();
      return 'handled';
    },
  };
  const core = createHostCore({ agent, send });

  publishExternalSteering('sess-extension-idle', 'A reviewer requested changes', { id: 'review-1' });
  await turnStarted;

  assert.deepEqual(prompts, ['A reviewer requested changes']);
  assert.ok(out.some((message) =>
    message.event.kind === 'input-delivery'
    && message.event.id === 'review-1'
    && message.event.source === 'extension'));

  await core.handle({ kind: 'shutdown' });
  __resetExternalSteering();
});

test('DESK-5q resume during a running turn is deferred until the turn unwinds', async () => {
  const { out, send } = collect();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let interrupted = false;
  const agent: AgentLike = {
    sessionKey: 'sess:A',
    runTurn: async () => { await gate; return 'done-A'; },
    requestInterrupt: () => { interrupted = true; },
    resetSessionCounters: () => {},
    loadHistory: () => 7,
    getModel: () => 'm',
  };
  const core = createHostCore({ agent, send, loadTranscript: () => [{ role: 'user', content: 'hi' }] });

  const first = core.handle({ kind: 'start-turn', prompt: 'long A' });
  // switch to B while A is still running
  await core.handle({ kind: 'resume-session', sessionKey: 'sess:B' });

  // The switch must NOT have applied yet: agent still on A, no session-changed,
  // interrupt requested, and a "stopping…" status surfaced.
  assert.equal(agent.sessionKey, 'sess:A', 'agent.sessionKey not swapped mid-turn');
  assert.ok(interrupted, 'running turn was interrupted');
  assert.ok(!out.some((m) => m.event.kind === 'session-changed'), 'no session-changed before the turn ends');
  assert.ok(out.some((m) => m.event.kind === 'status' && /Stopping the current turn/.test((m.event as { text: string }).text)));

  release();
  await first;

  // Now the deferred switch has applied.
  assert.equal(agent.sessionKey, 'sess:B', 'deferred switch applied after the turn ended');
  const sc = out.find((m) => m.event.kind === 'session-changed');
  assert.ok(sc && (sc.event as { sessionKey: string }).sessionKey === 'sess:B');
});

test('DESK-5v concurrent sessions: a mid-turn switch spawns a second agent and never stops the first', async () => {
  const { out, send } = collect();
  let releaseA!: () => void, releaseB!: () => void;
  const gateA = new Promise<void>((r) => { releaseA = r; });
  const gateB = new Promise<void>((r) => { releaseB = r; });
  let interruptedA = false;
  const agentA: AgentLike = {
    sessionKey: 'sess:A',
    runTurn: async (_p, cb) => { (cb.onAssistantDelta as (t: string) => void)('A'); await gateA; return 'done-A'; },
    requestInterrupt: () => { interruptedA = true; },
    resetSessionCounters: () => {}, loadHistory: () => 3, getModel: () => 'm',
  };
  const agentB: AgentLike = {
    sessionKey: 'sess:spawn',
    runTurn: async (_p, cb) => { (cb.onAssistantDelta as (t: string) => void)('B'); await gateB; return 'done-B'; },
    resetSessionCounters: () => {}, loadHistory: () => 5, getModel: () => 'm', clearHistory: () => {},
  };
  const core = createHostCore({
    agent: agentA, send,
    spawnAgent: () => agentB, // a second session gets its own agent
    loadTranscript: (k) => (k === 'sess:B' ? [{ role: 'user', content: 'hi' }] : []),
  });

  const firstA = core.handle({ kind: 'start-turn', prompt: 'long A' }); // A running
  await core.handle({ kind: 'resume-session', sessionKey: 'sess:B' });   // switch mid-turn

  assert.equal(interruptedA, false, 'switching sessions did NOT stop the running turn');
  assert.equal(agentA.sessionKey, 'sess:A', 'the running agent keeps its own session/history');
  assert.equal(agentB.sessionKey, 'sess:B', 'the spawned agent took the switched-to session');
  const scB = out.find((m) => m.event.kind === 'session-changed' && (m.event as { sessionKey: string }).sessionKey === 'sess:B');
  assert.ok(scB, 'session-changed to B emitted immediately, while A is still running');

  // Start a turn in B — runs concurrently, no "already running" rejection.
  const firstB = core.handle({ kind: 'start-turn', prompt: 'long B' });
  assert.ok(!out.some((m) => m.event.kind === 'turn-error'), 'a concurrent turn in another session is allowed');

  releaseA(); releaseB();
  await Promise.all([firstA, firstB]);

  const completes = out.filter((m) => m.event.kind === 'turn-complete');
  assert.deepEqual(completes.map((m) => m.sessionKey).sort(), ['sess:A', 'sess:B'], 'both sessions completed, each tagged with its own key');
  assert.ok(out.some((m) => m.sessionKey === 'sess:A' && m.event.kind === 'assistant-delta'), "A's stream stayed tagged A");
  assert.ok(out.some((m) => m.sessionKey === 'sess:B' && m.event.kind === 'assistant-delta'), "B's stream stayed tagged B");
});

test('ADR-032 D5: a background session fires its session-end checkpoint when its agent is dropped', async () => {
  // The desktop pool discards a finished BACKGROUND agent; that is where the
  // session actually ends on this surface. Without this the CLI's `/exit` was
  // the only place D5 ever ran, so a desktop-only user never learned anything
  // from a session that ended without a compaction.
  const { out, send } = collect();
  let releaseA!: () => void;
  let releaseB!: () => void;
  const gateA = new Promise<void>((r) => { releaseA = r; });
  const gateB = new Promise<void>((r) => { releaseB = r; });
  let endedB = 0;
  const agentA: AgentLike = {
    sessionKey: 'sess:A',
    runTurn: async () => { await gateA; return 'done-A'; },
    resetSessionCounters: () => {}, loadHistory: () => 1, getModel: () => 'm', clearHistory: () => {},
  };
  const agentB: AgentLike = {
    sessionKey: 'sess:spawn',
    runTurn: async () => { await gateB; return 'done-B'; },
    resetSessionCounters: () => {}, loadHistory: () => 1, getModel: () => 'm',
    clearHistory: () => {}, endSession: () => { endedB += 1; },
  };
  const core = createHostCore({
    agent: agentA, send, spawnAgent: () => agentB,
    transcriptExists: (k) => k === 'sess:A' || k === 'sess:B',
  });
  // A is busy, so switching spawns a SECOND agent for B rather than reusing A.
  const turnA = core.handle({ kind: 'start-turn', prompt: 'long A' });
  await core.handle({ kind: 'resume-session', sessionKey: 'sess:B' });
  const turnB = core.handle({ kind: 'start-turn', prompt: 'long B' });
  // Look away: B keeps running, but it is now a BACKGROUND session.
  await core.handle({ kind: 'resume-session', sessionKey: 'sess:A' });
  assert.equal(endedB, 0, 'a session still running has not ended');
  releaseB();
  await turnB;
  assert.equal(endedB, 1, 'the dropped background agent never fired its session-end checkpoint');
  releaseA();
  await turnA;
  assert.ok(out.length > 0);
});

test('ADR-032 D5: shutdown awaits a drain that outlived background pool eviction', async () => {
  const { send } = collect();
  let releaseA!: () => void;
  let releaseB!: () => void;
  let releaseDrain!: () => void;
  const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
  const gateB = new Promise<void>((resolve) => { releaseB = resolve; });
  const drainGate = new Promise<void>((resolve) => { releaseDrain = resolve; });
  let shutdownRan = false;
  const agentA: AgentLike = {
    sessionKey: 'sess:A',
    runTurn: async () => { await gateA; return 'done-A'; },
    resetSessionCounters: () => {}, loadHistory: () => 1, getModel: () => 'm',
  };
  const agentB: AgentLike = {
    sessionKey: 'sess:spawn',
    runTurn: async () => { await gateB; return 'done-B'; },
    resetSessionCounters: () => {}, loadHistory: () => 1, getModel: () => 'm',
    endSession: async () => { await drainGate; },
  };
  const core = createHostCore({
    agent: agentA,
    send,
    spawnAgent: () => agentB,
    transcriptExists: () => true,
    onShutdown: () => { shutdownRan = true; },
  });

  const turnA = core.handle({ kind: 'start-turn', prompt: 'A' });
  await core.handle({ kind: 'resume-session', sessionKey: 'sess:B' });
  const turnB = core.handle({ kind: 'start-turn', prompt: 'B' });
  await core.handle({ kind: 'resume-session', sessionKey: 'sess:A' });
  releaseB();
  await turnB;
  releaseA();
  await turnA;

  const shutdown = core.handle({ kind: 'shutdown' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(shutdownRan, false, 'transport teardown cannot pass an evicted Agent checkpoint');
  releaseDrain();
  await shutdown;
  assert.equal(shutdownRan, true);
});

test('session-changed carries the AUTHORITATIVE running flag so the renderer can clear a stale "working…"', async () => {
  const { out, send } = collect();
  let releaseA!: () => void;
  const gateA = new Promise<void>((r) => { releaseA = r; });
  const agentA: AgentLike = {
    sessionKey: 'sess:A',
    runTurn: async (_p, cb) => { (cb.onAssistantDelta as (t: string) => void)('A'); await gateA; return 'done-A'; },
    resetSessionCounters: () => {}, loadHistory: () => 1, getModel: () => 'm',
  };
  const agentB: AgentLike = {
    sessionKey: 'sess:spawn', runTurn: async () => 'done-B',
    resetSessionCounters: () => {}, loadHistory: () => 1, getModel: () => 'm', clearHistory: () => {},
  };
  const core = createHostCore({
    agent: agentA, send, spawnAgent: () => agentB,
    transcriptExists: (k) => k === 'sess:A' || k === 'sess:B',
  });
  const runningOf = (key: string): boolean | undefined => {
    const scs = out.filter((m) => m.event.kind === 'session-changed' && (m.event as { sessionKey: string }).sessionKey === key);
    return scs.length ? (scs[scs.length - 1].event as { running?: boolean }).running : undefined;
  };

  const turnA = core.handle({ kind: 'start-turn', prompt: 'long A' });   // A is now running
  await core.handle({ kind: 'resume-session', sessionKey: 'sess:B' });    // switch to B (idle)
  assert.equal(runningOf('sess:B'), false, 'switching to an idle session reports running:false');

  await core.handle({ kind: 'resume-session', sessionKey: 'sess:A' });    // back to A, still mid-turn
  assert.equal(runningOf('sess:A'), true, 'refocusing a still-running session reports running:true (authoritative)');

  releaseA();
  await turnA;
});

test('interaction-response resolves the broker; stale ids are ignored politely', async () => {
  const { out, send } = collect();
  const core = createHostCore({ agent: fakeAgent(), send });
  const { request, response } = core.broker.request({ type: 'confirm', title: 'Run it?' });
  await core.handle({ kind: 'interaction-response', id: request.id, response: { type: 'confirm', approved: true } });
  assert.deepEqual(await response, { type: 'confirm', approved: true });
  await core.handle({ kind: 'interaction-response', id: 'ir_999', response: { type: 'confirm', approved: true } });
  assert.ok(out.some((m) => m.event.kind === 'status' && (m.event as { text: string }).text.includes('Stale')));
});

test('interrupt dismisses pending approvals (fail-closed unwind)', async () => {
  const { send } = collect();
  const core = createHostCore({ agent: fakeAgent(), send });
  const a = core.broker.request({ type: 'confirm', title: 'a' });
  await core.handle({ kind: 'interrupt' });
  assert.deepEqual(await a.response, { type: 'dismissed' });
  assert.equal(core.broker.pendingCount, 0);
});

test('query: routes to handlers; unknown names error; thrown handlers error', async () => {
  const { out, send } = collect();
  const core = createHostCore({
    agent: fakeAgent(),
    send,
    queries: {
      'list-sessions': () => [{ sessionKey: 's1' }],
      'explode': () => { throw new Error('nope'); },
    },
  });
  await core.handle({ kind: 'query', id: 'q1', name: 'list-sessions' });
  await core.handle({ kind: 'query', id: 'q2', name: 'missing' });
  await core.handle({ kind: 'query', id: 'q3', name: 'explode' });
  const results = out.filter((m) => m.event.kind === 'query-result') as Array<AgentEventMessage & { event: Extract<AgentEventMessage['event'], { kind: 'query-result' }> }>;
  assert.deepEqual(results.map((r) => [r.event.id, r.event.ok]), [['q1', true], ['q2', false], ['q3', false]]);
  assert.deepEqual(results[0].event.result, [{ sessionKey: 's1' }]);
});

test('garbage is ignored; shutdown dismisses, drains learning, then calls onShutdown', async () => {
  const { out, send } = collect();
  let shut = false;
  let releaseLearning!: () => void;
  const learning = new Promise<void>((resolve) => { releaseLearning = resolve; });
  const lifecycle: string[] = [];
  const agent: AgentLike = {
    ...fakeAgent(),
    endSession: async () => { await learning; lifecycle.push('learning'); },
  };
  const core = createHostCore({ agent, send, onShutdown: () => { lifecycle.push('shutdown'); shut = true; } });
  await core.handle('garbage');
  await core.handle({ kind: 'unknown-thing' });
  assert.equal(out.length, 0);
  const p = core.broker.request({ type: 'confirm', title: 'x' });
  const shutdown = core.handle({ kind: 'shutdown' });
  assert.deepEqual(await p.response, { type: 'dismissed' });
  assert.equal(shut, false, 'transport teardown waits for the bounded learning drain');
  releaseLearning();
  await shutdown;
  assert.equal(shut, true);
  assert.deepEqual(lifecycle, ['learning', 'shutdown']);
});

test('interrupt flags the agent for a cooperative stop', async () => {
  const { send } = collect();
  let flagged = false;
  const agent: AgentLike = { ...fakeAgent(), requestInterrupt: () => { flagged = true; } };
  const core = createHostCore({ agent, send });
  await core.handle({ kind: 'interrupt' });
  assert.equal(flagged, true);
});

test('new-session: fresh key + cleared history + session-changed event', async () => {
  const { out, send } = collect();
  let cleared = false;
  const agent: AgentLike = {
    ...fakeAgent(), sessionKey: 'root:old',
    clearHistory: () => { cleared = true; },
    resetSessionCounters: () => {},
    getModel: () => 'test-model',
  };
  const core = createHostCore({ agent, send });
  await core.handle({ kind: 'new-session', label: 'My Chat!' });
  assert.equal(cleared, true);
  assert.equal(agent.sessionKey, 'root:My-Chat-');
  const ev = out.find((m) => m.event.kind === 'session-changed')!.event as { sessionKey: string; loadedMessages: number };
  assert.equal(ev.loadedMessages, 0);
});

test('ADR-032 D5: an idle retarget awaits endSession before changing session identity', async () => {
  const { send } = collect();
  let releaseDrain!: () => void;
  const drainGate = new Promise<void>((resolve) => { releaseDrain = resolve; });
  const lifecycle: string[] = [];
  const agent: AgentLike = {
    ...fakeAgent(),
    sessionKey: 'root:old',
    endSession: async () => {
      lifecycle.push(`drain:${agent.sessionKey}`);
      await drainGate;
    },
    resetSessionCounters: () => { lifecycle.push(`reset:${agent.sessionKey}`); },
    clearHistory: () => { lifecycle.push(`clear:${agent.sessionKey}`); },
  };
  const core = createHostCore({ agent, send, transcriptExists: () => true });

  const retarget = core.handle({ kind: 'new-session', label: 'next' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(agent.sessionKey, 'root:old', 'the old key remains pinned while its checkpoint drains');
  assert.deepEqual(lifecycle, ['drain:root:old']);

  releaseDrain();
  await retarget;
  assert.equal(agent.sessionKey, 'root:next');
  assert.deepEqual(lifecycle, ['drain:root:old', 'reset:root:next', 'clear:root:next']);

  await core.handle({ kind: 'resume-session', sessionKey: 'root:saved' });
  assert.equal(agent.sessionKey, 'root:saved');
  assert.deepEqual(lifecycle.slice(-2), ['drain:root:next', 'reset:root:saved']);
});

test('ADR-032 D8: tenant rebind drains every pooled Agent before transport replacement and respawn', async () => {
  const { send } = collect();
  const lifecycle: string[] = [];
  let releaseA!: () => void;
  let releaseDrainA!: () => void;
  let releaseDrainB!: () => void;
  const turnGateA = new Promise<void>((resolve) => { releaseA = resolve; });
  const drainGateA = new Promise<void>((resolve) => { releaseDrainA = resolve; });
  const drainGateB = new Promise<void>((resolve) => { releaseDrainB = resolve; });
  const agentA: AgentLike = {
    sessionKey: 'sess:A',
    runTurn: async () => { await turnGateA; return 'done-A'; },
    requestInterrupt: () => { lifecycle.push('interrupt:A'); releaseA(); },
    endSession: async () => { lifecycle.push(`drain-start:${agentA.sessionKey}`); await drainGateA; lifecycle.push('drain-end:A'); },
  };
  const agentB: AgentLike = {
    sessionKey: 'sess:spawn',
    runTurn: async () => 'done-B',
    endSession: async () => { lifecycle.push(`drain-start:${agentB.sessionKey}`); await drainGateB; lifecycle.push('drain-end:B'); },
    getModel: () => 'old-model',
  };
  const replacement: AgentLike = {
    sessionKey: 'replacement',
    runTurn: async () => { lifecycle.push('replacement-turn'); return 'new-tenant'; },
    getModel: () => 'new-model',
  };
  const core = createHostCore({
    agent: agentA,
    send,
    spawnAgent: () => agentB,
    transcriptExists: () => true,
  });

  const turnA = core.handle({ kind: 'start-turn', prompt: 'old tenant work' });
  await core.handle({ kind: 'resume-session', sessionKey: 'sess:B' });
  const rebind = core.rebindTenant(async (sessionKey) => {
    lifecycle.push(`reconnect:${sessionKey}`);
    lifecycle.push('spawn:new');
    return replacement;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(lifecycle.includes('reconnect:sess:B'), false, 'transport stayed old while either checkpoint was pending');

  releaseDrainA();
  releaseDrainB();
  await rebind;
  await turnA;
  assert.ok(lifecycle.indexOf('drain-end:A') < lifecycle.indexOf('reconnect:sess:B'));
  assert.ok(lifecycle.indexOf('drain-end:B') < lifecycle.indexOf('reconnect:sess:B'));
  assert.ok(lifecycle.indexOf('reconnect:sess:B') < lifecycle.indexOf('spawn:new'));

  await core.handle({ kind: 'start-turn', prompt: 'new tenant work' });
  assert.equal(lifecycle.at(-1), 'replacement-turn', 'only the replacement serves turns after rebinding');
});

test('ADR-032 D8: commands arriving during tenant transport replacement wait for the new boundary', async () => {
  const { out, send } = collect();
  let releaseTransport!: () => void;
  const transportGate = new Promise<void>((resolve) => { releaseTransport = resolve; });
  const lifecycle: string[] = [];
  const replacement = fakeAgent();
  replacement.sessionKey = 'replacement';
  const core = createHostCore({
    agent: { ...fakeAgent(), endSession: () => { lifecycle.push('drain'); } },
    send,
    queries: {
      'central-mutation': () => { lifecycle.push('query'); return { ok: true }; },
    },
  });

  const rebind = core.rebindTenant(async () => {
    lifecycle.push('transport-start');
    await transportGate;
    lifecycle.push('transport-ready');
    return replacement;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const query = core.handle({ kind: 'query', id: 'q-tenant', name: 'central-mutation' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(lifecycle, ['drain', 'transport-start'], 'the old transport cannot serve a concurrent query');

  releaseTransport();
  await Promise.all([rebind, query]);
  assert.deepEqual(lifecycle, ['drain', 'transport-start', 'transport-ready', 'query']);
  assert.ok(out.some((message) => message.event.kind === 'query-result' && message.event.id === 'q-tenant'));
});

test('ADR-032 D8: identity resolving mid-turn preserves the turn and enables learning for the next turn', async () => {
  const { send } = collect();
  let releaseTurn!: () => void;
  const turnGate = new Promise<void>((resolve) => { releaseTurn = resolve; });
  let binding = { tenant: { userId: 'unresolved-profile-a', orgId: null as string | null }, enabled: false };
  const observed: Array<typeof binding> = [];
  let interrupts = 0;
  let clears = 0;
  const agent: AgentLike = {
    sessionKey: 'sess:identity',
    runTurn: async () => {
      observed.push(structuredClone(binding));
      if (observed.length === 1) await turnGate;
      return 'done';
    },
    requestInterrupt: () => { interrupts += 1; },
    clearHistory: () => { clears += 1; },
    setLearningBinding: (tenant, enabled) => { binding = { tenant: { ...tenant }, enabled }; },
  };
  const core = createHostCore({ agent, send });

  const firstTurn = core.handle({ kind: 'start-turn', prompt: 'already running' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const identityBind = core.bindLearning({ userId: 'user-a', orgId: 'org-a' }, true);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(interrupts, 0, 'background identity discovery never interrupts an active turn');
  assert.equal(clears, 0, 'background identity discovery never clears conversation history');
  assert.deepEqual(binding, {
    tenant: { userId: 'unresolved-profile-a', orgId: null },
    enabled: false,
  }, 'the running turn keeps the disabled boot binding until finalization');

  releaseTurn();
  await Promise.all([firstTurn, identityBind]);
  await core.handle({ kind: 'start-turn', prompt: 'next turn' });

  assert.deepEqual(observed, [
    { tenant: { userId: 'unresolved-profile-a', orgId: null }, enabled: false },
    { tenant: { userId: 'user-a', orgId: 'org-a' }, enabled: true },
  ]);
  assert.equal(interrupts, 0);
  assert.equal(clears, 0);
});

test('ADR-032 D8: a failed transport replacement installs a usable tenant-derived fallback Agent', async () => {
  const { send } = collect();
  const lifecycle: string[] = [];
  const fallback: AgentLike = {
    sessionKey: 'fallback',
    runTurn: async () => { lifecycle.push('fallback-turn'); return 'offline-ready'; },
    getModel: () => 'fallback-model',
  };
  const core = createHostCore({
    agent: {
      ...fakeAgent(),
      sessionKey: 'sess:active',
      endSession: () => { lifecycle.push('drain'); },
    },
    send,
    spawnAgent: (sessionKey) => {
      lifecycle.push(`fallback:${sessionKey}`);
      return fallback;
    },
  });

  await assert.rejects(
    core.rebindTenant(async () => {
      lifecycle.push('transport');
      throw new Error('transport replacement failed');
    }),
    /transport replacement failed/,
  );
  assert.deepEqual(lifecycle, ['drain', 'transport', 'fallback:sess:active']);
  assert.equal(fallback.sessionKey, 'sess:active');

  await core.handle({ kind: 'start-turn', prompt: 'continue offline' });
  assert.equal(lifecycle.at(-1), 'fallback-turn', 'the failed switch never leaves the host without an active Agent');
});

test('DESK-6t resume-session: switches + emits count, but LAZY-loads history on the first turn (not on resume)', async () => {
  const { out, send } = collect();
  let loadedWith: unknown[] = [];
  const agent: AgentLike = {
    ...fakeAgent(),
    resetSessionCounters: () => {},
    loadHistory: (entries) => { loadedWith = entries; return entries.length; },
    getModel: () => 'm',
  };
  const core = createHostCore({
    agent, send,
    loadTranscript: (key) => (key === 'sess-known' ? [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }] : []),
  });
  await core.handle({ kind: 'resume-session', sessionKey: 'sess-known' });
  // Resume switches the session + emits a SENTINEL loadedMessages (1 = "has
  // history to render") — OOM-safe: it no longer full-reads the transcript just
  // to count; the renderer fetches the real rows via the bounded transcript query.
  assert.equal(agent.sessionKey, 'sess-known');
  const sc = out.find((m) => m.event.kind === 'session-changed')!.event as { loadedMessages: number };
  assert.equal(sc.loadedMessages, 1);
  // …but does NOT load the transcript into the agent yet (the expensive part is lazy).
  assert.equal(loadedWith.length, 0, 'history is NOT loaded on resume');
  // It loads on the FIRST turn (when the user actually sends a message).
  await core.handle({ kind: 'start-turn', prompt: 'continue' });
  assert.equal(loadedWith.length, 2, 'history loaded on the first turn');

  await core.handle({ kind: 'resume-session', sessionKey: 'missing' });
  assert.ok(out.some((m) => m.event.kind === 'turn-error' && (m.event as { message: string }).message.includes('missing')));
});

test('new-session after lazy resume does not load the previous transcript on first turn', async () => {
  const { send } = collect();
  let transcriptLoads = 0;
  let historyLoads = 0;
  let cleared = 0;
  const agent: AgentLike = {
    ...fakeAgent(),
    sessionKey: 'root:old',
    clearHistory: () => { cleared++; },
    resetSessionCounters: () => {},
    loadHistory: (entries) => { historyLoads++; return entries.length; },
    getModel: () => 'm',
  };
  const core = createHostCore({
    agent,
    send,
    loadTranscript: (key) => {
      transcriptLoads++;
      return key === 'root:big-session' ? [{ role: 'user', content: 'large previous transcript' }] : [];
    },
  });

  await core.handle({ kind: 'resume-session', sessionKey: 'root:big-session' });
  assert.equal(transcriptLoads, 1, 'resume may check existence in the no-transcriptExists fallback');
  assert.equal(historyLoads, 0, 'lazy resume has not loaded the previous transcript into the agent');

  await core.handle({ kind: 'new-session', label: 'fresh' });
  assert.equal(cleared, 1, 'fresh chat cleared the reused agent history');

  await core.handle({ kind: 'start-turn', prompt: 'brand new prompt' });
  assert.equal(historyLoads, 0, 'fresh chat did not ingest the lazily-resumed transcript');
  assert.equal(agent.sessionKey, 'root:fresh');
});

test('set-model: switches + persists; persist failure degrades gracefully', async () => {
  const { out, send } = collect();
  let model = 'old';
  const agent: AgentLike = { ...fakeAgent(), setModel: (m) => { model = m; }, getModel: () => model };
  let persisted = '';
  const core = createHostCore({ agent, send, persistModel: (m) => { persisted = m; } });
  await core.handle({ kind: 'set-model', model: 'gpt-5.5', persist: true });
  assert.equal(model, 'gpt-5.5');
  assert.equal(persisted, 'gpt-5.5');
  assert.ok(out.some((m) => m.event.kind === 'status' && (m.event as { text: string }).text.includes('shared with the CLI')));

  const failing = createHostCore({ agent, send, persistModel: () => { throw new Error('disk full'); } });
  await failing.handle({ kind: 'set-model', model: 'x', persist: true });
  assert.ok(out.some((m) => m.event.kind === 'status' && (m.event as { text: string }).text.includes('persisting failed')));
});

test('start-turn is blocked before agent execution when active model policy is invalid', async () => {
  const sent: AgentEventMessage[] = [];
  let runs = 0;
  const fake = fakeAgent(async () => { runs += 1; return 'should not run'; });
  const core = createHostCore({
    agent: fake,
    send: (message) => sent.push(message),
    validateTurn: () => 'This managed model is no longer available. Choose another model before sending.',
  });

  await core.handle({ kind: 'start-turn', prompt: 'hello' });

  assert.equal(runs, 0);
  assert.equal(sent.some((message) => message.event.kind === 'turn-start'), false);
  assert.equal(sent.some((message) => message.event.kind === 'turn-error'
    && /choose another model/i.test(message.event.message)), true);
});

test('createBrokerPort: confirm/choice round-trip + dismissal fails closed', async () => {
  const broker = new InteractionBroker();
  const emitted: Array<{ kind: string; request: { id: string; type: string } }> = [];
  const port = createBrokerPort(broker, (e) => emitted.push(e as never), 1_000);

  const confirmP = port.confirm({ title: 'Run?', dangerous: true, tool: 'run_command' });
  assert.equal(emitted[0].request.type, 'confirm');
  broker.resolve(emitted[0].request.id, { type: 'confirm', approved: true });
  assert.equal(await confirmP, true);

  const choiceP = port.choice({ question: 'Pick', header: 'P', options: [{ label: 'A', description: 'a' }] });
  broker.resolve(emitted[1].request.id, { type: 'choice', labels: ['A'] });
  assert.deepEqual(await choiceP, ['A']);

  const dismissedP = port.confirm({ title: 'ignored' });
  broker.resolve(emitted[2].request.id, { type: 'dismissed' });
  assert.equal(await dismissedP, false, 'dismissed confirm = deny');
});

test('turn-complete is followed by tokens-updated when the agent exposes usage', async () => {
  const { out, send } = collect();
  const agent: AgentLike = {
    ...fakeAgent(),
    sessionUsage: { promptTokens: 1200, completionTokens: 80, calls: 3, turns: 1 },
  };
  const core = createHostCore({ agent, send });
  await core.handle({ kind: 'start-turn', prompt: 'x' });
  const kinds = out.map((m) => m.event.kind);
  assert.deepEqual(kinds.slice(-2), ['turn-complete', 'tokens-updated']);
  const tok = out[out.length - 1].event as { promptTokens: number };
  assert.equal(tok.promptTokens, 1200);
});

// Item 10 — per-session model (set-model scope + restore on spawn).
function modelAgent(key = 'sess-test'): AgentLike & { _model: string } {
  return {
    sessionKey: key,
    _model: 'init-model',
    runTurn: async () => 'ok',
    resetSessionCounters() {},
    setModel(m: string) { (this as { _model: string })._model = m; },
    getModel() { return (this as { _model: string })._model; },
  };
}

test('set-model persist:false saves for THIS SESSION only (not global config)', async () => {
  const { out, send } = collect();
  const global: string[] = [];
  const session: Array<[string, string]> = [];
  const agent = modelAgent();
  const core = createHostCore({
    agent, send,
    persistModel: (m) => global.push(m),
    setSessionModel: (k, m) => session.push([k, m]),
  });
  await core.handle({ kind: 'set-model', model: 'gpt-5.5', persist: false });
  assert.deepEqual(session, [['sess-test', 'gpt-5.5']], 'wrote per-session override');
  assert.deepEqual(global, [], 'did NOT touch global config');
  assert.equal(agent.getModel?.(), 'gpt-5.5', 'applied in-memory immediately');
  const sc = out.find((m) => m.event.kind === 'session-changed');
  assert.equal((sc!.event as { model: string }).model, 'gpt-5.5');
});

test('set-model persist:true saves the GLOBAL default (not per-session)', async () => {
  const { send } = collect();
  const global: string[] = [];
  const session: Array<[string, string]> = [];
  const cleared: string[] = [];
  const core = createHostCore({
    agent: modelAgent(), send,
    persistModel: (m) => global.push(m),
    setSessionModel: (k, m) => session.push([k, m]),
    clearSessionModel: (k) => cleared.push(k),
  });
  await core.handle({ kind: 'set-model', model: 'claude-opus-4-8', persist: true });
  assert.deepEqual(global, ['claude-opus-4-8'], 'wrote global config');
  assert.deepEqual(session, [], 'did NOT write a per-session override');
  assert.deepEqual(cleared, ['sess-test'], 'cleared stale per-session model override for the active chat');
});

test('set-model providerName + persist:false → cross-provider PER-SESSION (rebuild LLM, full session override, no global)', async () => {
  const { send } = collect();
  const global: string[] = [];
  const sessionLlms: Array<[string, unknown]> = [];
  const rebuilt: Array<{ provider?: string; apiKey?: string }> = [];
  const agent = modelAgent('sess-test');
  (agent as unknown as { setLLMConfig: (c: unknown) => void }).setLLMConfig = (c) => { rebuilt.push(c as { provider?: string; apiKey?: string }); };
  const core = createHostCore({
    agent, send,
    persistModel: (m) => global.push(m),
    persistProviderModel: (n, m) => global.push(`${n}:${m}`),
    setSessionModel: () => global.push('WRONG-session-model'),
    setSessionLlm: (k, patch) => sessionLlms.push([k, patch]),
    resolveProviderLlm: (_name, model) => ({ provider: 'anthropic', apiKey: 'sk-x', model, endpoint: 'https://api.anthropic.com' }),
  });
  await core.handle({ kind: 'set-model', model: 'claude-opus-4-8', persist: false, providerName: 'my-anthropic' });
  assert.equal(rebuilt[0]?.provider, 'anthropic', 'rebuilt the active agent with the provider config');
  assert.equal(rebuilt[0]?.apiKey, 'sk-x', 'incl. the resolved key (main-process only)');
  assert.deepEqual(sessionLlms, [['sess-test', { provider: 'anthropic', model: 'claude-opus-4-8', endpoint: 'https://api.anthropic.com' }]], 'wrote the FULL session override (no secret)');
  assert.deepEqual(global, [], 'never touched the global default → no sync to other sessions');
});

test('set-model with an unavailable named provider fails closed without changing the model', async () => {
  const { out, send } = collect();
  const agent = modelAgent();
  const core = createHostCore({
    agent,
    send,
    resolveProviderLlm: async () => undefined,
  });

  await core.handle({ kind: 'set-model', model: 'removed-managed-model', persist: false, providerName: 'brainrouter-account' });

  assert.equal(agent.getModel?.(), 'init-model');
  assert.ok(out.some((message) => message.event.kind === 'turn-error'
    && (message.event as { message: string }).message.includes('unavailable')));
});

test('set-model providerName + persist:true → cross-provider GLOBAL default (persistProviderModel + clears session)', async () => {
  const { send } = collect();
  const globalProv: Array<[string, string]> = [];
  const cleared: string[] = [];
  const agent = modelAgent('sess-test');
  (agent as unknown as { setLLMConfig: (c: unknown) => void }).setLLMConfig = () => {};
  const core = createHostCore({
    agent, send,
    persistProviderModel: (n, m) => globalProv.push([n, m]),
    clearSessionModel: (k) => cleared.push(k),
    resolveProviderLlm: (_name, model) => ({ provider: 'anthropic', apiKey: 'sk-x', model, endpoint: 'e' }),
  });
  await core.handle({ kind: 'set-model', model: 'claude-opus-4-8', persist: true, providerName: 'my-anthropic' });
  assert.deepEqual(globalProv, [['my-anthropic', 'claude-opus-4-8']], 'set the GLOBAL default from the connection');
  assert.deepEqual(cleared, ['sess-test'], 'cleared the per-session override');
});

test('a spawned/focused session restores its stored per-session model', async () => {
  const { out, send } = collect();
  const agent = modelAgent('sess-test');
  const core = createHostCore({
    agent, send,
    spawnAgent: (k) => modelAgent(k),
    getSessionModel: (k) => (k === 'sess-test:feature' ? 'qwen3-coder' : undefined),
  });
  await core.handle({ kind: 'new-session', label: 'feature' });
  // The agent now serving sess-test:feature must carry that session's model.
  const sc = out.filter((m) => m.event.kind === 'session-changed').pop();
  assert.equal(sc!.sessionKey, 'sess-test:feature');
  assert.equal((sc!.event as { model: string }).model, 'qwen3-coder', 'restored per-session model on focus');
});

test('isUnsavedNewSessionKey marks only the new-* session segment', () => {
  assert.equal(isUnsavedNewSessionKey('abc123:new-k1z9'), true);
  assert.equal(isUnsavedNewSessionKey('new-k1z9'), true); // no workspace prefix
  assert.equal(isUnsavedNewSessionKey('abc123:saved-chat'), false);
  assert.equal(isUnsavedNewSessionKey('abc123:newish'), false); // must be the "new-" prefix
  assert.equal(isUnsavedNewSessionKey('abc123:design-note'), false);
});

test('Bug-fix: resuming an unsaved new-* key with no transcript self-heals (no "No transcript found")', async () => {
  const { out, send } = collect();
  const core = createHostCore({ agent: fakeAgent(), send, transcriptExists: () => false });
  await core.handle({ kind: 'resume-session', sessionKey: 'wshash:new-abc12' });
  const kinds = out.map((m) => m.event.kind);
  assert.ok(!kinds.includes('turn-error'), 'a brand-new chat must not hard-error on resume');
  const sc = out.find((m) => m.event.kind === 'session-changed');
  assert.ok(sc, 'self-heals to a fresh session');
  const ev = sc!.event as Extract<AgentEventMessage['event'], { kind: 'session-changed' }>;
  assert.equal(ev.sessionKey, 'wshash:new-abc12');
  assert.equal(ev.loadedMessages, 0, 'fresh empty session');
});

test('Bug-fix: resuming a SAVED key with no transcript still emits a controlled error', async () => {
  const { out, send } = collect();
  const core = createHostCore({ agent: fakeAgent(), send, transcriptExists: () => false });
  await core.handle({ kind: 'resume-session', sessionKey: 'wshash:saved-feature' });
  const err = out.find((m) => m.event.kind === 'turn-error');
  assert.ok(err, 'a missing transcript for a real saved session is still an error');
  assert.match((err!.event as Extract<AgentEventMessage['event'], { kind: 'turn-error' }>).message, /No transcript found/);
});
