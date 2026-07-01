import test from 'node:test';
import assert from 'node:assert/strict';
import type { ConnectorRecord } from '@kinqs/brainrouter-types';
import {
  GITLAB_PAGE_SIZE,
  gitlabTokenClient,
  runGitlabConnectorCheckpoint,
  type GitlabConnectorClient,
} from '../connectors/gitlabConnector.js';

function connector(overrides?: Partial<ConnectorRecord>): ConnectorRecord {
  return {
    id: 'conn_gl',
    source: 'gitlab',
    name: 'GitLab',
    status: 'active',
    config: {
      owner: 'kinqs',
      projects: ['brainrouter'],
      includeIssues: true,
      includeMergeRequests: true,
    },
    credential: { mode: 'static', ref: 'gitlabToken' },
    flows: ['checkpoint'],
    workspaceRoot: '/tmp/workspace',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('runGitlabConnectorCheckpoint maps issues, merge requests, and checkpoint state', async () => {
  const calls: string[] = [];
  const client: GitlabConnectorClient = {
    async listProjects() {
      throw new Error('should not list owner projects when projects are configured');
    },
    async listIssues(project, opts) {
      calls.push(`issues:${project}:${opts?.since ?? ''}`);
      return [{ iid: 7, title: 'Bug', description: 'Fix it', state: 'opened', url: 'https://gitlab.test/issue/7', updatedAt: '2026-01-02T00:00:00.000Z', labels: ['bug'], assignees: [{ username: 'anh' }] }];
    },
    async listMergeRequests(project, opts) {
      calls.push(`mrs:${project}:${opts?.since ?? ''}`);
      return [{ iid: 8, title: 'Patch', description: 'Ship it', state: 'merged', url: 'https://gitlab.test/mr/8', updatedAt: '2026-01-03T00:00:00.000Z', author: { username: 'codex' } }];
    },
  };

  const result = await runGitlabConnectorCheckpoint(connector({ checkpoint: { highWatermark: '2026-01-01T00:00:00.000Z' } }), client, { now: '2026-01-05T00:00:00.000Z' });

  assert.deepEqual(calls, [
    'issues:kinqs/brainrouter:2026-01-01T00:00:00.000Z',
    'mrs:kinqs/brainrouter:2026-01-01T00:00:00.000Z',
  ]);
  assert.deepEqual(result.documents.map((doc) => doc.id), [
    'gitlab:kinqs/brainrouter:issue:7',
    'gitlab:kinqs/brainrouter:merge-request:8',
  ]);
  const [issue, mergeRequest] = result.documents;
  assert.equal(issue.kind, 'issue');
  assert.equal(issue.title, '#7 Bug');
  assert.ok(issue.text.includes('Labels: bug'));
  assert.ok(issue.text.includes('Assignees: anh'));
  assert.ok(issue.text.includes('Fix it'));
  assert.equal(mergeRequest.kind, 'pull-request');
  assert.equal(mergeRequest.title, '!8 Patch');
  assert.ok(mergeRequest.text.includes('Author: codex'));
  assert.deepEqual(result.checkpoint, {
    highWatermark: '2026-01-05T00:00:00.000Z',
    projects: ['kinqs/brainrouter'],
    completedAt: '2026-01-05T00:00:00.000Z',
    documentCount: 2,
    failureCount: 0,
  });
});

test('runGitlabConnectorCheckpoint resolves owner projects and records per-content failures', async () => {
  const client: GitlabConnectorClient = {
    async listProjects(owner) {
      assert.equal(owner, 'org');
      return ['org/a', 'org/b'];
    },
    async listIssues(project) {
      if (project === 'org/b') throw new Error('issue denied');
      return [{ iid: 1, title: 'A issue', updatedAt: '2026-02-01T00:00:00.000Z' }];
    },
    async listMergeRequests() {
      throw new Error('merge requests disabled');
    },
  };

  const result = await runGitlabConnectorCheckpoint(connector({
    config: { owner: 'org', includeIssues: true, includeMergeRequests: false },
  }), client, { now: '2026-02-02T00:00:00.000Z' });

  assert.deepEqual(result.documents.map((doc) => doc.id), ['gitlab:org/a:issue:1']);
  assert.deepEqual(result.failures, ['org/b issues: issue denied']);
  assert.equal(result.checkpoint.failureCount, 1);
  assert.deepEqual(result.checkpoint.projects, ['org/a', 'org/b']);
});

test('runGitlabConnectorCheckpoint validates source, owner, and selected content types', async () => {
  const client = {} as GitlabConnectorClient;
  await assert.rejects(
    () => runGitlabConnectorCheckpoint(connector({ source: 'github' as never }), client),
    /not gitlab/,
  );
  await assert.rejects(
    () => runGitlabConnectorCheckpoint(connector({ config: { owner: '' } }), client),
    /owner is required/,
  );
  await assert.rejects(
    () => runGitlabConnectorCheckpoint(connector({ config: { owner: 'org', includeIssues: false, includeMergeRequests: false } }), client),
    /at least one content type/,
  );
});

test('runGitlabConnectorCheckpoint notes truncation when a listing returns a full page', async () => {
  const client: GitlabConnectorClient = {
    async listProjects() {
      throw new Error('unused');
    },
    async listIssues() {
      return Array.from({ length: GITLAB_PAGE_SIZE }, (_, index) => ({
        iid: index + 1,
        title: `Issue ${index + 1}`,
        updatedAt: '2026-01-02T00:00:00.000Z',
      }));
    },
    async listMergeRequests() {
      return [];
    },
  };

  const result = await runGitlabConnectorCheckpoint(connector(), client, { now: '2026-01-05T00:00:00.000Z' });

  assert.equal(result.documents.length, GITLAB_PAGE_SIZE);
  assert.deepEqual(result.failures, [`kinqs/brainrouter issues: results truncated at ${GITLAB_PAGE_SIZE}.`]);
});

test('runGitlabConnectorCheckpoint flags unsupported includeFiles instead of silently ignoring it', async () => {
  const client: GitlabConnectorClient = {
    async listProjects() {
      throw new Error('unused');
    },
    async listIssues() {
      return [];
    },
    async listMergeRequests() {
      return [];
    },
  };

  const result = await runGitlabConnectorCheckpoint(connector({
    config: { owner: 'kinqs', projects: ['brainrouter'], includeFiles: true },
  }), client, { now: '2026-01-05T00:00:00.000Z' });

  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /not implemented/);
});

test('gitlabTokenClient hits the v4 REST API with PRIVATE-TOKEN and maps rows', async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    if (url.includes('/groups/')) {
      return new Response(JSON.stringify([{ path_with_namespace: 'org/a' }, { path_with_namespace: 'org/b' }]), { status: 200 });
    }
    if (url.includes('/issues')) {
      return new Response(JSON.stringify([{ iid: 7, title: 'Bug', description: 'Fix', state: 'opened', web_url: 'https://gitlab.test/i/7', updated_at: '2026-01-02T00:00:00.000Z', labels: ['bug'], assignees: [{ username: 'anh' }] }]), { status: 200 });
    }
    if (url.includes('/merge_requests')) {
      return new Response(JSON.stringify([{ iid: 8, title: 'MR', web_url: 'https://gitlab.test/mr/8', updated_at: '2026-01-03T00:00:00.000Z', author: { username: 'codex' } }]), { status: 200 });
    }
    return new Response('nope', { status: 404, statusText: 'Not Found' });
  }) as typeof fetch;

  const client = gitlabTokenClient('tok', 'https://gitlab.example.com/', { fetchImpl });

  const projects = await client.listProjects('my-org');
  assert.deepEqual(projects, ['org/a', 'org/b']);
  assert.ok(calls[0].url.startsWith('https://gitlab.example.com/api/v4/groups/my-org/projects?per_page=100'));
  assert.equal(calls[0].headers['PRIVATE-TOKEN'], 'tok');

  const issues = await client.listIssues('org/a', { since: '2026-01-01T00:00:00.000Z' });
  const issueCall = calls.find((call) => call.url.includes('/issues'));
  assert.ok(issueCall);
  assert.ok(issueCall.url.includes('/api/v4/projects/org%2Fa/issues?per_page=100'));
  assert.ok(issueCall.url.includes(`updated_after=${encodeURIComponent('2026-01-01T00:00:00.000Z')}`));
  assert.deepEqual(issues.map((issue) => ({ iid: issue.iid, title: issue.title, url: issue.url, updatedAt: issue.updatedAt, labels: issue.labels })), [
    { iid: 7, title: 'Bug', url: 'https://gitlab.test/i/7', updatedAt: '2026-01-02T00:00:00.000Z', labels: ['bug'] },
  ]);

  const mergeRequests = await client.listMergeRequests('org/a');
  assert.deepEqual(mergeRequests.map((mergeRequest) => ({ iid: mergeRequest.iid, author: mergeRequest.author })), [
    { iid: 8, author: { username: 'codex' } },
  ]);

  assert.throws(() => gitlabTokenClient('   '), /token is required/);
});

test('gitlabTokenClient falls back to the users projects endpoint when the group lookup fails', async () => {
  const urls: string[] = [];
  const fetchImpl = (async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    if (url.includes('/groups/')) return new Response('missing', { status: 404, statusText: 'Not Found' });
    if (url.includes('/users/')) return new Response(JSON.stringify([{ path_with_namespace: 'solo/project' }]), { status: 200 });
    return new Response('nope', { status: 500, statusText: 'Boom' });
  }) as typeof fetch;

  const client = gitlabTokenClient('tok', undefined, { fetchImpl });
  const projects = await client.listProjects('solo');

  assert.deepEqual(projects, ['solo/project']);
  assert.ok(urls[0].startsWith('https://gitlab.com/api/v4/groups/solo/projects'));
  assert.ok(urls[1].startsWith('https://gitlab.com/api/v4/users/solo/projects'));
});
