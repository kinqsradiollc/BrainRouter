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

test('resume-session: loads the transcript; unknown key errors', async () => {
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
  assert.equal(agent.sessionKey, 'sess-known');
  assert.equal(loadedWith.length, 2);
  const ok = out.find((m) => m.event.kind === 'session-changed')!.event as { loadedMessages: number };
  assert.equal(ok.loadedMessages, 2);
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
