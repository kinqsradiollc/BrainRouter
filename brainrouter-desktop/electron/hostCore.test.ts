import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrokerPort, createHostCore, type AgentLike } from './hostCore.js';
import { InteractionBroker } from '@kinqs/brainrouter-agent-protocol';
import type { AgentEventMessage } from '@kinqs/brainrouter-agent-protocol';

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

test('garbage on the wire is ignored; shutdown dismisses + calls onShutdown', async () => {
  const { out, send } = collect();
  let shut = false;
  const core = createHostCore({ agent: fakeAgent(), send, onShutdown: () => { shut = true; } });
  await core.handle('garbage');
  await core.handle({ kind: 'unknown-thing' });
  assert.equal(out.length, 0);
  const p = core.broker.request({ type: 'confirm', title: 'x' });
  await core.handle({ kind: 'shutdown' });
  assert.deepEqual(await p.response, { type: 'dismissed' });
  assert.equal(shut, true);
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
  // Resume switches the session + reports the count for the renderer to render…
  assert.equal(agent.sessionKey, 'sess-known');
  const sc = out.find((m) => m.event.kind === 'session-changed')!.event as { loadedMessages: number };
  assert.equal(sc.loadedMessages, 2);
  // …but does NOT load the transcript into the agent yet (the expensive part is lazy).
  assert.equal(loadedWith.length, 0, 'history is NOT loaded on resume');
  // It loads on the FIRST turn (when the user actually sends a message).
  await core.handle({ kind: 'start-turn', prompt: 'continue' });
  assert.equal(loadedWith.length, 2, 'history loaded on the first turn');

  await core.handle({ kind: 'resume-session', sessionKey: 'missing' });
  assert.ok(out.some((m) => m.event.kind === 'turn-error' && (m.event as { message: string }).message.includes('missing')));
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
