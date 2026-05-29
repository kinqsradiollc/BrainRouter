import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAgentEventMessages,
  emitAgentEvent,
  delegationDecisionEvent,
  agentOutputEvent,
  verificationResultEvent,
  reviewFindingEvent,
} from '../orchestration/memoryEvents.js';

/** MAS-P6-T1 — generalized delegation-aware event emitter. */

test('buildAgentEventMessages: kind-tagged user text + structured assistant JSON + activeSkill', () => {
  const m = buildAgentEventMessages({
    kind: 'agent_output',
    summary: 'worker: success on "x"',
    payload: { agentId: 'worker', outcome: 'success' },
  });
  assert.equal(m.userText, 'agent_output | worker: success on "x"');
  assert.equal(m.activeSkill, 'agent_output');
  const parsed = JSON.parse(m.assistantText);
  assert.equal(parsed.kind, 'agent_output');
  assert.equal(parsed.agentId, 'worker');
  assert.equal(parsed.outcome, 'success');
});

test('delegationDecisionEvent: routed vs queued', () => {
  const routed = delegationDecisionEvent({ task: 'fix x', agentKind: 'codex', routed: true, target: 'codex-b' });
  assert.equal(routed.kind, 'delegation_decision');
  assert.match(routed.summary, /routed to codex-b/);
  assert.equal(routed.payload.routed, true);
  assert.equal(routed.payload.target, 'codex-b');

  const queued = delegationDecisionEvent({ task: 'fix x', agentKind: 'codex', routed: false });
  assert.match(queued.summary, /queued/);
  assert.equal(queued.payload.target, null);
});

test('agentOutputEvent: nulls missing optional fields', () => {
  const e = agentOutputEvent({ agentId: 'reviewer', task: 'review diff', outcome: 'success' });
  assert.equal(e.payload.durationMs, null);
  assert.equal(e.payload.tokenCost, null);
  assert.equal(e.payload.preview, null);
  assert.match(e.summary, /reviewer: success/);
});

test('verificationResultEvent + reviewFindingEvent shapes', () => {
  const v = verificationResultEvent({ agentId: 'verifier', task: 't', passed: false, details: 'tests failed' });
  assert.equal(v.kind, 'verification_result');
  assert.match(v.summary, /FAIL/);
  assert.equal(v.payload.passed, false);

  const r = reviewFindingEvent({ file: 'src/a.ts', line: 42, severity: 'high', confidence: 90, summary: 'null deref' });
  assert.equal(r.kind, 'review_finding');
  assert.match(r.summary, /high @ src\/a\.ts:42 \(confidence 90\)/);
  assert.equal(r.payload.line, 42);
});

function captureClient() {
  const calls: Array<{ name: string; args: any }> = [];
  const client = {
    async listTools() {
      return { tools: [{ name: 'memory_capture_turn' }] };
    },
    async callTool(name: string, args: any) {
      calls.push({ name, args });
      return { isError: false, content: [{ type: 'text', text: JSON.stringify({ recordId: 'rec-ev' }) }] };
    },
  } as any;
  return { client, calls };
}

test('emitAgentEvent: routes through memory_capture_turn; offline → null', async () => {
  const { client, calls } = captureClient();
  const id = await emitAgentEvent(
    { mcpClient: client, sessionKey: 'sk' },
    delegationDecisionEvent({ task: 'do x', agentKind: 'codex', routed: true, target: 'codex-b' }),
  );
  assert.equal(id, 'rec-ev');
  assert.equal(calls[0].name, 'memory_capture_turn');
  assert.equal(calls[0].args.activeSkill, 'delegation_decision');
  assert.match(calls[0].args.messages[0].content, /delegation_decision \|/);

  const offline = await emitAgentEvent(
    { mcpClient: undefined, sessionKey: 'sk' },
    agentOutputEvent({ agentId: 'w', task: 't', outcome: 'success' }),
  );
  assert.equal(offline, null);
});
