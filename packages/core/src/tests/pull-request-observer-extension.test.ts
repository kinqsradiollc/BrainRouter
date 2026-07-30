import test from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionHost, ExtensionToolDef } from '../extension/host.js';

interface ObserverModule {
  activate(host: ExtensionHost): Promise<void>;
  normalizePullRequestSnapshot(raw: unknown): {
    number: number;
    failed: Array<{ name: string }>;
    pending: Array<{ name: string }>;
    checksPassed: boolean;
  };
  pullRequestTransitionEvents(previous: unknown, current: unknown): Array<{
    kind: string;
    text: string;
  }>;
}

async function loadExtension(): Promise<ObserverModule> {
  const url = new URL('../../extensions/pull-request-observer/index.js', import.meta.url).href;
  return import(/* @vite-ignore */ url as string) as Promise<ObserverModule>;
}

test('pull-request observer normalizes GitHub check states', async () => {
  const extension = await loadExtension();
  const snapshot = extension.normalizePullRequestSnapshot({
    number: 42,
    title: 'Ship it',
    state: 'OPEN',
    statusCheckRollup: [
      { name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' },
      { context: 'legacy-status', state: 'ERROR' },
      { name: 'e2e', status: 'IN_PROGRESS', conclusion: '' },
    ],
  });

  assert.equal(snapshot.number, 42);
  assert.deepEqual(snapshot.failed.map((check) => check.name), ['lint', 'legacy-status']);
  assert.deepEqual(snapshot.pending.map((check) => check.name), ['e2e']);
  assert.equal(snapshot.checksPassed, false);
});

test('pull-request observer emits only material transitions', async () => {
  const extension = await loadExtension();
  const previous = extension.normalizePullRequestSnapshot({
    number: 42,
    title: 'Ship it',
    state: 'OPEN',
    reviewDecision: '',
    headRefOid: 'abc',
    statusCheckRollup: [{ name: 'unit', status: 'IN_PROGRESS', conclusion: '' }],
    comments: [],
    latestReviews: [],
  });
  const failed = extension.normalizePullRequestSnapshot({
    number: 42,
    title: 'Ship it',
    state: 'OPEN',
    reviewDecision: 'CHANGES_REQUESTED',
    headRefOid: 'abc',
    statusCheckRollup: [{ name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE' }],
    comments: [{ id: 'comment-1', author: { login: 'reviewer' }, body: 'Please fix this.' }],
    latestReviews: [{ id: 'review-1', author: { login: 'reviewer' }, state: 'CHANGES_REQUESTED' }],
  });

  assert.deepEqual(
    extension.pullRequestTransitionEvents(previous, failed).map((event) => event.kind),
    ['checks-failed', 'comments', 'reviews'],
  );
  assert.match(extension.pullRequestTransitionEvents(previous, failed)[0]!.text, /smallest valid fix/i);
  const serializedEvents = JSON.stringify(extension.pullRequestTransitionEvents(previous, failed));
  assert.doesNotMatch(serializedEvents, /Please fix this/);
  assert.doesNotMatch(serializedEvents, /Ship it/);
  assert.doesNotMatch(serializedEvents, /@reviewer/);
  assert.match(serializedEvents, /untrusted external data/i);
  assert.deepEqual(extension.pullRequestTransitionEvents(failed, failed), []);
  assert.deepEqual(
    extension.pullRequestTransitionEvents(null, failed).map((event) => event.kind),
    ['checks-failed', 'comments', 'reviews'],
    'feedback already present when a watcher starts is not silently treated as seen',
  );
});

test('pull-request observer registers one privileged, audited read tool', async () => {
  const tools = new Map<string, ExtensionToolDef>();
  const host: ExtensionHost = {
    workspaceRoot: '/tmp/workspace',
    version: 'test',
    log: () => {},
    registerTool: (definition) => tools.set(definition.name, definition),
    registerProvider: () => {},
    registerHook: () => {},
    registerPanel: () => {},
  };

  await (await loadExtension()).activate(host);
  const tool = tools.get('pull_request_watch');
  assert.ok(tool);
  assert.equal(tool.accessTier, 'read');
  assert.equal(tool.actionKind, 'network');
  assert.equal(tool.runtimePort, 'session-input');
  assert.equal(tool.audited, true);
});
