/** HONK-H4 — `brainrouter fleet` command helpers (pure). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRepoList, buildMigrationSpec, validateRunArgs, formatFleetStatus, fleetSnapshotPushArgs } from '../runtime/fleet/fleetCommand.js';
import type { FleetSummary, FleetLockRecord } from '@kinqs/brainrouter-core/fleet';

test('parseRepoList splits, trims, de-dups, and resolves to absolute paths', () => {
  const out = parseRepoList(' a , b ,a, ', '/work');
  assert.deepEqual(out, ['/work/a', '/work/b']);
  assert.deepEqual(parseRepoList(undefined, '/work'), []);
  assert.deepEqual(parseRepoList('', '/work'), []);
  // Absolute inputs pass through.
  assert.deepEqual(parseRepoList('/abs/x,/abs/y', '/work'), ['/abs/x', '/abs/y']);
});

test('buildMigrationSpec carries the command + optional fields and uses slug as the idempotency key', () => {
  const spec = buildMigrationSpec({ repos: ['/r/a'], command: 'npx codemod', slug: 'bump', base: 'main', title: 'T' });
  assert.equal(spec.kind, 'build');
  assert.deepEqual(spec.repos, ['/r/a']);
  assert.equal(spec.idempotencyKey, 'bump');
  assert.deepEqual(spec.input, { command: 'npx codemod', slug: 'bump', baseBranch: 'main', title: 'T' });

  // No slug → no idempotency key, no empty fields.
  const bare = buildMigrationSpec({ repos: ['/r/a'], command: 'fmt' });
  assert.equal(bare.idempotencyKey, undefined);
  assert.deepEqual(bare.input, { command: 'fmt' });
});

test('validateRunArgs requires a command and at least one repo', () => {
  assert.match(validateRunArgs({ repos: ['/r/a'], command: '' })!, /recipe is required/);
  assert.match(validateRunArgs({ repos: [], command: 'x' })!, /at least one repo/i);
  assert.equal(validateRunArgs({ repos: ['/r/a'], command: 'x' }), null);
});

function summary(over: Partial<FleetSummary> = {}): FleetSummary {
  return {
    total: 0,
    byStatus: { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0 },
    running: [],
    recent: [],
    ...over,
  };
}

test('formatFleetStatus renders counts, the runner holder, and recent PR links', () => {
  const s = summary({
    total: 2,
    byStatus: { pending: 1, running: 1, done: 0, failed: 0, cancelled: 0 },
    running: [{ id: 'fleet_aa', workspaceRoot: '/r/a' } as FleetSummary['running'][number]],
    recent: [{ id: 'fleet_bb', workspaceRoot: '/r/b', status: 'done', output: { prUrl: 'https://gh/pr/1' } } as FleetSummary['recent'][number]],
  });
  const lock: FleetLockRecord = { pid: 42, host: 'mac', acquiredAt: '2026-06-30T00:00:00.000Z', heartbeatAt: '2026-06-30T00:00:00.000Z' };
  const text = formatFleetStatus(s, lock);
  assert.match(text, /2 jobs/);
  assert.match(text, /pending 1\s+running 1/);
  assert.match(text, /runner: pid 42 on mac/);
  assert.match(text, /in flight:/);
  assert.match(text, /fleet_aa\s+\/r\/a/);
  assert.match(text, /done\s+fleet_bb\s+\/r\/b\s+→ https:\/\/gh\/pr\/1/);
});

test('formatFleetStatus reports no active runner when the lock is empty', () => {
  assert.match(formatFleetStatus(summary({ total: 1 }), null), /runner: none active/);
});

test('fleetSnapshotPushArgs carries the summary + total as the brain put-args', () => {
  const s = summary({ total: 4 });
  const args = fleetSnapshotPushArgs(s, 'mac-host');
  assert.equal(args.host, 'mac-host');
  assert.equal(args.jobCount, 4);
  assert.equal(args.snapshot, s);
  // Default host falls back to the OS hostname (non-empty).
  assert.ok(fleetSnapshotPushArgs(s).host.length > 0);
});
