import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeamsOps, toTeamOptions } from './teamsOps.js';

test('toTeamOptions keeps valid teams and derives {id, name} picker rows', () => {
  const rows = toTeamOptions([
    { id: 'team_a', orgId: 'o1', name: 'Platform', createdBy: 'u1' },
    { id: 'team_b', name: 'Design' },
  ]);
  assert.deepEqual(rows, [
    { id: 'team_a', kind: 'organization', orgId: 'o1', name: 'Platform', canManage: false, createdBy: 'u1' },
    { id: 'team_b', kind: 'organization', orgId: null, name: 'Design', canManage: false },
  ]);
});

test('toTeamOptions falls back to the id when a team name is missing or blank', () => {
  const rows = toTeamOptions([
    { id: 'team_c' },
    { id: 'team_d', name: '   ' },
    { id: 'team_e', name: 42 },
  ]);
  assert.deepEqual(rows, [
    { id: 'team_c', kind: 'organization', orgId: null, name: 'team_c', canManage: false },
    { id: 'team_d', kind: 'organization', orgId: null, name: 'team_d', canManage: false },
    { id: 'team_e', kind: 'organization', orgId: null, name: 'team_e', canManage: false },
  ]);
});

test('toTeamOptions degrades to an empty list for non-array or malformed payloads', () => {
  assert.deepEqual(toTeamOptions(null), []);
  assert.deepEqual(toTeamOptions(undefined), []);
  assert.deepEqual(toTeamOptions({ teams: [] }), []);
  assert.deepEqual(toTeamOptions('nope'), []);
  assert.deepEqual(toTeamOptions([null, 3, 'x', { id: '' }, { name: 'no id' }]), []);
});

test('Teams ops exposes management CRUD over the privileged bridge', async () => {
  const calls: string[] = [];
  (globalThis as unknown as { brainrouter?: unknown }).brainrouter = { teams: {
    list: async () => [{ id: 'team_a', name: 'Platform' }],
    get: async () => ({ team: { id: 'team_a', name: 'Platform' }, members: [{ userId: 'u1', role: 'owner' }], currentUserId: 'u1' }),
    create: async () => { calls.push('create'); return { team: { id: 'team_b', name: 'Design' } }; },
    addMember: async () => { calls.push('add'); return { members: [{ userId: 'u2', role: 'member' }] }; },
    removeMember: async () => { calls.push('remove-member'); return { ok: true }; },
    remove: async () => { calls.push('remove'); return { ok: true }; },
  } };
  const ops = createTeamsOps();
  assert.equal((await ops.list())[0]?.name, 'Platform');
  const detail = await ops.get('team_a');
  assert.equal(detail.members[0]?.role, 'owner');
  assert.equal(detail.currentUserId, 'u1');
  assert.equal((await ops.create('Design')).id, 'team_b');
  assert.equal((await ops.addMember('team_a', 'u2', 'member'))[0]?.userId, 'u2');
  await ops.removeMember('team_a', 'u2');
  await ops.remove('team_a');
  assert.deepEqual(calls, ['create', 'add', 'remove-member', 'remove']);
});
