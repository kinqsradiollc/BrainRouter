/**
 * MC-B2 — GitHub resolver + post-back tests. All offline: the fleet queue
 * and the REST comment client are injected fakes, payloads live in temp
 * files, and the delivery cache runs against a temp workspace.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CreateFleetJobInput, FleetJobRecord } from '../fleet/fleetStore.js';
import { resolveCliKnobs } from '../config/config.js';
import {
  containsMention,
  DEFAULT_MENTION_HANDLE,
  extractGithubTriggerContext,
  fleetJobOutcome,
  formatTriggerPostback,
  hasSeenTriggerDelivery,
  markTriggerDeliverySeen,
  normalizeGithubEvent,
  postGithubIssueComment,
  resolveGithubTrigger,
  TRIGGER_DELIVERY_CACHE_MAX,
  TRIGGER_INSTRUCTION_MAX_CHARS,
  watchTriggerJob,
  type AutomationRule,
  type GithubCommentTarget,
  type TriggerEvent,
} from '../triggers/index.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function tempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'br-gh-resolver-'));
}

function triggerEvent(over: Partial<TriggerEvent> = {}): TriggerEvent {
  return {
    provider: 'github',
    kind: 'issue.labeled',
    repo: 'acme/widgets',
    number: 41,
    sender: 'octocat',
    payloadRef: '',
    receivedAt: '2026-07-04T00:00:00.000Z',
    ...over,
  };
}

function rule(over: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: 'build-on-label',
    name: 'Build on label',
    on: 'github.issue.labeled',
    when: "label == 'brainrouter'",
    do: 'build',
    enabled: true,
    instructions: 'Focus on the failing suite first.',
    sourcePath: '/x/build-on-label.md',
    ...over,
  };
}

interface FakeQueue {
  calls: CreateFleetJobInput[];
  enqueue: (input: CreateFleetJobInput) => { job: FleetJobRecord; deduped: boolean };
}

function fakeQueue(): FakeQueue {
  const calls: CreateFleetJobInput[] = [];
  return {
    calls,
    enqueue: (input) => {
      calls.push(input);
      const at = '2026-07-04T00:00:00.000Z';
      return {
        deduped: false,
        job: {
          id: `fleet_test${calls.length}`,
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
        },
      };
    },
  };
}

function fakeComments(): { posted: Array<{ target: GithubCommentTarget; body: string }>; post: (t: GithubCommentTarget, b: string) => boolean } {
  const posted: Array<{ target: GithubCommentTarget; body: string }> = [];
  return { posted, post: (target, body) => { posted.push({ target, body }); return true; } };
}

// ---------------------------------------------------------------------------
// Label + rule → job + queued comment
// ---------------------------------------------------------------------------

test('MC-B2 resolver: label event with matching rule → self-contained job spec + queued comment', async () => {
  const ws = tempWorkspace();
  const queue = fakeQueue();
  const comments = fakeComments();
  const result = await resolveGithubTrigger(
    triggerEvent({ deliveryId: 'guid-1' }),
    {
      workspaceRoot: ws,
      rules: [rule()],
      readPayload: () => ({
        label: { name: 'brainrouter' },
        issue: { number: 41, title: 'Fix the flaky spec', body: 'The suite fails on CI.' },
      }),
      enqueue: queue.enqueue,
      postComment: comments.post,
    },
  );

  assert.equal(result.action, 'enqueued');
  assert.deepEqual(result.matchedRules, ['build-on-label']);
  assert.equal(queue.calls.length, 1);
  const job = queue.calls[0];
  assert.equal(job.kind, 'build', 'reuses the existing fleet build executor kind');
  assert.equal(job.workspaceRoot, ws);
  assert.equal(job.idempotencyKey, 'trigger:github:guid-1');
  const input = job.input as Record<string, unknown>;
  assert.equal(input.source, 'trigger:github');
  assert.equal(input.delivery, 'pr-emit');
  assert.equal(input.repo, 'acme/widgets');
  assert.equal(input.title, 'acme/widgets#41: Fix the flaky spec');
  const prompt = String(input.prompt);
  assert.match(prompt, /issue\.labeled on acme\/widgets#41/, 'names the originating event');
  assert.match(prompt, /The suite fails on CI\./, 'carries the issue body');
  assert.match(prompt, /Focus on the failing suite first\./, 'carries the rule instructions');
  assert.match(prompt, /reviewable draft PR/, 'states the PR delivery contract');
  const trigger = input.trigger as Record<string, unknown>;
  assert.equal(trigger.deliveryId, 'guid-1');
  assert.deepEqual(trigger.rules, ['build-on-label']);

  assert.equal(comments.posted.length, 1, 'queued comment posted');
  assert.deepEqual(comments.posted[0].target, { repo: 'acme/widgets', number: 41 });
  assert.match(comments.posted[0].body, /queued/);
  assert.match(comments.posted[0].body, /fleet_test1/);
});

test('MC-B2 resolver: no matching rule and no mention → no job, no comment', async () => {
  const queue = fakeQueue();
  const comments = fakeComments();
  const result = await resolveGithubTrigger(
    triggerEvent({ deliveryId: 'guid-2' }),
    {
      workspaceRoot: tempWorkspace(),
      rules: [rule({ when: "label == 'other'" })],
      readPayload: () => ({ label: { name: 'brainrouter' } }),
      enqueue: queue.enqueue,
      postComment: comments.post,
    },
  );
  assert.equal(result.action, 'skipped');
  assert.equal(result.reason, 'no-rule-no-mention');
  assert.equal(queue.calls.length, 0);
  assert.equal(comments.posted.length, 0);
});

// ---------------------------------------------------------------------------
// @mention paths
// ---------------------------------------------------------------------------

test('MC-B2 resolver: @mention in an inline PR review comment → job with the PR branch', async () => {
  const queue = fakeQueue();
  const comments = fakeComments();
  const result = await resolveGithubTrigger(
    triggerEvent({ kind: 'review.comment', number: 7, deliveryId: 'guid-3' }),
    {
      workspaceRoot: tempWorkspace(),
      rules: [], // NO rules — the mention alone fires
      readPayload: () => ({
        comment: { id: 991, body: `@${DEFAULT_MENTION_HANDLE} please tighten this loop` },
        pull_request: { number: 7, title: 'Speed up recall', head: { ref: 'feat/recall-speed' } },
      }),
      enqueue: queue.enqueue,
      postComment: comments.post,
    },
  );
  assert.equal(result.action, 'enqueued');
  assert.equal(result.mentioned, true);
  const input = queue.calls[0].input as Record<string, unknown>;
  assert.equal(input.baseBranch, 'feat/recall-speed', 'targets the PR head branch');
  assert.match(String(input.prompt), /tighten this loop/);
  assert.equal(comments.posted.length, 1);
});

test('MC-B2 resolver: mention handle is configurable and non-mention comments stay inert', async () => {
  const ws = tempWorkspace();
  const queue = fakeQueue();
  const payload = { comment: { id: 5, body: '@robo take a look' }, issue: { number: 3, title: 'T' } };
  const opts = {
    workspaceRoot: ws,
    rules: [] as AutomationRule[],
    readPayload: () => payload,
    enqueue: queue.enqueue,
  };
  const wrongHandle = await resolveGithubTrigger(triggerEvent({ kind: 'comment.created', number: 3 }), opts);
  assert.equal(wrongHandle.action, 'skipped', 'default handle does not match @robo');
  const right = await resolveGithubTrigger(
    triggerEvent({ kind: 'comment.created', number: 3 }),
    { ...opts, mentionHandle: 'robo' },
  );
  assert.equal(right.action, 'enqueued');

  // Whole-word matching: '@brainrouterx' is not a mention of '@brainrouter'.
  assert.equal(containsMention('cc @brainrouterx', DEFAULT_MENTION_HANDLE), false);
  assert.equal(containsMention('cc @BrainRouter please', DEFAULT_MENTION_HANDLE), true, 'case-insensitive');
  assert.equal(containsMention('cc @robo', ''), false, 'empty handle can never match');
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test('MC-B2 resolver: duplicate delivery-id → single job (redelivery is a no-op)', async () => {
  const ws = tempWorkspace();
  const queue = fakeQueue();
  const comments = fakeComments();
  const opts = {
    workspaceRoot: ws,
    rules: [rule({ when: '' })],
    readPayload: () => ({ issue: { number: 41, title: 'X', body: 'Y' } }),
    enqueue: queue.enqueue,
    postComment: comments.post,
  };
  const first = await resolveGithubTrigger(triggerEvent({ deliveryId: 'guid-dup' }), opts);
  const second = await resolveGithubTrigger(triggerEvent({ deliveryId: 'guid-dup' }), opts);
  assert.equal(first.action, 'enqueued');
  assert.equal(second.action, 'deduped');
  assert.equal(second.reason, 'delivery-replay');
  assert.equal(queue.calls.length, 1, 'exactly one job for the redelivered webhook');
  assert.equal(comments.posted.length, 1, 'no second queued comment');
});

test('MC-B2 resolver: skipped deliveries are remembered too; cache is bounded', () => {
  const ws = tempWorkspace();
  assert.equal(hasSeenTriggerDelivery(ws, 'a'), false);
  markTriggerDeliverySeen(ws, 'a');
  assert.equal(hasSeenTriggerDelivery(ws, 'a'), true);
  assert.equal(hasSeenTriggerDelivery(ws, ''), false, 'empty id never matches');
  for (let i = 0; i < TRIGGER_DELIVERY_CACHE_MAX + 10; i += 1) markTriggerDeliverySeen(ws, `id-${i}`);
  assert.equal(hasSeenTriggerDelivery(ws, 'a'), false, 'oldest ids age out');
  assert.equal(hasSeenTriggerDelivery(ws, `id-${TRIGGER_DELIVERY_CACHE_MAX + 9}`), true);
});

test('MC-B2 resolver: non-github events and comment failures are contained', async () => {
  const queue = fakeQueue();
  const gitlab = await resolveGithubTrigger(
    triggerEvent({ provider: 'gitlab' }),
    { workspaceRoot: tempWorkspace(), rules: [rule()], readPayload: () => ({}), enqueue: queue.enqueue },
  );
  assert.equal(gitlab.action, 'skipped');
  assert.equal(gitlab.reason, 'not-github');

  // A throwing comment port never undoes the enqueue.
  const result = await resolveGithubTrigger(
    triggerEvent({ kind: 'comment.created', deliveryId: 'guid-cf' }),
    {
      workspaceRoot: tempWorkspace(),
      rules: [],
      readPayload: () => ({ comment: { id: 1, body: `@${DEFAULT_MENTION_HANDLE} fix it` } }),
      enqueue: queue.enqueue,
      postComment: () => { throw new Error('boom'); },
    },
  );
  assert.equal(result.action, 'enqueued');
});

// ---------------------------------------------------------------------------
// Instruction hygiene
// ---------------------------------------------------------------------------

test('MC-B2 resolver: instruction text is redacted and bounded', async () => {
  const queue = fakeQueue();
  await resolveGithubTrigger(
    triggerEvent({ kind: 'comment.created', deliveryId: 'guid-red' }),
    {
      workspaceRoot: tempWorkspace(),
      rules: [],
      readPayload: () => ({
        comment: {
          id: 2,
          body: `@${DEFAULT_MENTION_HANDLE} use ghp_ABCDEF1234567890ABCDEF1234567890ABCD ` + 'x'.repeat(TRIGGER_INSTRUCTION_MAX_CHARS),
        },
      }),
      enqueue: queue.enqueue,
    },
  );
  const prompt = String((queue.calls[0].input as Record<string, unknown>).prompt);
  assert.ok(!prompt.includes('ghp_ABCDEF1234567890ABCDEF1234567890ABCD'), 'token shape never enters the queue');
  assert.ok(prompt.length <= TRIGGER_INSTRUCTION_MAX_CHARS, 'prompt is bounded');
});

// ---------------------------------------------------------------------------
// Delivery-id plumbing (provider → event)
// ---------------------------------------------------------------------------

test('MC-B2 provider: x-github-delivery flows into the normalized event', () => {
  const normalized = normalizeGithubEvent(
    { 'x-github-event': 'issues', 'x-github-delivery': 'guid-42' },
    { action: 'labeled', repository: { full_name: 'acme/widgets' }, issue: { number: 1 }, sender: { login: 'o' } },
  );
  assert.ok(normalized);
  assert.equal(normalized.deliveryId, 'guid-42');
  const without = normalizeGithubEvent({ 'x-github-event': 'ping' }, {});
  assert.ok(without);
  assert.equal(without.deliveryId, undefined);
});

// ---------------------------------------------------------------------------
// Post-back: formatter, REST call, completion watcher
// ---------------------------------------------------------------------------

test('MC-B2 postback: outcome formatting covers every phase', () => {
  assert.match(formatTriggerPostback({ phase: 'queued', jobId: 'fleet_1' }), /queued[\s\S]*fleet_1/);
  assert.match(formatTriggerPostback({ phase: 'started' }), /working on it/);
  assert.match(formatTriggerPostback({ phase: 'pr-opened', prUrl: 'https://example.test/pr/9' }), /opened https:\/\/example\.test\/pr\/9/);
  assert.match(formatTriggerPostback({ phase: 'done', error: 'no changes' }), /without a PR \(no changes\)/);
  assert.match(formatTriggerPostback({ phase: 'failed', error: 'verify red' }), /failed: verify red/);
});

test('MC-B2 postback: fleetJobOutcome maps queue statuses onto phases', () => {
  const base: FleetJobRecord = {
    id: 'fleet_x', kind: 'build', status: 'pending', workspaceRoot: '/w', input: {},
    priority: 0, attempts: 0, maxAttempts: 3, createdAt: 't', updatedAt: 't',
  };
  assert.equal(fleetJobOutcome(base).phase, 'queued');
  assert.equal(fleetJobOutcome({ ...base, status: 'running' }).phase, 'started');
  assert.deepEqual(
    fleetJobOutcome({ ...base, status: 'done', output: { prUrl: 'https://x/pr/1' } }),
    { phase: 'pr-opened', jobId: 'fleet_x', prUrl: 'https://x/pr/1' },
  );
  assert.equal(fleetJobOutcome({ ...base, status: 'done', output: { skipped: 'no changes' } }).phase, 'done');
  assert.equal(fleetJobOutcome({ ...base, status: 'failed', error: 'boom' }).phase, 'failed');
  assert.equal(fleetJobOutcome({ ...base, status: 'cancelled' }).phase, 'failed');
});

test('MC-B2 postback: REST comment call is fail-safe and correctly shaped', async () => {
  const calls: Array<{ url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }> = [];
  const fetchImpl = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    calls.push({ url, init });
    return { ok: true, status: 201, json: async () => ({}), text: async () => '' };
  };
  const ok = await postGithubIssueComment(
    { fetchImpl, token: 'tkn' },
    { repo: 'acme/widgets', number: 41 },
    'hello',
  );
  assert.equal(ok, true);
  assert.equal(calls[0].url, 'https://api.github.com/repos/acme/widgets/issues/41/comments');
  assert.equal(calls[0].init?.method, 'POST');
  assert.equal(calls[0].init?.headers?.Authorization, 'Bearer tkn');
  assert.deepEqual(JSON.parse(calls[0].init?.body ?? '{}'), { body: 'hello' });

  assert.equal(await postGithubIssueComment({ fetchImpl, token: '' }, { repo: 'a/b', number: 1 }, 'x'), false, 'no token → no call');
  const failing = async () => { throw new Error('net down'); };
  assert.equal(
    await postGithubIssueComment({ fetchImpl: failing as never, token: 't' }, { repo: 'a/b', number: 1 }, 'x'),
    false,
    'network failure → false, never throws',
  );
});

test('MC-B2 postback: watcher polls to terminal, gives up on deadline/missing job', async () => {
  const base: FleetJobRecord = {
    id: 'fleet_w', kind: 'build', status: 'running', workspaceRoot: '/w', input: {},
    priority: 0, attempts: 1, maxAttempts: 3, createdAt: 't', updatedAt: 't',
  };
  let polls = 0;
  const outcome = await watchTriggerJob('fleet_w', {
    getJob: () => {
      polls += 1;
      return polls < 3 ? base : { ...base, status: 'done', output: { prUrl: 'https://x/pr/2' } };
    },
    intervalMs: 1,
    sleep: async () => {},
  });
  assert.deepEqual(outcome, { phase: 'pr-opened', jobId: 'fleet_w', prUrl: 'https://x/pr/2' });
  assert.equal(polls, 3);

  assert.equal(await watchTriggerJob('gone', { getJob: () => undefined }), null, 'missing job → null');
  assert.equal(
    await watchTriggerJob('slow', { getJob: () => base, intervalMs: 1, timeoutMs: 1, sleep: async () => {} }),
    null,
    'deadline passes → null',
  );
});

// ---------------------------------------------------------------------------
// Config knob
// ---------------------------------------------------------------------------

test('MC-B2 config: cli.triggers.mentionHandle validates — default, trim, @-strip, junk dropped', () => {
  assert.equal(resolveCliKnobs(undefined).triggers.mentionHandle, 'brainrouter');
  const custom = resolveCliKnobs({
    activeServer: '', servers: {},
    cli: { triggers: { mentionHandle: '  @robo  ' } },
  } as never);
  assert.equal(custom.triggers.mentionHandle, 'robo');
  const junk = resolveCliKnobs({
    activeServer: '', servers: {},
    cli: { triggers: { mentionHandle: 42 } },
  } as never);
  assert.equal(junk.triggers.mentionHandle, 'brainrouter');
});

// ---------------------------------------------------------------------------
// Context extraction
// ---------------------------------------------------------------------------

test('MC-B2 extraction: comment vs issue vs PR payload shapes', () => {
  const comment = extractGithubTriggerContext('comment.created', {
    comment: { id: 9, body: 'do it' },
    issue: { title: 'T', body: 'issue body' },
  });
  assert.equal(comment.text, 'do it', 'comment events prefer the comment body');
  assert.equal(comment.title, 'T');
  assert.equal(comment.commentId, 9);

  const labeled = extractGithubTriggerContext('issue.labeled', { issue: { title: 'T', body: 'issue body' } });
  assert.equal(labeled.text, 'issue body');

  const pr = extractGithubTriggerContext('pull_request.opened', {
    pull_request: { title: 'P', body: 'pr body', head: { ref: 'feat/x' } },
  });
  assert.equal(pr.text, 'pr body');
  assert.equal(pr.prBranch, 'feat/x');
  assert.equal(extractGithubTriggerContext('issue.labeled', null).text, '', 'null payload is safe');
});
