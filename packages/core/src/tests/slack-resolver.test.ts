import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CreateFleetJobInput, FleetJobRecord } from '../fleet/fleetStore.js';
import {
  getSlackThreadRecord,
  resolveSlackTrigger,
  slackThreadKey,
  type TriggerEvent,
} from '../triggers/index.js';

function tempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'br-slack-resolver-'));
}

function triggerEvent(over: Partial<TriggerEvent> = {}): TriggerEvent {
  return {
    provider: 'slack',
    kind: 'chat.mention',
    repo: 'acme/widgets',
    sender: 'U1',
    deliveryId: 'Ev1',
    payloadRef: '',
    receivedAt: '2026-07-04T00:00:00.000Z',
    ...over,
  };
}

function payload(text: string, over: Record<string, unknown> = {}) {
  return {
    type: 'event_callback',
    team_id: 'T1',
    event: {
      type: 'app_mention',
      user: 'U1',
      channel: 'C1',
      ts: '1767225600.000000',
      text,
      ...over,
    },
  };
}

function fakeQueue() {
  const calls: CreateFleetJobInput[] = [];
  return {
    calls,
    enqueue: (input: CreateFleetJobInput) => {
      calls.push(input);
      const at = '2026-07-04T00:00:00.000Z';
      const job: FleetJobRecord = {
        id: `fleet_slack_${calls.length}`,
        kind: input.kind,
        status: 'pending',
        workspaceRoot: input.workspaceRoot,
        input: input.input ?? {},
        priority: input.priority ?? 0,
        attempts: 0,
        maxAttempts: input.maxAttempts ?? 3,
        idempotencyKey: input.idempotencyKey,
        createdAt: at,
        updatedAt: at,
      };
      return { job, deduped: false };
    },
  };
}

test('Slack resolver: app mention enqueues a build job and records thread continuity', async () => {
  const ws = tempWorkspace();
  const queue = fakeQueue();
  const result = await resolveSlackTrigger(triggerEvent(), {
    workspaceRoot: ws,
    readPayload: () => payload('<@UAPP> fix the failing tests in repo acme/widgets'),
    enqueue: queue.enqueue,
    now: () => '2026-07-04T00:00:00.000Z',
  });

  assert.equal(result.action, 'enqueued');
  assert.equal(result.continued, false);
  assert.equal(queue.calls.length, 1);
  const job = queue.calls[0];
  assert.equal(job.kind, 'build');
  assert.equal(job.idempotencyKey, 'trigger:slack:Ev1');
  const input = job.input as Record<string, unknown>;
  assert.equal(input.source, 'trigger:slack');
  assert.equal(input.delivery, 'pr-emit');
  assert.equal(input.repo, 'acme/widgets');
  assert.match(String(input.prompt), /Slack trigger: chat\.mention/);
  assert.match(String(input.prompt), /fix the failing tests/);
  assert.equal(input.conversationId, result.conversationId);
  assert.equal(input.sessionKey, `session:${result.conversationId}`);

  const key = slackThreadKey('T1', 'C1', '1767225600.000000');
  const stored = getSlackThreadRecord(ws, key);
  assert.equal(stored?.conversationId, result.conversationId);
  assert.equal(stored?.repo, 'acme/widgets');
});

test('Slack resolver: reply in a mapped thread continues the same conversation without a new mention', async () => {
  const ws = tempWorkspace();
  const queue = fakeQueue();
  const first = await resolveSlackTrigger(triggerEvent({ deliveryId: 'Ev1' }), {
    workspaceRoot: ws,
    readPayload: () => payload('<@UAPP> start on repo acme/widgets'),
    enqueue: queue.enqueue,
    now: () => '2026-07-04T00:00:00.000Z',
  });
  const second = await resolveSlackTrigger(triggerEvent({ kind: 'chat.message', deliveryId: 'Ev2', sender: 'U2' }), {
    workspaceRoot: ws,
    readPayload: () => payload('also update the related docs', {
      type: 'message',
      user: 'U2',
      ts: '1767225660.000000',
      thread_ts: '1767225600.000000',
    }),
    enqueue: queue.enqueue,
    now: () => '2026-07-04T00:01:00.000Z',
  });

  assert.equal(second.action, 'enqueued');
  assert.equal(second.continued, true);
  assert.equal(second.conversationId, first.conversationId);
  const input = queue.calls[1].input as Record<string, unknown>;
  assert.equal(input.conversationId, first.conversationId);
  assert.equal((input.trigger as Record<string, unknown>).continued, true);
  assert.match(String(input.prompt), /Continue the existing Slack thread conversation/);
});

test('Slack resolver: unmentioned message in an unmapped thread stays inert', async () => {
  const queue = fakeQueue();
  const result = await resolveSlackTrigger(triggerEvent({ kind: 'chat.message', deliveryId: 'Ev3' }), {
    workspaceRoot: tempWorkspace(),
    readPayload: () => payload('hello repo acme/widgets', { type: 'message' }),
    enqueue: queue.enqueue,
  });
  assert.equal(result.action, 'skipped');
  assert.equal(result.reason, 'no-mention-no-thread');
  assert.equal(queue.calls.length, 0);
});
