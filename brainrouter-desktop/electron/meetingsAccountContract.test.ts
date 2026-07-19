import assert from 'node:assert/strict';
import test from 'node:test';
import { meetingRequests, safeOpaqueId, teamRequests, trackRequests } from './meetingsAccountContract.js';

test('meeting request contract preserves pagination and exact account routes', () => {
  assert.deepEqual(meetingRequests.list({ limit: 25, cursor: 'next/page+=' }), {
    path: '/api/meetings?limit=25&cursor=next%2Fpage%2B%3D', method: 'GET',
  });
  assert.equal(meetingRequests.overview('meeting-1').path, '/api/meetings/meeting-1/overview');
  assert.equal(meetingRequests.transcript('meeting-1', { limit: 100, cursor: '200' }).path, '/api/meetings/meeting-1/transcript?limit=100&cursor=200');
  assert.equal(meetingRequests.updateSummary('meeting-1', '# Notes').method, 'PATCH');
  assert.equal(meetingRequests.regenerate('meeting-1').method, 'POST');
  assert.deepEqual(meetingRequests.remove('meeting-1', 'org-1'), { path: '/api/meetings/meeting-1', method: 'DELETE', orgId: 'org-1' });
  assert.throws(() => meetingRequests.remove('../evil'), /meeting id/i);
});

test('meeting create and scope require real content and a team id for team sharing', () => {
  assert.deepEqual(meetingRequests.create({ title: ' Sync ', transcript: ' decisions ', template: 'standup' }).json, {
    title: 'Sync', transcript: ' decisions ', template: 'standup', scope: 'private',
  });
  assert.throws(() => meetingRequests.create({ title: 'Sync', transcript: ' ', template: 'general' }), /Transcript is required/);
  assert.throws(() => meetingRequests.setScope('meeting-1', 'team'), /team is required/i);
  assert.deepEqual(meetingRequests.setScope('meeting-1', 'team', { teamId: 'team-1' }).json, { scope: 'team', teamId: 'team-1' });
});

test('audio transcription is bounded and keeps binary data out of JSON', () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const request = meetingRequests.transcribe({ bytes, contentType: 'audio/webm', language: 'en-AU' });
  assert.equal(request.path, '/v1/audio/transcriptions?language=en-AU');
  assert.equal(request.contentType, 'audio/webm');
  assert.equal(request.bytes, bytes);
  assert.equal(request.json, undefined);
  assert.throws(() => meetingRequests.transcribe({ bytes: new Uint8Array(), contentType: 'audio/webm' }), /empty/i);
  assert.throws(() => meetingRequests.transcribe({ bytes, language: '../en' }), /Invalid language/);
});

test('Track contract exposes create, all transitions, and remove', () => {
  assert.deepEqual(trackRequests.create({ title: ' Ship meeting parity ', statusCategory: 'todo' }).json, {
    title: 'Ship meeting parity', statusCategory: 'todo',
  });
  for (const status of ['todo', 'in_progress', 'completed'] as const) {
    assert.deepEqual(trackRequests.transition('wi_1', status), {
      path: '/api/track/wi_1/transition', method: 'POST', json: { statusCategory: status },
    });
  }
  assert.deepEqual(trackRequests.remove('wi_1'), { path: '/api/track/wi_1', method: 'DELETE' });
  assert.throws(() => trackRequests.create({ title: 'None.' }), /real work/);
});

test('Teams contract covers CRUD and member roles', () => {
  assert.deepEqual(teamRequests.create(' Platform ').json, { name: 'Platform', kind: 'organization' });
  assert.deepEqual(teamRequests.create(' Friends ', 'personal', 'org-main'), { path: '/api/teams', method: 'POST', json: { name: 'Friends', kind: 'personal' }, orgId: 'org-main' });
  assert.equal(teamRequests.detail('team-1').path, '/api/teams/team-1');
  assert.deepEqual(teamRequests.addMember('team-1', 'user-1', 'admin').json, { userId: 'user-1', role: 'admin' });
  assert.deepEqual(teamRequests.addMember('team-1', 'Friend@Example.test', 'member').json, { email: 'friend@example.test', role: 'member' });
  assert.equal(teamRequests.removeMember('team-1', 'user-1').path, '/api/teams/team-1/members/user-1');
  assert.equal(teamRequests.remove('team-1').method, 'DELETE');
  assert.throws(() => teamRequests.addMember('team-1', 'user-1', 'super-admin'), /Invalid team role/);
  assert.throws(() => teamRequests.create('Bad', 'external'), /Invalid team kind/);
});

test('opaque ids reject traversal and control characters before URL interpolation', () => {
  assert.equal(safeOpaqueId('meeting:abc-123', 'meeting id'), 'meeting%3Aabc-123');
  for (const bad of ['', '../secret', 'a/b', 'a?x=1', 'a\nheader']) {
    assert.throws(() => safeOpaqueId(bad, 'meeting id'), /Invalid|required/);
  }
});
