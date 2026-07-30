import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitlabTrackCompatFetch, type FetchLike } from '../track/index.js';

const wire = (status: number, data: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
  text: async () => JSON.stringify(data),
});

test('GitLab Track adapter maps nested-project issues into the existing sync shape', async () => {
  const calls: Array<{ url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }> = [];
  const upstream: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return wire(200, [{ iid: 7, title: 'Fix it', description: 'Body', state: 'opened', labels: ['bug'], web_url: 'https://gitlab.test/group/sub/repo/-/issues/7', updated_at: '2026-07-14T00:00:00Z', assignees: [{ username: 'dev' }] }]);
  };
  const fetchImpl = createGitlabTrackCompatFetch({ apiBase: 'https://gitlab.test/api/v4', token: 'sealed-at-caller', fetchImpl: upstream, authMode: 'bearer' });
  const response = await fetchImpl('https://gitlab.test/api/v4/repos/group/sub/repo/issues?state=all&per_page=100');
  assert.equal(response.ok, true);
  assert.match(calls[0]!.url, /projects\/group%2Fsub%2Frepo\/issues\?/);
  assert.equal(calls[0]!.init?.headers?.Authorization, 'Bearer sealed-at-caller');
  assert.deepEqual(await response.json(), [{
    number: 7, title: 'Fix it', body: 'Body', state: 'open', labels: ['bug'],
    html_url: 'https://gitlab.test/group/sub/repo/-/issues/7',
    assignee: { login: 'dev' }, assignees: [{ login: 'dev' }], updated_at: '2026-07-14T00:00:00Z',
  }]);
});

test('GitLab Track adapter translates create, update, comments, and member roles', async () => {
  const calls: Array<{ url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }> = [];
  const upstream: FetchLike = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('/members/all')) return wire(200, [{ username: 'owner', access_level: 50 }, { username: 'dev', access_level: 30 }]);
    if (url.includes('/notes')) return wire(201, { id: 9, body: 'hello', author: { username: 'dev' } });
    return wire(200, { iid: 4, title: 'Task', description: 'Details', state: 'closed', labels: ['type:task'] });
  };
  const fetchImpl = createGitlabTrackCompatFetch({ token: 'token', fetchImpl: upstream });
  await fetchImpl('https://gitlab.com/api/v4/repos/group/repo/issues', { method: 'POST', body: JSON.stringify({ title: 'Task', body: 'Details', labels: ['type:task'], state: 'closed' }) });
  await fetchImpl('https://gitlab.com/api/v4/repos/group/repo/issues/4', { method: 'PATCH', body: JSON.stringify({ body: 'Updated', state: 'open' }) });
  const note = await fetchImpl('https://gitlab.com/api/v4/repos/group/repo/issues/4/comments', { method: 'POST', body: JSON.stringify({ body: 'hello' }) });
  const members = await fetchImpl('https://gitlab.com/api/v4/repos/group/repo/collaborators?per_page=100');
  assert.deepEqual(JSON.parse(calls[0]!.init!.body!), { title: 'Task', description: 'Details', labels: 'type:task', state_event: 'close' });
  assert.equal(calls[1]!.init?.method, 'PUT');
  assert.deepEqual(JSON.parse(calls[1]!.init!.body!), { description: 'Updated', state_event: 'reopen' });
  assert.deepEqual(await note.json(), { id: 9, body: 'hello', user: { login: 'dev' } });
  assert.deepEqual(await members.json(), [{ login: 'owner', role_name: 'admin' }, { login: 'dev', role_name: 'write' }]);
});

test('GitLab Track adapter rejects paths outside its bounded compatibility surface', async () => {
  const fetchImpl = createGitlabTrackCompatFetch({ token: 'token', fetchImpl: async () => { throw new Error('must not call'); } });
  const response = await fetchImpl('https://gitlab.com/api/v4/admin/users');
  assert.equal(response.ok, false);
  assert.equal(response.status, 400);
});
