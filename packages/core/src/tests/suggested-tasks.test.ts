/**
 * MC-B6 — suggested-tasks scanner tests. All offline: the REST client is an
 * injected fixture-backed fake keyed by URL; credential-resolution failures
 * run against a temp workspace with a scrubbed env.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  countThreadsAwaitingAuthor,
  extractFailingCheckNames,
  pullHasMergeConflict,
  sanitizeSuggestionTitle,
  scanSuggestedTasks,
  type SuggestedTasksResult,
} from '../triggers/index.js';
import type { FetchLike } from '../track/githubSync/types.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function tempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'br-suggested-tasks-'));
}

/** Fixture fetch: exact-prefix URL → JSON payload; unmatched URLs 404. */
function fixtureFetch(fixtures: Record<string, unknown>): { fetchImpl: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    // Longest matching prefix wins (`/pulls/12` vs `/pulls/12/comments`).
    const key = Object.keys(fixtures)
      .filter((prefix) => url.startsWith(prefix))
      .sort((a, b) => b.length - a.length)[0];
    const found = key !== undefined;
    const payload = found ? fixtures[key] : { message: 'Not Found' };
    return {
      ok: found,
      status: found ? 200 : 404,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  };
  return { fetchImpl, calls };
}

const API = 'https://api.github.com/repos/acme/widgets';

function openPull(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 12,
    title: 'Add the frobnicator',
    html_url: 'https://github.com/acme/widgets/pull/12',
    head: { sha: 'headsha12' },
    user: { login: 'alice' },
    ...over,
  };
}

async function scan(fixtures: Record<string, unknown>): Promise<{ result: SuggestedTasksResult; calls: string[] }> {
  const { fetchImpl, calls } = fixtureFetch(fixtures);
  const result = await scanSuggestedTasks(tempWorkspace(), {
    fetchImpl,
    repo: 'acme/widgets',
    token: 'tok-test',
    mentionHandle: 'brainrouter',
  });
  return { result, calls };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('sanitizeSuggestionTitle collapses whitespace and caps length', () => {
  assert.equal(sanitizeSuggestionTitle('  a\n\tmessy\r\n title  '), 'a messy title');
  assert.equal(sanitizeSuggestionTitle(42), '');
  const long = sanitizeSuggestionTitle('x'.repeat(500));
  assert.equal(long.length, 160);
  assert.ok(long.endsWith('…'));
});

test('extractFailingCheckNames keeps only failure/timed_out conclusions, deduped + capped', () => {
  const names = extractFailingCheckNames({
    check_runs: [
      { name: 'CI', conclusion: 'failure' },
      { name: 'lint', conclusion: 'timed_out' },
      { name: 'CI', conclusion: 'failure' }, // dupe
      { name: 'build', conclusion: 'success' },
      { name: 'skip', conclusion: 'skipped' },
      { name: '', conclusion: 'failure' },
    ],
  });
  assert.deepEqual(names, ['CI', 'lint', 'unnamed check']);
  assert.deepEqual(extractFailingCheckNames({}), []);
  assert.deepEqual(extractFailingCheckNames(null), []);
});

test('pullHasMergeConflict: explicit false or dirty only — null/true/absent stay silent', () => {
  assert.equal(pullHasMergeConflict({ mergeable: false }), true);
  assert.equal(pullHasMergeConflict({ mergeable: null, mergeable_state: 'dirty' }), true);
  assert.equal(pullHasMergeConflict({ mergeable: true, mergeable_state: 'clean' }), false);
  assert.equal(pullHasMergeConflict({ mergeable: null, mergeable_state: 'unknown' }), false);
  assert.equal(pullHasMergeConflict({}), false);
});

test('countThreadsAwaitingAuthor: reviewer-last threads count, author-answered ones do not', () => {
  const comments = [
    { id: 1, user: { login: 'bob' } }, // thread 1 root: reviewer spoke last → waiting
    { id: 2, user: { login: 'carol' } }, // thread 2 root...
    { id: 3, in_reply_to_id: 2, user: { login: 'Alice' } }, // ...author answered (case-insensitive)
  ];
  assert.equal(countThreadsAwaitingAuthor(comments, 'alice'), 1);
  assert.equal(countThreadsAwaitingAuthor([], 'alice'), 0);
  assert.equal(countThreadsAwaitingAuthor(undefined, 'alice'), 0);
});

// ---------------------------------------------------------------------------
// Scanner — one fixture per suggestion kind
// ---------------------------------------------------------------------------

test('failing check runs on an open PR become a failing-checks suggestion with check names in the prompt', async () => {
  const { result } = await scan({
    [`${API}/pulls?state=open`]: [openPull()],
    [`${API}/commits/headsha12/check-runs`]: {
      check_runs: [
        { name: 'CI', conclusion: 'failure' },
        { name: 'lint', conclusion: 'timed_out' },
      ],
    },
    [`${API}/pulls/12/comments`]: [],
    [`${API}/pulls/12`]: { mergeable: true, mergeable_state: 'clean' },
    [`${API}/issues?state=open`]: [],
  });
  assert.equal(result.error, undefined);
  assert.equal(result.tasks.length, 1);
  const task = result.tasks[0];
  assert.equal(task.kind, 'failing-checks');
  assert.equal(task.repo, 'acme/widgets');
  assert.equal(task.number, 12);
  assert.equal(task.url, 'https://github.com/acme/widgets/pull/12');
  assert.match(task.title, /failing checks: CI, lint/);
  assert.match(task.suggestedPrompt, /^Fix the failing checks on PR #12 in acme\/widgets/);
  assert.match(task.suggestedPrompt, /CI, lint/);
});

test('an unmergeable open PR becomes a merge-conflict suggestion', async () => {
  const { result } = await scan({
    [`${API}/pulls?state=open`]: [openPull()],
    [`${API}/commits/headsha12/check-runs`]: { check_runs: [] },
    [`${API}/pulls/12/comments`]: [],
    [`${API}/pulls/12`]: { mergeable: false, mergeable_state: 'dirty' },
    [`${API}/issues?state=open`]: [],
  });
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].kind, 'merge-conflict');
  assert.match(result.tasks[0].suggestedPrompt, /^Resolve the merge conflicts on PR #12 in acme\/widgets/);
});

test('review threads where the reviewer spoke last become an unresolved-reviews suggestion', async () => {
  const { result } = await scan({
    [`${API}/pulls?state=open`]: [openPull()],
    [`${API}/commits/headsha12/check-runs`]: { check_runs: [] },
    [`${API}/pulls/12/comments`]: [
      { id: 100, user: { login: 'bob' } },
      { id: 101, in_reply_to_id: 100, user: { login: 'alice' } }, // answered
      { id: 200, user: { login: 'carol' } }, // still waiting
    ],
    [`${API}/pulls/12`]: { mergeable: true },
    [`${API}/issues?state=open`]: [],
  });
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].kind, 'unresolved-reviews');
  assert.match(result.tasks[0].title, /1 review thread/);
  assert.match(result.tasks[0].suggestedPrompt, /^Address the 1 open review thread/);
});

test('open issues labeled for the handle or good-first-issue become labeled-issue suggestions; PR-shaped rows and dupes drop', async () => {
  const { result } = await scan({
    [`${API}/pulls?state=open`]: [],
    [`${API}/issues?state=open&labels=brainrouter`]: [
      { number: 7, title: 'Fix the flaky timer', html_url: 'https://github.com/acme/widgets/issues/7' },
      { number: 8, title: 'PR in disguise', pull_request: { url: 'x' } },
    ],
    [`${API}/issues?state=open&labels=good%20first%20issue`]: [
      { number: 7, title: 'Fix the flaky timer' }, // dupe of the handle-labeled one
      { number: 9, title: 'Add a starter doc', html_url: 'https://github.com/acme/widgets/issues/9' },
    ],
  });
  assert.deepEqual(result.tasks.map((t) => [t.kind, t.number]), [
    ['labeled-issue', 7],
    ['labeled-issue', 9],
  ]);
  assert.match(result.tasks[0].suggestedPrompt, /^Work on issue #7 in acme\/widgets/);
  assert.match(result.tasks[1].title, /labeled "good first issue"/);
});

test('a quiet repo (no PRs, no labeled issues) yields an empty list and no error', async () => {
  const { result } = await scan({
    [`${API}/pulls?state=open`]: [],
    [`${API}/issues?state=open`]: [],
  });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.tasks, []);
});

test('sub-request failures degrade to warnings, not errors — the scan returns what it saw', async () => {
  const { result } = await scan({
    [`${API}/pulls?state=open`]: [openPull()],
    // check-runs, PR detail and comments all 404 → three warnings, no tasks
    [`${API}/issues?state=open&labels=brainrouter`]: [
      { number: 7, title: 'Still reachable', html_url: '' },
    ],
  });
  assert.equal(result.error, undefined);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].kind, 'labeled-issue');
  assert.ok(result.warnings.length >= 3);
});

test('no credential → clear error, and the network is never touched', async () => {
  const { fetchImpl, calls } = fixtureFetch({});
  const saved = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_TOKEN: process.env.GH_TOKEN };
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  try {
    const result = await scanSuggestedTasks(tempWorkspace(), { fetchImpl, repo: 'acme/widgets' });
    assert.equal(result.tasks.length, 0);
    assert.match(result.error ?? '', /No GitHub credential found for acme\/widgets/);
    assert.deepEqual(calls, []);
  } finally {
    if (saved.GITHUB_TOKEN !== undefined) process.env.GITHUB_TOKEN = saved.GITHUB_TOKEN;
    if (saved.GH_TOKEN !== undefined) process.env.GH_TOKEN = saved.GH_TOKEN;
  }
});

test('no linked repo → clear error, network untouched', async () => {
  const { fetchImpl, calls } = fixtureFetch({});
  const saved = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_TOKEN: process.env.GH_TOKEN };
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  try {
    const result = await scanSuggestedTasks(tempWorkspace(), { fetchImpl });
    assert.equal(result.tasks.length, 0);
    assert.ok(result.error);
    assert.deepEqual(calls, []);
  } finally {
    if (saved.GITHUB_TOKEN !== undefined) process.env.GITHUB_TOKEN = saved.GITHUB_TOKEN;
    if (saved.GH_TOKEN !== undefined) process.env.GH_TOKEN = saved.GH_TOKEN;
  }
});
