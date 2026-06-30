/**
 * HONK-H3.2 — recipe runBuild: isolated-worktree command → patch, composed with
 * the build executor. All worktree/command deps are injected (no real git).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRecipeRunBuild } from '../fleet/recipe.js';
import { makeFleetBuildExecutor } from '../fleet/executors.js';
import type { FleetJobRecord } from '../fleet/fleetStore.js';
import type { ChildWorktreeIsolation, RemoveChildWorktreeResult } from '../worktree/worktreeIsolation.js';
import type { EmitPrInput, EmitPrResult } from '../git/prEmit.js';

function job(input: Record<string, unknown>): FleetJobRecord {
  return { id: 'fleet_r1', attempts: 1, workspaceRoot: '/r/a', input } as FleetJobRecord;
}
const ISO: ChildWorktreeIsolation = { kind: 'git-worktree', sourceRoot: '/r/a', worktreeRoot: '/wt/a' };

function harness(over: {
  command?: (cmd: string, cwd: string) => { ok: boolean; stdout: string; stderr: string };
  prepare?: () => { workspaceRoot: string; isolation: ChildWorktreeIsolation } | null;
  remove?: () => RemoveChildWorktreeResult;
} = {}) {
  const calls = { run: [] as Array<{ cmd: string; cwd: string }>, removed: 0 };
  const runBuild = makeRecipeRunBuild({
    runCommand: (cmd, cwd) => {
      calls.run.push({ cmd, cwd });
      return (over.command ?? (() => ({ ok: true, stdout: '', stderr: '' })))(cmd, cwd);
    },
    prepareWorktree: over.prepare ?? (() => ({ workspaceRoot: '/wt/a', isolation: ISO })),
    removeWorktree: () => {
      calls.removed += 1;
      return (over.remove ?? (() => ({ ok: true, changedFiles: 2, patchPath: '/state/r1.patch' })))();
    },
    patchFileFor: () => '/state/r1.patch',
  });
  return { runBuild, calls };
}

test('recipe runBuild: runs the command in the worktree and yields a patch result', async () => {
  const { runBuild, calls } = harness();
  const out = await runBuild(job({ command: 'npx codemod', slug: 'bump' }));
  assert.ok(out && !('skipped' in out));
  if (!('skipped' in out)) {
    assert.equal(out.sourceRoot, '/r/a');
    assert.equal(out.patchPath, '/state/r1.patch');
    assert.equal(out.slug, 'bump');
    assert.match(out.title, /bump/);
  }
  assert.equal(calls.run[0].cmd, 'npx codemod');
  assert.equal(calls.run[0].cwd, '/wt/a', 'command runs in the ISOLATED worktree, not the repo');
  assert.equal(calls.removed, 1, 'worktree torn down');
});

test('recipe runBuild: no command → skip without preparing a worktree', async () => {
  let prepared = 0;
  const runBuild = makeRecipeRunBuild({
    runCommand: () => ({ ok: true, stdout: '', stderr: '' }),
    prepareWorktree: () => { prepared += 1; return { workspaceRoot: '/wt/a', isolation: ISO }; },
    removeWorktree: () => ({ ok: true }),
  });
  const out = await runBuild(job({}));
  assert.deepEqual(out, { skipped: 'no-command' });
  assert.equal(prepared, 0);
});

test('recipe runBuild: not a git repo → skip', async () => {
  const { runBuild } = harness({ prepare: () => null });
  assert.deepEqual(await runBuild(job({ command: 'x' })), { skipped: 'not-a-git-repo' });
});

test('recipe runBuild: command that changes nothing → skip (no PR)', async () => {
  const { runBuild } = harness({ remove: () => ({ ok: true, changedFiles: 0 }) });
  assert.deepEqual(await runBuild(job({ command: 'true' })), { skipped: 'no-changes' });
});

test('recipe runBuild: failed command throws but STILL tears down the worktree', async () => {
  const { runBuild, calls } = harness({ command: () => ({ ok: false, stdout: '', stderr: 'exit 1' }) });
  await assert.rejects(() => runBuild(job({ command: 'false' })), /command failed.*exit 1/);
  assert.equal(calls.removed, 1, 'worktree cleaned up even on failure');
});

test('recipe runBuild composes with makeFleetBuildExecutor end-to-end (recipe → patch → PR)', async () => {
  const captured: EmitPrInput[] = [];
  const emitPr = (input: EmitPrInput): EmitPrResult => {
    captured.push(input);
    return { ok: true, prUrl: 'https://github.com/x/y/pull/9', prNumber: 9 };
  };
  const { runBuild } = harness();
  const exec = makeFleetBuildExecutor({ runBuild, emitPr });
  const out = (await exec(job({ command: 'npx codemod', slug: 'bump', baseBranch: 'main' }))) as {
    delivered: boolean;
    prNumber?: number;
  };
  assert.equal(out.delivered, true);
  assert.equal(out.prNumber, 9);
  assert.equal(captured[0].sourceRoot, '/r/a');
  assert.equal(captured[0].patchPath, '/state/r1.patch');
  assert.equal(captured[0].baseBranch, 'main');
  assert.equal(captured[0].runToken, 'fleet_r1-1', 'per-attempt branch token from the job');
});
