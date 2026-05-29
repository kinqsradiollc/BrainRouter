import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHandoffPacket, resolveHandoffTarget } from '../orchestration/handoff.js';

test('buildHandoffPacket assembles the packet and caps the transcript', () => {
  const p = buildHandoffPacket({
    goal: '  ship the thing  ',
    fromSessionKey: 'sk-from',
    originatingClient: 'brainrouter-cli',
    originatingWorkspace: '/repo',
    recentTranscript: 'x'.repeat(5000),
    note: '  be careful  ',
    now: '2026-05-29T00:00:00.000Z',
  });
  assert.equal(p.goal, 'ship the thing');
  assert.equal(p.note, 'be careful');
  assert.equal(p.recentTranscript.length, 4000);
  assert.equal(p.originatingClient, 'brainrouter-cli');
  assert.equal(p.createdAt, '2026-05-29T00:00:00.000Z');
});

const sessions = [
  { sessionKey: 'aaaa1111-2222-3333-4444-555555555555', clientKind: 'codex', lastHeartbeatAt: '2026-05-29T00:00:10Z' },
  { sessionKey: 'bbbb1111-2222-3333-4444-555555555555', clientKind: 'codex', lastHeartbeatAt: '2026-05-29T00:00:01Z' },
  { sessionKey: 'cccc1111-2222-3333-4444-555555555555', clientKind: 'brainrouter-cli', lastHeartbeatAt: '2026-05-29T00:00:05Z' },
];

test('resolveHandoffTarget: <kind>:next-idle picks the oldest-heartbeat peer of that kind', () => {
  const r = resolveHandoffTarget(sessions, 'codex:next-idle');
  // bbbb has the older heartbeat → most idle.
  assert.equal(r.to, 'bbbb1111-2222-3333-4444-555555555555');
});

test('resolveHandoffTarget: next-idle with no peer of that kind errors', () => {
  const r = resolveHandoffTarget(sessions, 'cursor:next-idle');
  assert.match(r.error ?? '', /No active "cursor" peer/);
});

test('resolveHandoffTarget: exact + unique prefix resolve', () => {
  assert.equal(resolveHandoffTarget(sessions, 'cccc1111-2222-3333-4444-555555555555').to, 'cccc1111-2222-3333-4444-555555555555');
  assert.equal(resolveHandoffTarget(sessions, 'cccc').to, 'cccc1111-2222-3333-4444-555555555555');
});

test('resolveHandoffTarget: ambiguous prefix errors', () => {
  const dupe = [{ sessionKey: 'dup-1' }, { sessionKey: 'dup-2' }];
  assert.match(resolveHandoffTarget(dupe, 'dup').error ?? '', /Ambiguous/);
});

test('resolveHandoffTarget: excludes self and rejects unknown short prefix', () => {
  const r = resolveHandoffTarget(sessions, 'cccc', 'cccc1111-2222-3333-4444-555555555555');
  assert.match(r.error ?? '', /No active session matched/);
});

test('resolveHandoffTarget: a full-looking unknown key passes through literally', () => {
  const full = '99999999-2222-3333-4444-555555555555';
  assert.equal(resolveHandoffTarget(sessions, full).to, full);
});
