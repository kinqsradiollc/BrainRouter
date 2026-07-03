import test from 'node:test';
import assert from 'node:assert/strict';
import type { ConnectorRecord } from '@kinqs/brainrouter-types';
import { runGithubConnectorCheckpoint, runGithubConnectorPermissionSync, validateGithubConnectorAccess, type GithubConnectorClient, type GithubConnectorPermissionClient, type GithubConnectorValidationClient } from '../connectors/sources/githubConnector.js';

function connector(overrides?: Partial<ConnectorRecord>): ConnectorRecord {
  return {
    id: 'conn_test',
    source: 'github',
    name: 'GitHub',
    status: 'active',
    config: {
      owner: 'kinqsradiollc',
      repositories: ['BrainRouter'],
      includeIssues: true,
      includePullRequests: true,
      includeFiles: true,
    },
    credential: { mode: 'dynamic', ref: 'gh' },
    flows: ['checkpoint'],
    workspaceRoot: '/tmp/workspace',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('runGithubConnectorCheckpoint maps issues, pull requests, files, and checkpoint state', async () => {
  const calls: string[] = [];
  const client: GithubConnectorClient = {
    async listRepositories() {
      throw new Error('should not list owner repos when repositories are configured');
    },
    async listIssues(repo, opts) {
      calls.push(`issues:${repo}:${opts?.since ?? ''}`);
      return [{ number: 7, title: 'Bug', body: 'Fix it', state: 'open', url: 'https://github.test/issue/7', updatedAt: '2026-01-02T00:00:00.000Z', labels: [{ name: 'bug' }], assignees: [{ login: 'anh' }] }];
    },
    async listPullRequests(repo, opts) {
      calls.push(`prs:${repo}:${opts?.since ?? ''}`);
      return [{ number: 8, title: 'Patch', body: 'Ship it', state: 'OPEN', url: 'https://github.test/pull/8', updatedAt: '2026-01-03T00:00:00.000Z', author: { login: 'codex' } }];
    },
    async listFiles(repo, opts) {
      calls.push(`files:${repo}:${opts?.since ?? ''}`);
      return [{ path: 'README.md', text: '# Readme', sha: 'abc', size: 8, url: 'https://github.test/blob/README.md', updatedAt: '2026-01-04T00:00:00.000Z' }];
    },
  };

  const result = await runGithubConnectorCheckpoint(connector({ checkpoint: { highWatermark: '2026-01-01T00:00:00.000Z' } }), client, { now: '2026-01-05T00:00:00.000Z' });

  assert.deepEqual(calls, [
    'issues:kinqsradiollc/BrainRouter:2026-01-01T00:00:00.000Z',
    'prs:kinqsradiollc/BrainRouter:2026-01-01T00:00:00.000Z',
    'files:kinqsradiollc/BrainRouter:2026-01-01T00:00:00.000Z',
  ]);
  assert.deepEqual(result.documents.map((doc) => doc.id), [
    'github:kinqsradiollc/BrainRouter:issue:7',
    'github:kinqsradiollc/BrainRouter:pull:8',
    'github:kinqsradiollc/BrainRouter:file:README.md',
  ]);
  assert.equal(result.documents[0].kind, 'issue');
  assert.equal(result.documents[1].kind, 'pull-request');
  assert.equal(result.documents[2].text, '# Readme');
  assert.deepEqual(result.checkpoint, {
    highWatermark: '2026-01-05T00:00:00.000Z',
    repositories: ['kinqsradiollc/BrainRouter'],
    completedAt: '2026-01-05T00:00:00.000Z',
    documentCount: 3,
    failureCount: 0,
  });
});

test('runGithubConnectorCheckpoint resolves owner repositories and records per-content failures', async () => {
  const client: GithubConnectorClient = {
    async listRepositories(owner) {
      assert.equal(owner, 'org');
      return ['org/a', 'org/b'];
    },
    async listIssues(repo) {
      if (repo === 'org/b') throw new Error('issue denied');
      return [{ number: 1, title: 'A issue', updatedAt: '2026-02-01T00:00:00.000Z' }];
    },
    async listPullRequests() {
      return [];
    },
    async listFiles() {
      throw new Error('files disabled');
    },
  };

  const result = await runGithubConnectorCheckpoint(connector({
    config: { owner: 'org', includeIssues: true, includePullRequests: false, includeFiles: false },
  }), client, { now: '2026-02-02T00:00:00.000Z' });

  assert.deepEqual(result.documents.map((doc) => doc.id), ['github:org/a:issue:1']);
  assert.deepEqual(result.failures, ['org/b issues: issue denied']);
  assert.equal(result.checkpoint.failureCount, 1);
  assert.deepEqual(result.checkpoint.repositories, ['org/a', 'org/b']);
});

test('runGithubConnectorCheckpoint validates source, owner, and selected content types', async () => {
  const client = {} as GithubConnectorClient;
  await assert.rejects(
    () => runGithubConnectorCheckpoint(connector({ source: 'slack' as never }), client),
    /not github/,
  );
  await assert.rejects(
    () => runGithubConnectorCheckpoint(connector({ config: { owner: '' } }), client),
    /owner is required/,
  );
  await assert.rejects(
    () => runGithubConnectorCheckpoint(connector({ config: { owner: 'org', includeIssues: false, includePullRequests: false, includeFiles: false } }), client),
    /at least one content type/,
  );
});

test('validateGithubConnectorAccess checks configured repositories through the injected client', async () => {
  const calls: string[] = [];
  const client: GithubConnectorValidationClient = {
    async listRepositories() {
      throw new Error('should not list owner repos when repositories are configured');
    },
    async getRepository(repo) {
      calls.push(repo);
      if (repo === 'kinqsradiollc/private') throw new Error('not found');
      return repo.toUpperCase();
    },
  };

  const result = await validateGithubConnectorAccess(connector({
    config: { owner: 'kinqsradiollc', repositories: ['BrainRouter', 'external/app'] },
  }), client);

  assert.deepEqual(calls, ['kinqsradiollc/BrainRouter', 'external/app']);
  assert.deepEqual(result, {
    ok: true,
    checked: ['KINQSRADIOLLC/BRAINROUTER', 'EXTERNAL/APP'],
    errors: [],
  });
});

test('validateGithubConnectorAccess reports inaccessible repos and owner discovery failures', async () => {
  const client: GithubConnectorValidationClient = {
    async listRepositories(owner) {
      assert.equal(owner, 'empty');
      return [];
    },
    async getRepository(repo) {
      if (repo === 'org/ok') return repo;
      return undefined;
    },
  };

  const missingRepo = await validateGithubConnectorAccess(connector({
    config: { owner: 'org', repositories: ['ok', 'missing'] },
  }), client);
  assert.equal(missingRepo.ok, false);
  assert.deepEqual(missingRepo.checked, ['org/ok']);
  assert.deepEqual(missingRepo.errors, ['org/missing: repository not found or inaccessible.']);

  const emptyOwner = await validateGithubConnectorAccess(connector({
    config: { owner: 'empty', repositories: [] },
  }), client);
  assert.deepEqual(emptyOwner, {
    ok: false,
    checked: [],
    errors: ['No accessible repositories found for empty.'],
  });
});

test('runGithubConnectorPermissionSync maps repository collaborators into permission records', async () => {
  const client: GithubConnectorPermissionClient = {
    async listRepositories() {
      throw new Error('configured repositories should not list owner repos');
    },
    async listCollaborators(repo) {
      assert.equal(repo, 'kinqsradiollc/BrainRouter');
      return [
        { login: 'admin-user', name: 'Admin User', htmlUrl: 'https://github.test/admin-user', permissions: { admin: true } },
        { login: 'writer', roleName: 'write', permissions: { push: true } },
        { login: 'reader', permissions: { pull: true } },
      ];
    },
  };

  const result = await runGithubConnectorPermissionSync(connector(), client, { now: '2026-03-01T00:00:00.000Z' });

  assert.deepEqual(result.permissions.map((permission) => ({
    id: permission.id,
    principalId: permission.principalId,
    role: permission.role,
    repositories: permission.repositories,
  })), [
    { id: 'github:kinqsradiollc/BrainRouter:user:admin-user', principalId: 'admin-user', role: 'admin', repositories: ['kinqsradiollc/BrainRouter'] },
    { id: 'github:kinqsradiollc/BrainRouter:user:writer', principalId: 'writer', role: 'write', repositories: ['kinqsradiollc/BrainRouter'] },
    { id: 'github:kinqsradiollc/BrainRouter:user:reader', principalId: 'reader', role: 'read', repositories: ['kinqsradiollc/BrainRouter'] },
  ]);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.checkpoint, {
    permissionSyncedAt: '2026-03-01T00:00:00.000Z',
    repositories: ['kinqsradiollc/BrainRouter'],
    permissionCount: 3,
    failureCount: 0,
  });
});

test('runGithubConnectorPermissionSync resolves owner repositories and records failures', async () => {
  const client: GithubConnectorPermissionClient = {
    async listRepositories(owner) {
      assert.equal(owner, 'org');
      return ['org/a', 'org/b'];
    },
    async listCollaborators(repo) {
      if (repo === 'org/b') throw new Error('permission denied');
      return [{ login: 'octo', permissions: { maintain: true } }];
    },
  };

  const result = await runGithubConnectorPermissionSync(connector({
    config: { owner: 'org', repositories: [] },
  }), client, { now: '2026-03-02T00:00:00.000Z' });

  assert.deepEqual(result.permissions.map((permission) => `${permission.principalId}:${permission.role}`), ['octo:maintain']);
  assert.deepEqual(result.failures, ['org/b permissions: permission denied']);
  assert.equal(result.checkpoint.permissionCount, 1);
  assert.equal(result.checkpoint.failureCount, 1);
});
