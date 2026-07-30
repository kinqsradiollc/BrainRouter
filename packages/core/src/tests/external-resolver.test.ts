import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CreateFleetJobInput, FleetJobRecord } from '../fleet/fleetStore.js';
import { resolveExternalTrigger, type AutomationRule, type TriggerEvent } from '../triggers/index.js';

function tempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'br-external-resolver-'));
}

function triggerEvent(provider: 'gitlab' | 'jira', over: Partial<TriggerEvent> = {}): TriggerEvent {
  return {
    provider,
    kind: 'comment.created',
    repo: 'acme/widgets',
    number: 42,
    sender: 'dev',
    deliveryId: `${provider}-delivery`,
    payloadRef: '',
    receivedAt: '2026-07-04T00:00:00.000Z',
    ...over,
  };
}

function rule(over: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: 'build-on-provider-label',
    name: 'Build on provider label',
    on: 'gitlab.issue.labeled',
    when: "label == 'brainrouter'",
    do: 'build',
    enabled: true,
    instructions: 'Use the provider issue details.',
    sourcePath: '/x/build.md',
    ...over,
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
        id: `fleet_external_${calls.length}`,
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

test('GitLab resolver parity: mention comment enqueues existing fleet build PR delivery', async () => {
  const ws = tempWorkspace();
  const queue = fakeQueue();
  const result = await resolveExternalTrigger(triggerEvent('gitlab'), {
    workspaceRoot: ws,
    rules: [],
    readPayload: () => ({
      object_kind: 'note',
      project: { path_with_namespace: 'acme/widgets' },
      object_attributes: {
        id: 77,
        noteable_iid: 42,
        note: '@brainrouter fix the failing merge request',
        title: 'Review failure',
        source_branch: 'feature/mr',
      },
    }),
    enqueue: queue.enqueue,
  });

  assert.equal(result.action, 'enqueued');
  assert.equal(result.mentioned, true);
  assert.equal(queue.calls.length, 1);
  const job = queue.calls[0];
  assert.equal(job.kind, 'build');
  assert.equal(job.idempotencyKey, 'trigger:gitlab:gitlab-delivery');
  const input = job.input as Record<string, unknown>;
  assert.equal(input.source, 'trigger:gitlab');
  assert.equal(input.delivery, 'pr-emit');
  assert.equal(input.repo, 'acme/widgets');
  assert.equal(input.baseBranch, 'feature/mr');
  assert.match(String(input.prompt), /Gitlab trigger: comment\.created/);
  assert.match(String(input.prompt), /failing merge request/);
});

test('GitLab resolver parity: automation rule match enqueues without a mention', async () => {
  const queue = fakeQueue();
  const result = await resolveExternalTrigger(triggerEvent('gitlab', { kind: 'issue.labeled', deliveryId: 'gl-label' }), {
    workspaceRoot: tempWorkspace(),
    rules: [rule()],
    readPayload: () => ({
      label: { name: 'brainrouter' },
      object_attributes: { iid: 5, title: 'Broken test', description: 'Fails on CI.' },
    }),
    enqueue: queue.enqueue,
  });

  assert.equal(result.action, 'enqueued');
  assert.deepEqual(result.matchedRules, ['build-on-provider-label']);
  const input = queue.calls[0].input as Record<string, unknown>;
  assert.equal(input.source, 'trigger:gitlab');
  assert.match(String(input.prompt), /Use the provider issue details/);
});

test('Jira resolver parity: comment mention enqueues the same fleet build shape', async () => {
  const queue = fakeQueue();
  const result = await resolveExternalTrigger(triggerEvent('jira', { deliveryId: 'jira-1', sender: 'u-1' }), {
    workspaceRoot: tempWorkspace(),
    rules: [],
    readPayload: () => ({
      webhookEvent: 'comment_created',
      repo: 'acme/widgets',
      user: { accountId: 'u-1' },
      comment: { id: 100, body: '@brainrouter please fix the Jira-linked bug' },
      issue: { id: '10001', key: 'BR-7', fields: { summary: 'Jira-linked bug' } },
    }),
    enqueue: queue.enqueue,
  });

  assert.equal(result.action, 'enqueued');
  assert.equal(result.mentioned, true);
  const job = queue.calls[0];
  assert.equal(job.kind, 'build');
  assert.equal(job.idempotencyKey, 'trigger:jira:jira-1');
  const input = job.input as Record<string, unknown>;
  assert.equal(input.source, 'trigger:jira');
  assert.equal(input.delivery, 'pr-emit');
  assert.equal(input.repo, 'acme/widgets');
  assert.match(String(input.prompt), /Jira trigger: comment\.created/);
  assert.match(String(input.prompt), /Jira-linked bug/);
});
