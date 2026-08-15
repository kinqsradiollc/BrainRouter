/**
 * Public protocol contract tests for command/event guards, callback bridges,
 * interaction brokers, and explicit confirmation. These cases protect wire
 * compatibility without depending on a presentation host or live transport.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCallbackBridge,
  createEnvelopeWriter,
  isAgentCommand,
  isAgentEventMessage,
  isBackgroundTaskEventView,
  InteractionBroker,
  toExplicitConfirmDecision,
  type AgentEvent,
  type AgentEventMessage,
  type BackgroundTaskEventView,
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
  cb.onToolEnd('delegate_agent', {
    success: false,
    summary: 'delegation not started',
    delegationState: 'not-started',
  }, 'c2');
  cb.onChildToolStart({ childId: 'agent-1', role: 'explorer', tool: 'grep_search', args: { query: 'x' } });
  cb.onChildToolEnd({ childId: 'agent-1', role: 'explorer', tool: 'grep_search', ok: true, summary: 'hit', durationMs: 12 });
  const childReceipt = {
    childId: 'agent-1',
    role: 'explorer',
    status: 'completed' as const,
    completedAt: '2026-07-30T00:00:00.000Z',
    preview: 'found it',
  };
  cb.onChildComplete(childReceipt);
  cb.onPlanUpdate(
    [{ id: 'task_fix', step: 'fix', status: 'in_progress' }],
    'because',
    {
      revision: 3,
      phases: [{
        id: 'phase_build',
        title: 'Build',
        status: 'in_progress',
        dependsOn: [],
        requiredSkillIds: ['planning-skill'],
        stepIds: ['task_fix'],
      }],
    },
  );
  cb.onProfileStageUpdate({
    phase: 'updated',
    workspaceProfileId: 'legal',
    planProfileId: 'research',
    profileId: 'research',
    strategyId: 'investigate',
    selectionSource: 'deterministic',
    stages: [{
      id: 'collect',
      state: 'running',
      executor: 'role',
      roleId: 'explorer',
      skillIds: ['source-research'],
    }],
  });
  cb.onCompactionEvent({ droppedMessages: 10, keptMessages: 4, summary: 'compacted' });
  cb.onMemoryEvent({ level: 'warn', text: 'capture blocked' });
  cb.onRequirementEvent({ action: 'created', requirementId: 'req_1', title: 'Need it', status: 'ready', provenance: { linkedMemoryIds: ['mem_1'] } });
  cb.onArtifactEvent({ action: 'saved', artifactId: 'art_1', title: 'Report', status: 'final', format: 'markdown' });
  cb.onAnnotationEvent({ action: 'comment-added', annotationId: 'ann_1', targetKind: 'file', targetId: 'src/a.ts', status: 'open' });
  cb.onProvenanceEvent({ subjectKind: 'annotation', subjectId: 'ann_1', provenance: { sourceEventId: 'evt_1', actor: 'agent' } });
  cb.onApproval({ tool: 'run_command', action: 'shell', decision: 'ask', reason: 'planning mode' });
  cb.onUsageUpdate({ promptTokens: 1200, completionTokens: 340, calls: 3, cachedTokens: 900 });

  assert.deepEqual(events.map((e) => e.kind), [
    'status', 'assistant-turn-start', 'assistant-delta', 'assistant-delta', 'assistant-turn-end',
    'reasoning-delta', 'tool-start', 'tool-end', 'tool-end', 'child-tool-start', 'child-tool-end',
    'child-complete', 'plan-update', 'profile-stage', 'compaction', 'memory', 'requirement-event',
    'artifact-event', 'annotation-event', 'provenance', 'approval-decision', 'usage-live',
  ]);
  // LIVE usage forwards the turn's running totals untouched (UI adds it to the base).
  assert.deepEqual(events[21], { kind: 'usage-live', promptTokens: 1200, completionTokens: 340, calls: 3, cachedTokens: 900 });
  assert.deepEqual(events[6], { kind: 'tool-start', tool: 'read_file', args: { path: 'a.ts' }, callId: 'c1' });
  assert.deepEqual(events[7], {
    kind: 'tool-end',
    tool: 'read_file',
    ok: true,
    summary: '42 lines',
    preview: 'line1',
    callId: 'c1',
    delegationState: undefined,
  });
  assert.deepEqual(events[8], {
    kind: 'tool-end',
    tool: 'delegate_agent',
    ok: false,
    summary: 'delegation not started',
    preview: undefined,
    callId: 'c2',
    delegationState: 'not-started',
  });
  assert.deepEqual(events[11], {
    kind: 'child-complete',
    receipt: childReceipt,
    childId: childReceipt.childId,
    role: childReceipt.role,
    status: childReceipt.status,
    preview: childReceipt.preview,
    error: undefined,
  });
  const plan = events[12] as Extract<AgentEvent, { kind: 'plan-update' }>;
  assert.equal(plan.items[0].status, 'in_progress');
  assert.equal(plan.explanation, 'because');
  assert.equal(plan.revision, 3);
  assert.equal(plan.phases?.[0]?.id, 'phase_build');
  const profileStage = events[13] as Extract<AgentEvent, { kind: 'profile-stage' }>;
  assert.equal(profileStage.workspaceProfileId, 'legal');
  assert.equal(profileStage.planProfileId, 'research');
  assert.equal(profileStage.profileId, 'research');
  assert.equal(profileStage.stages[0].state, 'running');
  const requirement = events[16] as Extract<AgentEvent, { kind: 'requirement-event' }>;
  assert.equal(requirement.requirementId, 'req_1');
  assert.deepEqual(requirement.provenance?.linkedMemoryIds, ['mem_1']);
  const annotation = events[18] as Extract<AgentEvent, { kind: 'annotation-event' }>;
  assert.equal(annotation.targetKind, 'file');
});

test('createCallbackBridge: memory event falls back kind→text and defaults level', () => {
  const events: AgentEvent[] = [];
  const cb = createCallbackBridge((e) => events.push(e));
  cb.onMemoryEvent({ kind: 'skipped', reason: 'policy' });
  assert.deepEqual(events[0], { kind: 'memory', level: 'info', text: 'policy' });
});

test('createCallbackBridge: legacy profile-stage identity remains readable', () => {
  const events: AgentEvent[] = [];
  const cb = createCallbackBridge((event) => events.push(event));
  cb.onProfileStageUpdate({
    phase: 'resolved',
    profileId: 'research',
    strategyId: 'investigate',
    selectionSource: 'deterministic',
    stages: [],
  });
  assert.deepEqual(events[0], {
    kind: 'profile-stage',
    phase: 'resolved',
    profileId: 'research',
    strategyId: 'investigate',
    selectionSource: 'deterministic',
    stages: [],
  });
});

test('createCallbackBridge: steering receipt lifecycle preserves revisions', () => {
  const events: AgentEvent[] = [];
  const cb = createCallbackBridge((event) => events.push(event));
  const pending = {
    id: 'steer_1',
    source: 'user' as const,
    receivedAt: '2026-07-28T01:00:00.000Z',
    priorRevision: 2,
    affectedRequirementIds: [],
    affectedTaskIds: ['task_1'],
    summary: 'Change verification order.',
    status: 'pending' as const,
  };
  cb.onSteerApplied({
    id: 'steer_1',
    text: 'Verify first.',
    source: 'user',
    createdAt: 1,
  }, pending);
  cb.onSteerReceipt({
    ...pending,
    classification: 'plan_change',
    status: 'applied',
    appliedAt: '2026-07-28T01:01:00.000Z',
    resultingRevision: 3,
  });

  assert.deepEqual(events[0], {
    kind: 'input-delivery',
    id: 'steer_1',
    mode: 'steer',
    state: 'applied',
    text: 'Verify first.',
    source: 'user',
    receipt: pending,
  });
  assert.equal(events[1].kind, 'steering-receipt');
  if (events[1].kind === 'steering-receipt') {
    assert.equal(events[1].receipt.resultingRevision, 3);
  }
});

test('createCallbackBridge: peer delivery preserves sender provenance and title events', () => {
  const events: AgentEvent[] = [];
  const cb = createCallbackBridge((event) => events.push(event));
  const receipt = {
    id: 'peer_1',
    source: 'peer-session' as const,
    receivedAt: '2026-08-11T01:00:00.000Z',
    priorRevision: 0,
    affectedRequirementIds: [],
    affectedTaskIds: [],
    summary: 'Check the release branch.',
    status: 'pending' as const,
  };
  cb.onSteerApplied({
    id: 'peer_1',
    text: 'Check the release branch.',
    source: 'peer-session',
    createdAt: 1,
    sender: { sessionKey: 'sender:1', deviceId: 'device:1', transport: 'local' },
  }, receipt);
  cb.onSessionTitle({ title: 'Check release branch', source: 'agent' });

  assert.deepEqual(events[0], {
    kind: 'input-delivery',
    id: 'peer_1',
    mode: 'steer',
    state: 'applied',
    text: 'Check the release branch.',
    source: 'peer-session',
    sender: { sessionKey: 'sender:1', deviceId: 'device:1', transport: 'local' },
    receipt,
  });
  assert.deepEqual(events[1], {
    kind: 'session-title', title: 'Check release branch', source: 'agent',
  });
});

test('createCallbackBridge: peer expiry is terminal and carries authenticated provenance', () => {
  const events: AgentEvent[] = [];
  const cb = createCallbackBridge((event) => events.push(event));
  cb.onSteerExpired({
    id: 'peer_expired_1',
    text: 'Too late for this model boundary.',
    source: 'peer-session',
    createdAt: 1,
    sender: { sessionKey: 'sender:expired', deviceId: 'device:expired', transport: 'remote' },
  });

  assert.deepEqual(events, [{
    kind: 'input-delivery',
    id: 'peer_expired_1',
    mode: 'steer',
    state: 'expired',
    text: 'Too late for this model boundary.',
    source: 'peer-session',
    sender: { sessionKey: 'sender:expired', deviceId: 'device:expired', transport: 'remote' },
  }]);
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
  assert.equal(isAgentCommand({ kind: 'start-turn', prompt: 'later', delivery: 'queue', deliveryId: 'd1' }), true);
  assert.equal(isAgentCommand({ kind: 'start-turn', prompt: 'change direction', delivery: 'steer', deliveryId: 'd2' }), true);
  // start-turn carries optional inline images for vision-capable models.
  assert.equal(isAgentCommand({ kind: 'start-turn', prompt: 'see this', images: [{ mediaType: 'image/png', dataBase64: 'AAAA' }] }), true);
  assert.equal(isAgentCommand({ kind: 'interrupt' }), true);
  assert.equal(isAgentCommand({ kind: 'nope' }), false);
  assert.equal(isAgentCommand(null), false);
  assert.equal(isAgentCommand('start-turn'), false);

  assert.equal(isAgentEventMessage({ seq: 1, ts: 2, sessionKey: 's', event: { kind: 'status', text: 'x' } }), true);
  assert.equal(isAgentEventMessage({ seq: 1, ts: 2, sessionKey: 's', event: { kind: 'interaction-resolved', id: 'ir_1' } }), true);
  assert.equal(isAgentEventMessage({ seq: 1, ts: 2, sessionKey: 's', event: { kind: 'annotation-event', action: 'created', annotationId: 'ann', targetKind: 'file' } }), true);
  assert.equal(isAgentEventMessage({ seq: 1, ts: 2, sessionKey: 's', event: { kind: 'bogus' } }), false);
  assert.equal(isAgentEventMessage({ event: { kind: 'status' } }), false);
  // task-event rides the same envelope and is a recognised kind.
  assert.equal(
    isAgentEventMessage({
      seq: 1,
      ts: 2,
      sessionKey: 's',
      event: {
        kind: 'task-event',
        action: 'created',
        task: { id: 't1', kind: 'review', status: 'queued', title: 'Review', workspaceRoot: '/w', sessionKey: 's', createdAt: 'a', updatedAt: 'b' },
      },
    }),
    true,
  );
});

// --- interaction broker -----------------------------------------------------------

test('isBackgroundTaskEventView: accepts a full view, rejects partial', () => {
  const view: BackgroundTaskEventView = {
    id: 'btask_1', kind: 'plan-revision', status: 'running', title: 'Revise plan',
    workspaceRoot: '/w', sessionKey: 's', planId: 'pdec_1', phase: 'revising',
    transcript: { kind: 'task', id: 'btask_1' }, createdAt: 'a', updatedAt: 'b',
  };
  assert.equal(isBackgroundTaskEventView(view), true);
  assert.equal(isBackgroundTaskEventView({ id: 'x', kind: 'review' }), false);
  assert.equal(isBackgroundTaskEventView(null), false);
});

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

test('toExplicitConfirmDecision: preserves approve, decline, and dismissal semantics', () => {
  assert.equal(toExplicitConfirmDecision({ type: 'confirm', approved: true }), 'approved');
  assert.equal(toExplicitConfirmDecision({ type: 'confirm', approved: false }), 'declined');
  assert.equal(toExplicitConfirmDecision({ type: 'dismissed' }), 'dismissed');
  assert.equal(
    toExplicitConfirmDecision({ type: 'choice', labels: ['unexpected'] }),
    'dismissed',
    'an unexpected wire response must fail closed',
  );
});
