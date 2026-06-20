import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureProject, createWorkItem, listWorkItems, getWorkItem, getGithubLinks } from '../track/trackStore.js';
import {
  workItemToIssue,
  issueToWorkItem,
  keyFromBody,
  exportToGithub,
  importFromGithub,
  type GithubIssue,
  type FetchLike,
} from '../track/githubSync.js';
import { withTempWorkspace, withTempWorkspaceAsync } from './_helpers.js';

/** A scriptable fetch mock: records calls, returns queued responses, fakes issue creation. */
function mockGithub(initialIssues: GithubIssue[] = []) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const issues = [...initialIssues];
  let nextNumber = Math.max(0, ...issues.map((i) => i.number)) + 1;
  const fetchImpl: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
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
    const doneState = project.workflowStates.find((s) => s.category === 'done')!;
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
    assert.equal(closed.statusCategory, 'done'); // closed → done category
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
