/**
 * MC-B2 — the flagship reflex, tested end-to-end at the resolver level: a real
 * GitHub `issue_comment` webhook payload that @mentions the handle turns into a
 * queued `build` fleet job whose instructions carry the ask + a draft-PR
 * delivery contract, and a "queued" comment is posted back. Every side-effect
 * port (queue, comment, payload read) is injected, so this runs fully offline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  resolveGithubTrigger,
  containsMention,
  DEFAULT_MENTION_HANDLE,
} from './github.js';
import type { AutomationRule } from '../rules.js';
import type { TriggerEvent, TriggerEventKind } from '../triggerTypes.js';
import type { CreateFleetJobInput, FleetJobRecord } from '../../fleet/fleetStore.js';

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'br-trigger-test-'));
}

/** A minimal-but-valid pending fleet job for the injected queue port. */
function pendingJob(input: CreateFleetJobInput): FleetJobRecord {
  return {
    id: 'job_test_1',
    kind: input.kind,
    status: 'pending',
    workspaceRoot: input.workspaceRoot,
    input: input.input ?? {},
    priority: input.priority ?? 0,
    attempts: 0,
    maxAttempts: input.maxAttempts ?? 1,
    idempotencyKey: input.idempotencyKey,
    output: {},
  } as FleetJobRecord;
}

/** Build a normalized github TriggerEvent (post-ingress, pre-resolve). */
function githubEvent(kind: TriggerEventKind, over: Partial<TriggerEvent> = {}): TriggerEvent {
  return {
    provider: 'github',
    kind,
    repo: 'kinqsradio/brainrouter',
    number: 42,
    sender: 'octocat',
    deliveryId: `delivery-${Math.random().toString(36).slice(2)}`,
    payloadRef: '', // unused: we inject readPayload below
    receivedAt: '2026-07-05T00:00:00.000Z',
    ...over,
  };
}

/** A real-shaped `issue_comment.created` payload body. */
function commentPayload(body: string) {
  return {
    action: 'created',
    issue: { number: 42, title: 'Login button does nothing on Safari' },
    comment: { id: 900123, body },
    repository: { full_name: 'kinqsradio/brainrouter' },
    sender: { login: 'octocat' },
  };
}

type Enqueued = { input: CreateFleetJobInput };
type Posted = { body: string };

function harness(payload: unknown, opts: { rules?: AutomationRule[]; handle?: string } = {}) {
  const workspaceRoot = tmpWorkspace();
  const enqueued: Enqueued[] = [];
  const posted: Posted[] = [];
  const options = {
    workspaceRoot,
    mentionHandle: opts.handle,
    rules: opts.rules ?? [],
    readPayload: () => payload,
    enqueue: (input: CreateFleetJobInput) => {
      enqueued.push({ input });
      return { job: pendingJob(input), deduped: false };
    },
    postComment: (_target: unknown, body: string) => { posted.push({ body }); return true; },
  };
  return { workspaceRoot, enqueued, posted, options };
}

// --- the pure mention matcher -------------------------------------------------

test('containsMention: whole-word, case-insensitive, @-prefixed', () => {
  assert.equal(containsMention('hey @brainrouter can you fix this', 'brainrouter'), true);
  assert.equal(containsMention('HEY @BrainRouter', 'brainrouter'), true);
  assert.equal(containsMention('@brainrouter-bot is different', 'brainrouter'), false); // word boundary
  assert.equal(containsMention('email brainrouter@x.com', 'brainrouter'), false);       // needs leading @
  assert.equal(containsMention('nothing to see here', 'brainrouter'), false);
  assert.equal(containsMention('@custombot go', '@custombot'), true);                    // handle may carry @
});

// --- the flagship path: @mention on an issue comment → build job --------------

test('@mention on an issue comment enqueues a build job + posts back', async () => {
  const { enqueued, posted, options } = harness(
    commentPayload(`@${DEFAULT_MENTION_HANDLE} please fix the Safari login bug and add a regression test`),
  );
  const result = await resolveGithubTrigger(githubEvent('comment.created'), options);

  assert.equal(result.action, 'enqueued');
  assert.equal(result.mentioned, true);
  assert.equal(enqueued.length, 1);

  const job = enqueued[0].input;
  assert.equal(job.kind, 'build');
  assert.equal(job.workspaceRoot, options.workspaceRoot);
  // Self-contained instructions: the repo, the ask, and the delivery contract.
  const instructions = String(job.input?.prompt ?? '');
  assert.match(instructions, /kinqsradio\/brainrouter#42/);
  assert.match(instructions, /Safari login bug/);
  assert.match(instructions, /draft PR/i);
  // A "queued" acknowledgement is posted back on the thread.
  assert.equal(posted.length, 1);
});

// --- negatives ----------------------------------------------------------------

test('a mention of a DIFFERENT handle does not fire', async () => {
  const { enqueued, options } = harness(commentPayload('@someone-else take a look'));
  const result = await resolveGithubTrigger(githubEvent('comment.created'), options);
  assert.equal(result.action, 'skipped');
  assert.equal(result.mentioned, false);
  assert.equal(enqueued.length, 0);
});

test('the mention path only fires for mention-eligible kinds', async () => {
  // A `pull_request.closed` carrying the handle in its body must NOT fire the
  // mention path (only issue.opened / comment.created / review.comment /
  // pull_request.opened are scanned).
  const { enqueued, options } = harness({
    action: 'closed',
    pull_request: { title: 'x', body: `cc @${DEFAULT_MENTION_HANDLE}`, head: { ref: 'feat/x' } },
    repository: { full_name: 'kinqsradio/brainrouter' },
  });
  const result = await resolveGithubTrigger(githubEvent('pull_request.closed' as TriggerEventKind), options);
  assert.equal(result.action, 'skipped');
  assert.equal(result.mentioned, false);
  assert.equal(enqueued.length, 0);
});

// --- the rules path (no mention needed) --------------------------------------

test('an automation rule fires on a labeled issue without any mention', async () => {
  const rule: AutomationRule = {
    id: 'fix-bugs',
    name: 'Fix labeled bugs',
    on: 'github.issue.labeled',
    when: "label == 'bug'",
    do: 'build',
    enabled: true,
    instructions: 'Reproduce first, then fix.',
    sourcePath: '/tmp/fix-bugs.md',
  };
  const payload = {
    action: 'labeled',
    label: 'bug',
    issue: { number: 42, title: 'Crash on empty input', body: 'Steps: …' },
    repository: { full_name: 'kinqsradio/brainrouter' },
  };
  const { enqueued, options } = harness(payload, { rules: [rule] });
  const result = await resolveGithubTrigger(githubEvent('issue.labeled' as TriggerEventKind), options);

  assert.equal(result.action, 'enqueued');
  assert.equal(result.mentioned, false);
  assert.deepEqual(result.matchedRules, ['fix-bugs']);
  assert.match(String(enqueued[0].input.input?.prompt ?? ''), /Reproduce first/);
});

test("a rule whose 'when' does not match is inert", async () => {
  const rule: AutomationRule = {
    id: 'fix-bugs', name: 'Fix labeled bugs', on: 'github.issue.labeled',
    when: "label == 'bug'", do: 'build', enabled: true, instructions: '', sourcePath: '/tmp/x.md',
  };
  const payload = { action: 'labeled', label: 'question', issue: { number: 42, title: 'q' }, repository: { full_name: 'kinqsradio/brainrouter' } };
  const { enqueued, options } = harness(payload, { rules: [rule] });
  const result = await resolveGithubTrigger(githubEvent('issue.labeled' as TriggerEventKind), options);
  assert.equal(result.action, 'skipped');
  assert.equal(enqueued.length, 0);
});

// --- idempotency: a GitHub redelivery (same delivery GUID) never double-runs --

test('a redelivered webhook (same deliveryId) is deduped, not re-enqueued', async () => {
  const { enqueued, options } = harness(
    commentPayload(`@${DEFAULT_MENTION_HANDLE} do the thing`),
  );
  const event = githubEvent('comment.created', { deliveryId: 'fixed-guid-123' });

  const first = await resolveGithubTrigger(event, options);
  assert.equal(first.action, 'enqueued');
  assert.equal(enqueued.length, 1);

  // Same delivery id arrives again (GitHub retries on 5xx) — no second job.
  const second = await resolveGithubTrigger(event, options);
  assert.equal(second.action, 'deduped');
  assert.equal(enqueued.length, 1);
});
