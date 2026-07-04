/**
 * MC-B4 — proactive CI-failure nudge tests. All offline: the comment port is
 * an injected fake, payloads are injected objects, and the persisted dedupe
 * cache runs against a temp workspace.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCliKnobs } from '../config/config.js';
import {
  ciNudgeCacheKey,
  createGithubTriggerSink,
  DEFAULT_MENTION_HANDLE,
  extractWorkflowRunContext,
  formatCiNudgeComment,
  hasSeenTriggerDelivery,
  resolveCiNudge,
  type CiNudgeResult,
  type GithubCommentTarget,
  type TriggerEvent,
} from '../triggers/index.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function tempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'br-ci-nudge-'));
}

function runEvent(over: Partial<TriggerEvent> = {}): TriggerEvent {
  return {
    provider: 'github',
    kind: 'workflow_run.completed',
    repo: 'acme/widgets',
    number: 41,
    sender: 'octocat',
    deliveryId: `guid-${Math.random().toString(36).slice(2)}`,
    payloadRef: '',
    receivedAt: '2026-07-04T00:00:00.000Z',
    ...over,
  };
}

function failedRunPayload(over: Record<string, unknown> = {}): unknown {
  return {
    action: 'completed',
    workflow_run: {
      name: 'CI',
      head_sha: 'abc123def456',
      conclusion: 'failure',
      pull_requests: [{ number: 41 }],
      ...over,
    },
  };
}

function fakeComments(ok = true): {
  posted: Array<{ target: GithubCommentTarget; body: string }>;
  post: (t: GithubCommentTarget, b: string) => boolean;
} {
  const posted: Array<{ target: GithubCommentTarget; body: string }> = [];
  return { posted, post: (target, body) => { posted.push({ target, body }); return ok; } };
}

// ---------------------------------------------------------------------------
// Happy path + per-head-sha idempotency
// ---------------------------------------------------------------------------

test('MC-B4 nudge: failed run on an open PR → one offer-to-fix comment; same sha never dups', async () => {
  const ws = tempWorkspace();
  const comments = fakeComments();
  const opts = {
    workspaceRoot: ws,
    enabled: true,
    readPayload: () => failedRunPayload(),
    postComment: comments.post,
  };

  const first = await resolveCiNudge(runEvent(), opts);
  assert.equal(first.action, 'nudged');
  assert.equal(comments.posted.length, 1);
  assert.deepEqual(comments.posted[0].target, { repo: 'acme/widgets', number: 41 });
  assert.equal(
    comments.posted[0].body,
    `CI failed on CI. Comment \`@${DEFAULT_MENTION_HANDLE} fix the failing checks\` and I will take a look.`,
    'the comment quotes the mention that loops back through the mention resolver',
  );

  // A re-run of the same workflow on the same head sha arrives as a brand-new
  // delivery — the nudge must still fire at most once per sha.
  const second = await resolveCiNudge(runEvent({ deliveryId: 'guid-different' }), opts);
  assert.equal(second.action, 'deduped');
  assert.equal(second.reason, 'already-nudged');
  assert.equal(comments.posted.length, 1, 'no duplicate comment for the same head sha');

  // The dedupe key lives in the shared delivery cache, keyed repo+sha+workflow.
  assert.equal(hasSeenTriggerDelivery(ws, ciNudgeCacheKey('acme/widgets', 'abc123def456', 'CI')), true);

  // A NEW head sha (the user pushed a fix that failed again) nudges again.
  const newSha = await resolveCiNudge(
    runEvent(),
    { ...opts, readPayload: () => failedRunPayload({ head_sha: 'fff999' }) },
  );
  assert.equal(newSha.action, 'nudged');
  assert.equal(comments.posted.length, 2);
});

test('MC-B4 nudge: a different workflow on the same sha is a separate nudge', async () => {
  const ws = tempWorkspace();
  const comments = fakeComments();
  const base = { workspaceRoot: ws, enabled: true, postComment: comments.post };
  await resolveCiNudge(runEvent(), { ...base, readPayload: () => failedRunPayload({ name: 'lint' }) });
  const other = await resolveCiNudge(runEvent(), { ...base, readPayload: () => failedRunPayload({ name: 'tests' }) });
  assert.equal(other.action, 'nudged');
  assert.equal(comments.posted.length, 2);
  assert.match(comments.posted[0].body, /CI failed on lint\./);
  assert.match(comments.posted[1].body, /CI failed on tests\./);
});

// ---------------------------------------------------------------------------
// Silent shapes: success, knob off, no open PR, wrong kind/provider
// ---------------------------------------------------------------------------

test('MC-B4 nudge: successful runs post nothing', async () => {
  const comments = fakeComments();
  const result = await resolveCiNudge(runEvent(), {
    workspaceRoot: tempWorkspace(),
    enabled: true,
    readPayload: () => failedRunPayload({ conclusion: 'success' }),
    postComment: comments.post,
  });
  assert.equal(result.action, 'skipped');
  assert.equal(result.reason, 'not-a-failure');
  assert.equal(comments.posted.length, 0);
});

test('MC-B4 nudge: knob off (the default) posts nothing even for a failure', async () => {
  const comments = fakeComments();
  const result = await resolveCiNudge(runEvent(), {
    workspaceRoot: tempWorkspace(),
    readPayload: () => failedRunPayload(),
    postComment: comments.post,
  });
  assert.equal(result.action, 'skipped');
  assert.equal(result.reason, 'disabled');
  assert.equal(comments.posted.length, 0);
});

test('MC-B4 nudge: runs not tied to an open PR are ignored', async () => {
  const comments = fakeComments();
  const base = { workspaceRoot: tempWorkspace(), enabled: true, postComment: comments.post };

  // No PR references at all (a push to a branch without a PR).
  const noPr = await resolveCiNudge(runEvent(), {
    ...base,
    readPayload: () => failedRunPayload({ pull_requests: [] }),
  });
  assert.equal(noPr.action, 'skipped');
  assert.equal(noPr.reason, 'no-open-pr');

  // Only closed-PR references.
  const closed = await resolveCiNudge(runEvent(), {
    ...base,
    readPayload: () => failedRunPayload({ pull_requests: [{ number: 41, state: 'closed' }] }),
  });
  assert.equal(closed.action, 'skipped');
  assert.equal(closed.reason, 'no-open-pr');
  assert.equal(comments.posted.length, 0);
});

test('MC-B4 nudge: wrong kind / wrong provider / missing sha stay silent', async () => {
  const comments = fakeComments();
  const base = {
    workspaceRoot: tempWorkspace(),
    enabled: true,
    readPayload: () => failedRunPayload(),
    postComment: comments.post,
  };
  assert.equal(
    (await resolveCiNudge(runEvent({ kind: 'workflow_run.requested' }), base)).reason,
    'not-workflow-run-completed',
  );
  assert.equal((await resolveCiNudge(runEvent({ provider: 'gitlab' }), base)).reason, 'not-github');
  const noSha = await resolveCiNudge(runEvent(), {
    ...base,
    readPayload: () => failedRunPayload({ head_sha: '' }),
  });
  assert.equal(noSha.reason, 'no-head-sha', 'no idempotency anchor → fail-closed, no comment');
  assert.equal(comments.posted.length, 0);
});

// ---------------------------------------------------------------------------
// Failed post is retryable (not remembered)
// ---------------------------------------------------------------------------

test('MC-B4 nudge: a failed comment post is not remembered — a redelivery may retry', async () => {
  const ws = tempWorkspace();
  const failing = fakeComments(false);
  const opts = { workspaceRoot: ws, enabled: true, readPayload: () => failedRunPayload() };

  const first = await resolveCiNudge(runEvent(), { ...opts, postComment: failing.post });
  assert.equal(first.action, 'skipped');
  assert.equal(first.reason, 'post-failed');
  assert.equal(hasSeenTriggerDelivery(ws, first.cacheKey ?? ''), false);

  // A throwing port is contained the same way.
  const thrown = await resolveCiNudge(runEvent(), {
    ...opts,
    postComment: () => { throw new Error('net down'); },
  });
  assert.equal(thrown.reason, 'post-failed');

  const working = fakeComments();
  const retry = await resolveCiNudge(runEvent(), { ...opts, postComment: working.post });
  assert.equal(retry.action, 'nudged');
  assert.equal(working.posted.length, 1);
});

// ---------------------------------------------------------------------------
// Sink composition
// ---------------------------------------------------------------------------

test('MC-B4 sink: createGithubTriggerSink fires the nudge only when ciNudge is true', async () => {
  const nudges: CiNudgeResult[] = [];
  const comments = fakeComments();
  // The workflow_run payload matches no rule and carries no mention, so the
  // main resolver skips — the nudge must still fire on the same sink pass.
  const payloadFile = path.join(tempWorkspace(), 'payload.json');
  fs.writeFileSync(payloadFile, JSON.stringify(failedRunPayload()));

  const on = createGithubTriggerSink({
    workspaceRoot: tempWorkspace(),
    ciNudge: true,
    postComment: comments.post,
    onNudged: (_event, result) => { nudges.push(result); },
  });
  await on(runEvent({ payloadRef: payloadFile }));
  assert.equal(nudges.length, 1);
  assert.equal(nudges[0].action, 'nudged');
  assert.equal(comments.posted.length, 1);
  assert.match(comments.posted[0].body, /CI failed on CI\./);

  const offNudges: CiNudgeResult[] = [];
  const offComments = fakeComments();
  const off = createGithubTriggerSink({
    workspaceRoot: tempWorkspace(),
    postComment: offComments.post,
    onNudged: (_event, result) => { offNudges.push(result); },
  });
  await off(runEvent({ payloadRef: payloadFile }));
  assert.equal(offNudges.length, 0, 'default-off: the nudge path never runs');
  assert.equal(offComments.posted.length, 0);
});

// ---------------------------------------------------------------------------
// Pure helpers + config knob
// ---------------------------------------------------------------------------

test('MC-B4 extraction: workflow_run payload shapes', () => {
  const full = extractWorkflowRunContext(failedRunPayload());
  assert.deepEqual(full, { workflow: 'CI', headSha: 'abc123def456', conclusion: 'failure', prNumber: 41 });

  // First OPEN reference wins; closed references are passed over.
  const mixed = extractWorkflowRunContext(failedRunPayload({
    pull_requests: [{ number: 3, state: 'closed' }, { number: 9, state: 'open' }],
  }));
  assert.equal(mixed.prNumber, 9);

  const junk = extractWorkflowRunContext(failedRunPayload({
    pull_requests: [null, { number: -1 }, { number: 'x' }],
  }));
  assert.equal(junk.prNumber, undefined);
  assert.deepEqual(
    extractWorkflowRunContext(null),
    { workflow: '', headSha: '', conclusion: '', prNumber: undefined },
    'null payload is safe',
  );
});

test('MC-B4 helpers: cache key + comment fallbacks', () => {
  assert.equal(ciNudgeCacheKey('a/b', 'sha1', 'CI'), 'ci-nudge:a/b@sha1:CI');
  assert.equal(
    formatCiNudgeComment('', '@robo'),
    'CI failed on CI. Comment `@robo fix the failing checks` and I will take a look.',
    'empty workflow name falls back; leading @ on the handle is stripped',
  );
  assert.match(formatCiNudgeComment('tests', ''), new RegExp(`@${DEFAULT_MENTION_HANDLE} fix`));
});

test('MC-B4 config: cli.triggers.ciNudge defaults false; explicit true only; junk stays off', () => {
  assert.equal(resolveCliKnobs(undefined).triggers.ciNudge, false);
  const on = resolveCliKnobs({
    activeServer: '', servers: {},
    cli: { triggers: { ciNudge: true } },
  } as never);
  assert.equal(on.triggers.ciNudge, true);
  const junk = resolveCliKnobs({
    activeServer: '', servers: {},
    cli: { triggers: { ciNudge: 'yes' } },
  } as never);
  assert.equal(junk.triggers.ciNudge, false, 'only an explicit boolean true enables');
});
