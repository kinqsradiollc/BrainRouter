import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCallbackBridge,
  createEnvelopeWriter,
  isAgentCommand,
  isAgentEventMessage,
  InteractionBroker,
  type AgentEvent,
  type AgentEventMessage,
} from './index.js';

// --- callback bridge ---------------------------------------------------------

test('createCallbackBridge: every callback maps to its event kind with payload fidelity', () => {
  const events: AgentEvent[] = [];
  const cb = createCallbackBridge((e) => events.push(e));

  cb.onStatusUpdate('Loading tools...');
  cb.onAssistantTurnStart();
  cb.onAssistantDelta('Hel');
  cb.onAssistantDelta('lo');
  cb.onAssistantTurnEnd();
  cb.onReasoningDelta('thinking…');
  cb.onToolStart('read_file', { path: 'a.ts' }, 'c1');
  cb.onToolEnd('read_file', { success: true, summary: '42 lines', preview: 'line1' }, 'c1');
  cb.onChildToolStart({ childId: 'agent-1', role: 'explorer', tool: 'grep_search', args: { query: 'x' } });
  cb.onChildToolEnd({ childId: 'agent-1', role: 'explorer', tool: 'grep_search', ok: true, summary: 'hit', durationMs: 12 });
  cb.onChildComplete({ childId: 'agent-1', role: 'explorer', status: 'completed', preview: 'found it' });
  cb.onPlanUpdate([{ step: 'fix', status: 'in_progress' }], 'because');
  cb.onCompactionEvent({ droppedMessages: 10, keptMessages: 4, summary: 'compacted' });
  cb.onMemoryEvent({ level: 'warn', text: 'capture blocked' });
  cb.onApproval({ tool: 'run_command', action: 'shell', decision: 'ask', reason: 'planning mode' });

  assert.deepEqual(events.map((e) => e.kind), [
    'status', 'assistant-turn-start', 'assistant-delta', 'assistant-delta', 'assistant-turn-end',
    'reasoning-delta', 'tool-start', 'tool-end', 'child-tool-start', 'child-tool-end',
    'child-complete', 'plan-update', 'compaction', 'memory', 'approval-decision',
  ]);
  assert.deepEqual(events[6], { kind: 'tool-start', tool: 'read_file', args: { path: 'a.ts' }, callId: 'c1' });
  assert.deepEqual(events[7], { kind: 'tool-end', tool: 'read_file', ok: true, summary: '42 lines', preview: 'line1', callId: 'c1' });
  const plan = events[11] as Extract<AgentEvent, { kind: 'plan-update' }>;
  assert.equal(plan.items[0].status, 'in_progress');
  assert.equal(plan.explanation, 'because');
});

test('createCallbackBridge: memory event falls back kind→text and defaults level', () => {
  const events: AgentEvent[] = [];
  const cb = createCallbackBridge((e) => events.push(e));
  cb.onMemoryEvent({ kind: 'skipped', reason: 'policy' });
  assert.deepEqual(events[0], { kind: 'memory', level: 'info', text: 'policy' });
});

// --- envelope writer -----------------------------------------------------------

test('createEnvelopeWriter: stamps monotonic seq + ts + sessionKey', () => {
  const sent: AgentEventMessage[] = [];
  let t = 1000;
  const emit = createEnvelopeWriter('sess-1', (m) => sent.push(m), () => (t += 5));
  emit({ kind: 'status', text: 'a' });
  emit({ kind: 'status', text: 'b' });
  assert.deepEqual(sent.map((m) => [m.seq, m.ts, m.sessionKey]), [[1, 1005, 'sess-1'], [2, 1010, 'sess-1']]);
  assert.ok(sent.every(isAgentEventMessage));
});

// --- guards ---------------------------------------------------------------------

test('guards: accept valid, reject malformed', () => {
  assert.equal(isAgentCommand({ kind: 'start-turn', prompt: 'hi' }), true);
  assert.equal(isAgentCommand({ kind: 'interrupt' }), true);
  assert.equal(isAgentCommand({ kind: 'nope' }), false);
  assert.equal(isAgentCommand(null), false);
  assert.equal(isAgentCommand('start-turn'), false);

  assert.equal(isAgentEventMessage({ seq: 1, ts: 2, sessionKey: 's', event: { kind: 'status', text: 'x' } }), true);
  assert.equal(isAgentEventMessage({ seq: 1, ts: 2, sessionKey: 's', event: { kind: 'bogus' } }), false);
  assert.equal(isAgentEventMessage({ event: { kind: 'status' } }), false);
});

// --- interaction broker -----------------------------------------------------------

test('InteractionBroker: request/resolve round-trip with unique ids', async () => {
  const broker = new InteractionBroker();
  const a = broker.request({ type: 'confirm', title: 'Run `git push`?', dangerous: true, tool: 'run_command' });
  const b = broker.request({ type: 'choice', question: 'Pick one', header: 'Choice', options: [{ label: 'x', description: 'd' }] });
  assert.notEqual(a.request.id, b.request.id);
  assert.equal(broker.pendingCount, 2);

  assert.equal(broker.resolve(a.request.id, { type: 'confirm', approved: true }), true);
  assert.deepEqual(await a.response, { type: 'confirm', approved: true });
  assert.equal(broker.resolve(a.request.id, { type: 'confirm', approved: false }), false, 'double-resolve refused');

  broker.resolve(b.request.id, { type: 'choice', labels: ['x'] });
  assert.deepEqual(await b.response, { type: 'choice', labels: ['x'] });
  assert.equal(broker.pendingCount, 0);
});

test('InteractionBroker: timeout settles as dismissed; dismissAll sweeps', async () => {
  const broker = new InteractionBroker();
  const timed = broker.request({ type: 'confirm', title: 'slow?' }, { timeoutMs: 20 });
  assert.deepEqual(await timed.response, { type: 'dismissed' });

  const p1 = broker.request({ type: 'confirm', title: 'a' });
  const p2 = broker.request({ type: 'confirm', title: 'b' });
  assert.equal(broker.dismissAll(), 2);
  assert.deepEqual(await p1.response, { type: 'dismissed' });
  assert.deepEqual(await p2.response, { type: 'dismissed' });
});
