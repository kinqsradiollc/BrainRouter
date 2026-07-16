import test from 'node:test';
import assert from 'node:assert/strict';
import { toTeamOptions } from './teamsOps.js';

test('toTeamOptions keeps valid teams and derives {id, name} picker rows', () => {
  const rows = toTeamOptions([
    { id: 'team_a', orgId: 'o1', name: 'Platform', createdBy: 'u1' },
    { id: 'team_b', name: 'Design' },
  ]);
  assert.deepEqual(rows, [
    { id: 'team_a', name: 'Platform' },
    { id: 'team_b', name: 'Design' },
  ]);
});

test('toTeamOptions falls back to the id when a team name is missing or blank', () => {
  const rows = toTeamOptions([
    { id: 'team_c' },
    { id: 'team_d', name: '   ' },
    { id: 'team_e', name: 42 },
  ]);
  assert.deepEqual(rows, [
    { id: 'team_c', name: 'team_c' },
    { id: 'team_d', name: 'team_d' },
    { id: 'team_e', name: 'team_e' },
  ]);
});

test('toTeamOptions degrades to an empty list for non-array or malformed payloads', () => {
  assert.deepEqual(toTeamOptions(null), []);
  assert.deepEqual(toTeamOptions(undefined), []);
  assert.deepEqual(toTeamOptions({ teams: [] }), []);
  assert.deepEqual(toTeamOptions('nope'), []);
  assert.deepEqual(toTeamOptions([null, 3, 'x', { id: '' }, { name: 'no id' }]), []);
});
