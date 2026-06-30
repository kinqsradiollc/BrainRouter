import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureProject, createWorkItem, listWorkItems, getWorkItem, getGithubLinks, listMembers } from '../track/trackStore.js';
import {
  workItemToIssue,
  issueToWorkItem,
  keyFromBody,
  exportToGithub,
  importFromGithub,
  importMembersFromGithub,
  listResolvedGithubConfigsForWorkspace,
  resolveGithubConfigForWorkspace,
  mapCollaboratorRole,
  type GithubIssue,
  type GithubCollaborator,
  type FetchLike,
} from '../track/githubSync.js';
import { createConnector } from '../connectors/connectorStore.js';
import { setCliKnobOverride } from '../config/config.js';
import { withTempWorkspace, withTempWorkspaceAsync } from './_helpers.js';

/** A scriptable fetch mock: records calls, returns queued responses, fakes issue creation. */
function mockGithub(initialIssues: GithubIssue[] = [], collaborators: GithubCollaborator[] = []) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const issues = [...initialIssues];
  let nextNumber = Math.max(0, ...issues.map((i) => i.number)) + 1;
  const fetchImpl: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    if (method === 'GET' && url.includes('/collaborators')) return resp(200, collaborators);
    if (method === 'GET') return resp(200, issues);
    if (method === 'POST') { const created: GithubIssue = { number: nextNumber++, title: body.title, body: body.body, labels: body.labels, state: 'open', html_url: `https://github.com/x/y/issues/${nextNumber - 1}` }; issues.push(created); return resp(201, created); }
    if (method === 'PATCH') return resp(200, { number: 1 });
    return resp(400, {});
  };
  return { fetchImpl, calls, issues };
  function resp(status: number, json: unknown) { return { ok: status < 400, status, json: async () => json, text: async () => JSON.stringify(json) }; }
}

const OPTS = (fetchImpl: FetchLike, dryRun = false) => ({ repo: 'x/y', token: 't', fetchImpl, dryRun });

test('github mapper: work item ↔ issue round-trips type, priority, state, key marker', () => {
  withTempWorkspace((ws) => {
    const project = ensureProject(ws, { key: 'BR' });
    const item = createWorkItem(ws, { title: 'Fix crash', type: 'bug', priority: 'high', description: 'boom' });
    const issue = workItemToIssue(item);
    assert.ok(issue.labels.includes('type:bug') && issue.labels.includes('priority:high'));
    assert.equal(issue.state, 'open');
    assert.equal(keyFromBody(issue.body), item.key);
    // back the other way
    const mapped = issueToWorkItem({ number: 5, title: issue.title, body: issue.body, labels: issue.labels, state: 'closed' }, project);
    assert.equal(mapped.key, item.key);
    assert.equal(mapped.input.type, 'bug');
    assert.equal(mapped.input.priority, 'high');
    assert.equal(mapped.patch.description, 'boom'); // marker stripped
  });
});

test('github export: creates issues, records links, then UPDATES on re-run', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    ensureProject(ws, { key: 'BR' });
    createWorkItem(ws, { title: 'A' });
    createWorkItem(ws, { title: 'B' });
    const gh = mockGithub();
    const r1 = await exportToGithub(ws, OPTS(gh.fetchImpl));
    assert.equal(r1.exported!.length, 2);
    assert.ok(r1.exported!.every((e) => e.action === 'create'));
    assert.equal(Object.keys(getGithubLinks(ws)).length, 2); // links recorded
    assert.equal(gh.calls.filter((c) => c.method === 'POST').length, 2);
    // re-export → both now UPDATE (PATCH), no new POSTs
    const r2 = await exportToGithub(ws, OPTS(gh.fetchImpl));
    assert.ok(r2.exported!.every((e) => e.action === 'update'));
    assert.equal(gh.calls.filter((c) => c.method === 'POST').length, 2); // unchanged
    assert.equal(gh.calls.filter((c) => c.method === 'PATCH').length, 2);
  });
});

test('github export: a done item is closed after creation', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    ensureProject(ws, { key: 'BR' });
    const w = createWorkItem(ws, { title: 'Done thing' });
    // move it to a done-category state
    const project = ensureProject(ws);
    const doneState = project.workflowStates.find((s) => s.category === 'completed')!;
    createWorkItem(ws, { title: 'open thing' });
    const { transitionWorkItem } = await import('../track/trackStore.js');
    transitionWorkItem(ws, w.key, doneState.id);
    const gh = mockGithub();
    await exportToGithub(ws, OPTS(gh.fetchImpl));
    // the done item gets a POST then a PATCH {state:closed}
    const closePatch = gh.calls.find((c) => c.method === 'PATCH' && (c.body as { state?: string })?.state === 'closed');
    assert.ok(closePatch, 'expected a close PATCH for the done item');
  });
});

test('github import: creates items from issues, skips PRs, no dupes on re-import', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    ensureProject(ws, { key: 'BR' });
    const gh = mockGithub([
      { number: 1, title: 'Imported bug', labels: ['type:bug', 'priority:high'], state: 'open' },
      { number: 2, title: 'A pull request', pull_request: {}, state: 'open' },
      { number: 3, title: 'Closed task', labels: [], state: 'closed' },
    ]);
    const r1 = await importFromGithub(ws, OPTS(gh.fetchImpl));
    assert.equal(r1.imported!.length, 2); // PR #2 filtered out
    const items = listWorkItems(ws);
    assert.equal(items.length, 2);
    const bug = items.find((i) => i.title === 'Imported bug')!;
    assert.equal(bug.type, 'bug');
    assert.equal(bug.priority, 'high');
    const closed = items.find((i) => i.title === 'Closed task')!;
    assert.equal(closed.statusCategory, 'completed'); // closed issue → completed category
    // re-import → both UPDATE (matched by recorded link), still only 2 items
    const r2 = await importFromGithub(ws, OPTS(gh.fetchImpl));
    assert.ok(r2.imported!.every((e) => e.action === 'update'));
    assert.equal(listWorkItems(ws).length, 2);
  });
});

test('github dry-run: builds a plan but performs NO writes', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    ensureProject(ws, { key: 'BR' });
    createWorkItem(ws, { title: 'local only' });
    const gh = mockGithub([{ number: 9, title: 'remote only', labels: [], state: 'open' }]);
    const exp = await exportToGithub(ws, OPTS(gh.fetchImpl, true));
    assert.equal(exp.exported!.length, 1);
    assert.equal(gh.calls.filter((c) => c.method !== 'GET').length, 0); // no mutating calls
    assert.equal(Object.keys(getGithubLinks(ws)).length, 0); // nothing recorded
    const imp = await importFromGithub(ws, OPTS(gh.fetchImpl, true));
    assert.equal(imp.imported!.length, 1);
    assert.equal(listWorkItems(ws).length, 1); // remote issue NOT created locally
  });
});

test('github members: collaborator role mapping (admin/write/read → admin/member/viewer)', () => {
  assert.equal(mapCollaboratorRole({ login: 'a', permissions: { admin: true } }), 'admin');
  assert.equal(mapCollaboratorRole({ login: 'b', permissions: { push: true } }), 'member');
  assert.equal(mapCollaboratorRole({ login: 'c', permissions: { maintain: true } }), 'member');
  assert.equal(mapCollaboratorRole({ login: 'd', permissions: { triage: true } }), 'viewer');
  assert.equal(mapCollaboratorRole({ login: 'e', permissions: { pull: true } }), 'viewer');
  assert.equal(mapCollaboratorRole({ login: 'f', role_name: 'write' }), 'member');
});

test('github members: import pulls collaborators as members, keeps the local owner', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    ensureProject(ws, { key: 'BR' });
    const gh = mockGithub([], [
      { login: 'octo', name: 'Octo Cat', permissions: { admin: true } },
      { login: 'dev1', permissions: { push: true } },
      { login: 'you', permissions: { admin: true } }, // collides with the seed owner — must be skipped
    ]);
    const r = await importMembersFromGithub(ws, OPTS(gh.fetchImpl));
    assert.deepEqual(r.added.sort(), ['dev1', 'octo']); // 'you' skipped
    const members = listMembers(ws);
    assert.equal(members.find((m) => m.id === 'octo')!.role, 'admin');
    assert.equal(members.find((m) => m.id === 'dev1')!.role, 'member');
    // the seed owner is untouched and still the only owner
    assert.equal(members.find((m) => m.id === 'you')!.role, 'owner');
    assert.equal(members.filter((m) => m.role === 'owner').length, 1);
  });
});

test('github members: dry-run reports who would be added but writes nothing', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    ensureProject(ws, { key: 'BR' });
    const gh = mockGithub([], [{ login: 'octo', permissions: { admin: true } }]);
    const r = await importMembersFromGithub(ws, OPTS(gh.fetchImpl, true));
    assert.deepEqual(r.added, ['octo']);
    assert.equal(listMembers(ws).length, 1); // only the seed owner — nothing written
  });
});

test('github assignee: round-trips work-item assignee ↔ issue assignee', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    const project = ensureProject(ws, { key: 'BR' });
    const item = createWorkItem(ws, { title: 'Assigned', assignee: 'octo' });
    const issue = workItemToIssue(item);
    assert.deepEqual(issue.assignees, ['octo']); // exported as a GitHub assignee
    // import direction: issue.assignee → work-item assignee
    const mapped = issueToWorkItem({ number: 7, title: 'X', assignee: { login: 'dev1' }, state: 'open' }, project);
    assert.equal(mapped.input.assignee, 'dev1');
    // falls back to the first of `assignees`
    const mapped2 = issueToWorkItem({ number: 8, title: 'Y', assignees: [{ login: 'dev2' }], state: 'open' }, project);
    assert.equal(mapped2.input.assignee, 'dev2');
  });
});

test('github config resolver includes repositories from GitHub connectors', () => {
  const previous = process.env.BR_TEST_GITHUB_TOKEN;
  process.env.BR_TEST_GITHUB_TOKEN = 'connector-token';
  try {
    withTempWorkspace((ws) => {
      setCliKnobOverride({ track: { githubRepos: [] } } as never);
      const connector = createConnector(ws, {
        source: 'github',
        name: 'BrainRouter repos',
        config: {
          owner: 'kinqsradiollc',
          repositories: ['BrainRouter', 'external/already-qualified'],
          includeIssues: true,
        },
        credential: { mode: 'static', ref: 'BR_TEST_GITHUB_TOKEN' },
        flows: ['checkpoint'],
      });

      const rows = listResolvedGithubConfigsForWorkspace(ws);
      assert.deepEqual(rows.map((row) => row.repo), ['kinqsradiollc/BrainRouter', 'external/already-qualified']);
      assert.equal(rows[0].active, true);
      assert.equal(rows[0].source, 'connector');
      assert.equal(rows[0].label, 'BrainRouter repos');
      assert.equal(rows[0].connectorId, connector.id);
      assert.equal(rows[0].hasToken, true);
      assert.equal(rows[0].tokenSource, 'connector-env');

      const resolved = resolveGithubConfigForWorkspace(ws, 'external/already-qualified');
      assert.equal(resolved.repo, 'external/already-qualified');
      assert.equal(resolved.token, 'connector-token');
      assert.equal(resolved.tokenSource, 'connector-env');
      assert.equal(resolved.connectorId, connector.id);
    });
  } finally {
    if (previous === undefined) delete process.env.BR_TEST_GITHUB_TOKEN;
    else process.env.BR_TEST_GITHUB_TOKEN = previous;
  }
});

test('github config resolver keeps dynamic connector repos visible without an HTTP token', () => {
  withTempWorkspace((ws) => {
    setCliKnobOverride({ track: { githubRepos: [] } } as never);
    const connector = createConnector(ws, {
      source: 'github',
      name: 'GitHub CLI repos',
      config: { owner: 'octo', repositories: ['app'] },
      credential: { mode: 'dynamic', ref: 'gh', label: 'GitHub CLI' },
      flows: ['checkpoint'],
    });

    const rows = listResolvedGithubConfigsForWorkspace(ws);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].repo, 'octo/app');
    assert.equal(rows[0].hasToken, false);
    assert.equal(rows[0].connectorId, connector.id);

    const resolved = resolveGithubConfigForWorkspace(ws, 'octo/app');
    assert.equal(resolved.repo, 'octo/app');
    assert.equal(resolved.token, undefined);
    assert.equal(resolved.connectorId, connector.id);
  });
});
