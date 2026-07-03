import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { withTempWorkspaceAsync } from './_helpers.js';
import { prepareChildWorkspace, removeChildWorktree, reconcileOrphanWorktrees, applyPatchFile, prepareSharedWorktree, isSharedWorktreeOf, sharedWorktreeLaunchCwd, mergeBackLine } from '../worktree/worktreeIsolation.js';
import { finalizeBuildLoop, finalizeFanOutBuild, verifyLooksGreen, reviewHasBlocker } from '../orchestration/workflow/buildLoop.js';
import { executeOrchestrationTool, trackedPromiseFor } from '../orchestration/tools.js';
import { getSession, pruneWorktreePatches } from '../orchestration/session/orchestrator.js';
import { getStateDir, getBrainrouterHome } from '../storage/store.js';
import { setCliKnobOverride, _resetCliKnobsCache, getCliKnobs } from '../config/config.js';

function git(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return {
    ok: res.status === 0,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? res.error?.message ?? '',
  };
}

async function withGitWorkspace(fn: (workspace: string) => Promise<void>): Promise<void> {
  await withTempWorkspaceAsync(async (workspace) => {
    const init = git(workspace, ['init']);
    if (!init.ok) return;
    git(workspace, ['config', 'user.email', 'brainrouter-test@example.com']);
    git(workspace, ['config', 'user.name', 'BrainRouter Test']);
    fs.writeFileSync(path.join(workspace, 'README.md'), 'root\n', 'utf8');
    fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'src', 'index.ts'), 'export const x = 1;\n', 'utf8');
    git(workspace, ['add', '.']);
    const commit = git(workspace, ['commit', '-m', 'init']);
    if (!commit.ok) return;
    await fn(workspace);
  });
}

test('CODEX-WORKTREE-ISOLATION read children share the parent workspace', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const resolved = prepareChildWorkspace({
      parentWorkspaceRoot: workspace,
      parentLaunchCwd: workspace,
      childId: 'agent-read',
      access: 'read',
      mode: 'auto',
    });
    assert.equal(resolved.isolated, false);
    assert.equal(resolved.workspaceRoot, fs.realpathSync(workspace));
  });
});

test('CODEX-WORKTREE-ISOLATION write children get a detached git worktree in auto mode', async () => {
  await withGitWorkspace(async (workspace) => {
    const launch = path.join(workspace, 'src');
    const resolved = prepareChildWorkspace({
      parentWorkspaceRoot: workspace,
      parentLaunchCwd: launch,
      childId: `agent-${Date.now()}`,
      access: 'write',
      mode: 'auto',
    });
    try {
      assert.equal(resolved.isolated, true);
      assert.notEqual(resolved.workspaceRoot, fs.realpathSync(workspace));
      assert.equal(path.basename(resolved.launchCwd), 'src');
      assert.equal(fs.readFileSync(path.join(resolved.workspaceRoot, 'README.md'), 'utf8'), 'root\n');
      assert.ok(resolved.isolation);
      assert.equal(resolved.isolation?.kind, 'git-worktree');
    } finally {
      git(workspace, ['worktree', 'remove', '--force', resolved.workspaceRoot]);
      fs.rmSync(resolved.workspaceRoot, { recursive: true, force: true });
    }
  });
});

test('CODEX-WORKTREE-ISOLATION git-worktree mode fails closed outside git', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    assert.throws(
      () => prepareChildWorkspace({
        parentWorkspaceRoot: workspace,
        parentLaunchCwd: workspace,
        childId: 'agent-write',
        access: 'write',
        mode: 'git-worktree',
      }),
      /not inside a git repository/i,
    );
  });
});

test('CODEX-WORKTREE-ISOLATION spawn_agent routes mutating child into isolated workspace metadata', async () => {
  await withGitWorkspace(async (workspace) => {
    // 'auto' is the default as of CODEX-WORKTREE-MERGEBACK; set it explicitly so
    // the routing assertion stays independent of config/default drift.
    setCliKnobOverride({ childWorkspaceIsolation: 'auto' });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'child done' } }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as any;
    try {
      const stubMcp: any = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [{ text: '{}' }] }),
        close: async () => {},
      };
      const raw = await executeOrchestrationTool('spawn_agent', {
        role: 'worker',
        prompt: 'mutating child',
        access: 'write',
      }, {
        workspaceRoot: workspace,
        parentSessionKey: 'session:test',
        parentAccessMode: 'shell',
        mcpClient: stubMcp,
        llmConfig: { provider: 'openai', apiKey: 'k', model: 'test-model' },
        launchCwd: workspace,
      });
      const result = JSON.parse(raw);
      try {
        assert.equal(result.isolatedWorkspace, true);
        assert.notEqual(result.workspaceRoot, fs.realpathSync(workspace));
        await trackedPromiseFor(result.id);
        const record = getSession(workspace, result.id);
        assert.equal(record?.childWorkspaceRoot, result.workspaceRoot);
        assert.equal(record?.childWorkspaceIsolation?.kind, 'git-worktree');
      } finally {
        git(workspace, ['worktree', 'remove', '--force', result.workspaceRoot]);
        fs.rmSync(result.workspaceRoot, { recursive: true, force: true });
      }
    } finally {
      globalThis.fetch = originalFetch;
      _resetCliKnobsCache();
    }
  });
});

test('CODEX-WORKTREE-MERGEBACK default is auto — isolation on by default', async () => {
  // Fresh temp home → no config.json → documented defaults.
  await withTempWorkspaceAsync(async () => {
    _resetCliKnobsCache();
    try {
      assert.equal(getCliKnobs().childWorkspaceIsolation, 'auto');
    } finally {
      _resetCliKnobsCache();
    }
  });
});

test('CODEX-WORKTREE-CLEANUP removeChildWorktree captures the diff then removes the worktree', async () => {
  await withGitWorkspace(async (workspace) => {
    const resolved = prepareChildWorkspace({
      parentWorkspaceRoot: workspace,
      parentLaunchCwd: workspace,
      childId: `agent-cleanup-${Date.now()}`,
      access: 'write',
      mode: 'auto',
    });
    assert.ok(resolved.isolation, 'precondition: isolated worktree created');
    // The child "edits" a file inside its worktree.
    fs.writeFileSync(path.join(resolved.workspaceRoot, 'src', 'index.ts'), 'export const x = 2; // changed\n', 'utf8');
    const out = removeChildWorktree(resolved.isolation);
    assert.equal(out.ok, true);
    assert.equal(out.changedFiles, 1, 'one file changed in the worktree');
    assert.match(out.diff ?? '', /index\.ts/);
    // The worktree directory is gone, and git no longer tracks it.
    assert.equal(fs.existsSync(resolved.workspaceRoot), false);
    const list = git(workspace, ['worktree', 'list', '--porcelain']).stdout;
    assert.ok(!list.includes(resolved.workspaceRoot), 'git worktree list no longer references the removed worktree');
  });
});

test('CODEX-WORKTREE-CLEANUP removeChildWorktree is a no-op for non-isolated children', () => {
  assert.deepEqual(removeChildWorktree(null), { ok: true });
  assert.deepEqual(removeChildWorktree(undefined), { ok: true });
});

test('CODEX-WORKTREE-MERGEBACK applyBack merges a clean child change onto the parent tree', async () => {
  await withGitWorkspace(async (workspace) => {
    const resolved = prepareChildWorkspace({
      parentWorkspaceRoot: workspace,
      parentLaunchCwd: workspace,
      childId: `agent-merge-${Date.now()}`,
      access: 'write',
      mode: 'auto',
    });
    assert.ok(resolved.isolation, 'precondition: isolated worktree created');
    // Child edits a tracked file AND adds a new file inside its worktree.
    fs.writeFileSync(path.join(resolved.workspaceRoot, 'src', 'index.ts'), 'export const x = 42;\n', 'utf8');
    fs.writeFileSync(path.join(resolved.workspaceRoot, 'NEW.md'), 'from child\n', 'utf8');
    const patchFile = path.join(workspace, '.test-patches', 'merge.patch');
    const out = removeChildWorktree(resolved.isolation, { applyBack: true, patchFile });
    assert.equal(out.ok, true);
    assert.equal(out.changedFiles, 2, 'edited index.ts + added NEW.md');
    assert.equal(out.applied, true, 'clean patch applied to the parent tree');
    assert.ok(out.patchPath && fs.existsSync(out.patchPath), 'full recovery patch persisted to disk');
    // The parent working tree now reflects the child's work (merge-back).
    assert.equal(fs.readFileSync(path.join(workspace, 'src', 'index.ts'), 'utf8'), 'export const x = 42;\n');
    assert.equal(fs.readFileSync(path.join(workspace, 'NEW.md'), 'utf8'), 'from child\n');
  });
});

test('CODEX-WORKTREE-MERGEBACK applyBack preserves the patch + leaves the parent tree untouched on conflict', async () => {
  await withGitWorkspace(async (workspace) => {
    const resolved = prepareChildWorkspace({
      parentWorkspaceRoot: workspace,
      parentLaunchCwd: workspace,
      childId: `agent-conflict-${Date.now()}`,
      access: 'write',
      mode: 'auto',
    });
    assert.ok(resolved.isolation, 'precondition: isolated worktree created');
    // Child edits index.ts in its worktree…
    fs.writeFileSync(path.join(resolved.workspaceRoot, 'src', 'index.ts'), 'export const x = 2; // child\n', 'utf8');
    // …while the parent independently edits the SAME line (drift → conflict).
    fs.writeFileSync(path.join(workspace, 'src', 'index.ts'), 'export const x = 3; // parent\n', 'utf8');
    const patchFile = path.join(workspace, '.test-patches', 'conflict.patch');
    const out = removeChildWorktree(resolved.isolation, { applyBack: true, patchFile });
    assert.equal(out.applied, false, 'conflicting patch is NOT applied');
    assert.ok(out.applyError, 'applyError explains why the merge-back was skipped');
    assert.ok(out.patchPath && fs.existsSync(out.patchPath), 'patch preserved for manual `git apply`');
    // Parent keeps ITS version — no conflict markers smeared into the tree.
    assert.equal(fs.readFileSync(path.join(workspace, 'src', 'index.ts'), 'utf8'), 'export const x = 3; // parent\n');
  });
});

test('CODEX-WORKTREE-CLEANUP reconcileOrphanWorktrees removes a leftover dir git no longer tracks', async () => {
  await withGitWorkspace(async (workspace) => {
    const resolved = prepareChildWorkspace({
      parentWorkspaceRoot: workspace,
      parentLaunchCwd: workspace,
      childId: `agent-orphan-${Date.now()}`,
      access: 'write',
      mode: 'auto',
    });
    assert.ok(resolved.isolation);
    // Simulate a crash: git's worktree admin entry is pruned but the dir
    // lingers (as if the process died before cleanup).
    git(workspace, ['worktree', 'remove', '--force', resolved.workspaceRoot]);
    fs.mkdirSync(resolved.workspaceRoot, { recursive: true });
    fs.writeFileSync(path.join(resolved.workspaceRoot, 'stale.txt'), 'orphan\n', 'utf8');
    assert.equal(fs.existsSync(resolved.workspaceRoot), true);
    const removed = reconcileOrphanWorktrees(workspace);
    assert.ok(removed >= 1, 'at least the orphan dir was reclaimed');
    assert.equal(fs.existsSync(resolved.workspaceRoot), false);
  });
});

test('WORKTREE-GC reconcileOrphanWorktrees KEEPS a LIVE child worktree (keepChildIds guard)', async () => {
  await withGitWorkspace(async (workspace) => {
    const childId = `agent-live-${Date.now()}`;
    const resolved = prepareChildWorkspace({ parentWorkspaceRoot: workspace, parentLaunchCwd: workspace, childId, access: 'write', mode: 'auto' });
    assert.ok(resolved.isolation);
    // Reproduce the bug's setup: git "loses track" of the worktree (admin entry
    // gone) but the dir is live + in use by a running child. Without the guard the
    // GC would delete it out from under the child → ENOENT on every tool call.
    git(workspace, ['worktree', 'remove', '--force', resolved.workspaceRoot]);
    fs.mkdirSync(resolved.workspaceRoot, { recursive: true });
    fs.writeFileSync(path.join(resolved.workspaceRoot, 'wip.txt'), 'in progress\n', 'utf8');
    // WITH the live child id → kept.
    const removed = reconcileOrphanWorktrees(workspace, { keepChildIds: [childId] });
    assert.equal(removed, 0, 'a live child worktree is never reclaimed');
    assert.equal(fs.existsSync(resolved.workspaceRoot), true, 'worktree survives the GC');
    // Once the child is no longer live, the SAME dir IS reclaimed (real orphan).
    const removedAfter = reconcileOrphanWorktrees(workspace, { keepChildIds: [] });
    assert.ok(removedAfter >= 1, 'reclaimed once no longer live');
    assert.equal(fs.existsSync(resolved.workspaceRoot), false);
  });
});

test('A5 (0.4.11) worktrees live under BRAINROUTER_HOME/worktrees, not $TMPDIR', async () => {
  await withGitWorkspace(async (workspace) => {
    const resolved = prepareChildWorkspace({
      parentWorkspaceRoot: workspace,
      parentLaunchCwd: workspace,
      childId: `agent-loc-${Date.now()}`,
      access: 'write',
      mode: 'auto',
    });
    try {
      assert.ok(resolved.isolation, 'worktree created');
      const worktreesBase = fs.realpathSync(path.join(getBrainrouterHome(), 'worktrees'));
      assert.ok(
        resolved.workspaceRoot.startsWith(worktreesBase),
        `worktree ${resolved.workspaceRoot} should live under ${worktreesBase}`,
      );
      assert.equal(resolved.workspaceRoot.includes('brainrouter-worktrees'), false, 'no longer under the old $TMPDIR base');
    } finally {
      git(workspace, ['worktree', 'remove', '--force', resolved.workspaceRoot]);
      fs.rmSync(resolved.workspaceRoot, { recursive: true, force: true });
    }
  });
});

test('A5.1 (0.4.11) cli.worktreeRoot relocates the worktree base', async () => {
  await withGitWorkspace(async (workspace) => {
    const customBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'br-custom-wt-')));
    setCliKnobOverride({ worktreeRoot: customBase });
    let resolved: ReturnType<typeof prepareChildWorkspace> | undefined;
    try {
      resolved = prepareChildWorkspace({
        parentWorkspaceRoot: workspace,
        parentLaunchCwd: workspace,
        childId: `agent-custom-${Date.now()}`,
        access: 'write',
        mode: 'auto',
      });
      assert.ok(resolved.isolation);
      assert.ok(
        resolved.workspaceRoot.startsWith(customBase),
        `worktree ${resolved.workspaceRoot} should live under the custom base ${customBase}`,
      );
    } finally {
      if (resolved?.workspaceRoot) {
        git(workspace, ['worktree', 'remove', '--force', resolved.workspaceRoot]);
        fs.rmSync(resolved.workspaceRoot, { recursive: true, force: true });
      }
      _resetCliKnobsCache();
      fs.rmSync(customBase, { recursive: true, force: true });
    }
  });
});

test('CODEX-WORKTREE-MERGEBACK (A2) applyPatchFile applies a clean patch + rejects a conflicting one', async () => {
  await withGitWorkspace(async (workspace) => {
    const resolved = prepareChildWorkspace({
      parentWorkspaceRoot: workspace,
      parentLaunchCwd: workspace,
      childId: `agent-a2-${Date.now()}`,
      access: 'write',
      mode: 'auto',
    });
    assert.ok(resolved.isolation, 'precondition: isolated worktree created');
    fs.writeFileSync(path.join(resolved.workspaceRoot, 'src', 'index.ts'), 'export const x = 7;\n', 'utf8');
    const patchFile = path.join(workspace, '.test-patches', 'a2.patch');
    // Capture WITHOUT applying so we can apply it manually (the /agents diff path).
    const out = removeChildWorktree(resolved.isolation, { applyBack: false, patchFile });
    assert.ok(out.patchPath && fs.existsSync(out.patchPath), 'recovery patch persisted');
    // Clean apply onto the parent (still at x = 1).
    const ok = applyPatchFile(workspace, out.patchPath!);
    assert.equal(ok.ok, true, ok.error);
    assert.equal(fs.readFileSync(path.join(workspace, 'src', 'index.ts'), 'utf8'), 'export const x = 7;\n');
    // Re-applying now conflicts (tree is x = 7; the patch context expects x = 1).
    const again = applyPatchFile(workspace, out.patchPath!);
    assert.equal(again.ok, false, 'second apply rejected on context drift');
    assert.ok(again.error, 'reports why it was rejected');
  });
});

test('BUILD-LOOP P2 verifyLooksGreen / reviewHasBlocker heuristics', () => {
  assert.equal(verifyLooksGreen('Ran node --test. All tests passed. Verdict: PASS'), true);
  assert.equal(verifyLooksGreen('2 tests failed. Verdict: FAIL'), false);
  assert.equal(verifyLooksGreen('✓ build ok'), true);
  // Review fix — benign "no failure" phrasings must NOT read as red (false negatives).
  assert.equal(verifyLooksGreen('Tests: 12 passed, 0 failed'), true, '"0 failed" is green');
  assert.equal(verifyLooksGreen('Test run complete: no failures.'), true, '"no failures" is green');
  assert.equal(verifyLooksGreen('Tests run: 10, Failures: 0, Errors: 0'), true, '"Failures: 0" is green');
  assert.equal(verifyLooksGreen('BUILD SUCCESSFUL in 3s'), true, '"successful" is green');
  // A real failure still trips it even alongside a "0 failed" count.
  assert.equal(verifyLooksGreen('5 passed, 1 failed'), false, 'a real failure is still red');
  assert.equal(reviewHasBlocker('blocker: null deref at auth.ts:12'), true);
  assert.equal(reviewHasBlocker('minor: rename var; nit: spacing'), false);
  // Review fix — negated/benign mentions must NOT hold the merge (false positives).
  assert.equal(reviewHasBlocker('No blockers found. Two minor nits.'), false, '"no blockers" is not a blocker');
  assert.equal(reviewHasBlocker('blocker: none — looks good'), false, '"blocker: none" is not a blocker');
  assert.equal(reviewHasBlocker('0 blockers, 1 major'), false, '"0 blockers" is not a blocker');
  assert.equal(reviewHasBlocker('blocker: slice B breaks slice A'), true, 'an affirmative blocker still holds');
});

test('BUILD-LOOP P2 (review) isSharedWorktreeOf accepts same-repo worktree, rejects foreign/arbitrary paths', async () => {
  await withGitWorkspace(async (workspace) => {
    const shared = prepareSharedWorktree(workspace, 'guard')!;
    try {
      assert.equal(isSharedWorktreeOf(workspace, shared.workspaceRoot), true, 'a worktree of this repo is accepted');
      assert.equal(isSharedWorktreeOf(workspace, workspace), true, 'the repo root itself shares the common dir');
      // An arbitrary dir outside any related repo is rejected (escape-hatch closed).
      await withTempWorkspaceAsync(async (foreign) => {
        assert.equal(isSharedWorktreeOf(workspace, foreign), false, 'non-repo path rejected');
        assert.equal(isSharedWorktreeOf(workspace, path.join(foreign, 'does-not-exist')), false, 'missing path rejected');
      });
      // launch cwd maps a subdir into the worktree, falls back to root otherwise.
      assert.equal(path.basename(sharedWorktreeLaunchCwd(workspace, path.join(workspace, 'src'), shared.workspaceRoot)), 'src');
      assert.equal(sharedWorktreeLaunchCwd(workspace, '/nonexistent/sub', shared.workspaceRoot), shared.workspaceRoot);
    } finally {
      git(workspace, ['worktree', 'remove', '--force', shared.workspaceRoot]);
      fs.rmSync(shared.workspaceRoot, { recursive: true, force: true });
    }
  });
});

test('BUILD-LOOP P2 (review) prepareSharedWorktree resets a reused dirty worktree to a clean HEAD', async () => {
  await withGitWorkspace(async (workspace) => {
    const first = prepareSharedWorktree(workspace, 'reuse')!;
    try {
      // Simulate a crashed prior run: leave uncommitted edits + an untracked file behind.
      fs.writeFileSync(path.join(first.workspaceRoot, 'src', 'index.ts'), 'export const DIRTY = true;\n', 'utf8');
      fs.writeFileSync(path.join(first.workspaceRoot, 'untracked.tmp'), 'junk\n', 'utf8');
      // A new run with the SAME slug reuses the path but must start clean.
      const second = prepareSharedWorktree(workspace, 'reuse')!;
      assert.equal(second.workspaceRoot, first.workspaceRoot, 'same slug → same worktree path');
      assert.equal(fs.readFileSync(path.join(second.workspaceRoot, 'src', 'index.ts'), 'utf8'), 'export const x = 1;\n', 'reset to clean HEAD');
      assert.equal(fs.existsSync(path.join(second.workspaceRoot, 'untracked.tmp')), false, 'untracked leftovers cleaned');
      // The leftover edits were preserved to a recovery patch (no silent loss).
      const patchDir = path.join(getStateDir(workspace), 'worktree-patches');
      const leftovers = fs.existsSync(patchDir) ? fs.readdirSync(patchDir).filter((f) => f.startsWith('leftover-')) : [];
      assert.ok(leftovers.length >= 1, 'leftover edits preserved as a recovery patch');
    } finally {
      git(workspace, ['worktree', 'remove', '--force', first.workspaceRoot]);
      fs.rmSync(first.workspaceRoot, { recursive: true, force: true });
    }
  });
});

test('BUILD-LOOP P2 (review) finalizeBuildLoop reports a clean no-op when the build produced no changes', async () => {
  await withGitWorkspace(async (workspace) => {
    const shared = prepareSharedWorktree(workspace, 'noop')!;
    // No edits in the worktree; verify green + review ok.
    const exec: any = { status: 'completed', phases: [
      { id: 'implement', title: 'Implement', status: 'completed', output: 'nothing to change', children: [] },
      { id: 'verify', title: 'Verify', status: 'completed', output: 'All tests passed. Verdict: PASS', children: [] },
      { id: 'review', title: 'Review', status: 'completed', output: 'no findings', children: [] },
    ] };
    const out = finalizeBuildLoop(workspace, 'noop', shared, exec);
    assert.equal(out.merged, true, out.reason);
    assert.equal(out.changedFiles ?? 0, 0);
    assert.match(out.reason, /no file changes|no-op/i);
    assert.doesNotMatch(out.reason, /did not apply cleanly/);
  });
});

test('BUILD-LOOP P2 prepareSharedWorktree creates a shared worktree; null outside git', async () => {
  await withGitWorkspace(async (workspace) => {
    const shared = prepareSharedWorktree(workspace, 'run1');
    assert.ok(shared, 'created inside a git repo');
    try {
      assert.ok(path.basename(shared!.workspaceRoot).startsWith('build-'), 'worktree named build-*');
      assert.notEqual(shared!.workspaceRoot, fs.realpathSync(workspace));
      assert.equal(fs.readFileSync(path.join(shared!.workspaceRoot, 'README.md'), 'utf8'), 'root\n', 'checked out at HEAD');
    } finally {
      git(workspace, ['worktree', 'remove', '--force', shared!.workspaceRoot]);
      fs.rmSync(shared!.workspaceRoot, { recursive: true, force: true });
    }
  });
  await withTempWorkspaceAsync(async (workspace) => {
    assert.equal(prepareSharedWorktree(workspace, 'x'), null, 'null outside a git repo');
  });
});

test('BUILD-LOOP P2 finalizeBuildLoop merges on verify-green + review-ok', async () => {
  await withGitWorkspace(async (workspace) => {
    const shared = prepareSharedWorktree(workspace, 'green')!;
    // The worker "implemented" inside the shared worktree.
    fs.writeFileSync(path.join(shared.workspaceRoot, 'src', 'index.ts'), 'export const x = 99;\n', 'utf8');
    const exec: any = { status: 'completed', phases: [
      { id: 'implement', title: 'Implement', status: 'completed', output: 'edited src/index.ts', children: [] },
      { id: 'verify', title: 'Verify', status: 'completed', output: 'ran node --test. Verdict: PASS', children: [] },
      { id: 'review', title: 'Review', status: 'completed', output: 'nit: spacing — no blockers', children: [] },
    ] };
    const out = finalizeBuildLoop(workspace, 'green', shared, exec);
    assert.equal(out.verifyGreen, true);
    assert.equal(out.reviewApproved, true);
    assert.equal(out.merged, true, out.reason);
    assert.equal(fs.readFileSync(path.join(workspace, 'src', 'index.ts'), 'utf8'), 'export const x = 99;\n', 'merged into the parent tree');
  });
});

test('BUILD-LOOP P2 finalizeBuildLoop preserves a patch on red verify (no merge)', async () => {
  await withGitWorkspace(async (workspace) => {
    const shared = prepareSharedWorktree(workspace, 'red')!;
    fs.writeFileSync(path.join(shared.workspaceRoot, 'src', 'index.ts'), 'export const x = 7;\n', 'utf8');
    const exec: any = { status: 'completed', phases: [
      { id: 'implement', title: 'Implement', status: 'completed', output: 'edited it', children: [] },
      { id: 'verify', title: 'Verify', status: 'completed', output: '1 test failed. Verdict: FAIL', children: [] },
      { id: 'review', title: 'Review', status: 'completed', output: 'looks fine', children: [] },
    ] };
    const out = finalizeBuildLoop(workspace, 'red', shared, exec);
    assert.equal(out.verifyGreen, false);
    assert.equal(out.merged, false);
    assert.ok(out.patchPath && fs.existsSync(out.patchPath), 'work preserved as a recovery patch');
    assert.equal(fs.readFileSync(path.join(workspace, 'src', 'index.ts'), 'utf8'), 'export const x = 1;\n', 'parent tree untouched');
  });
});

test('CODEX-WORKTREE-MERGEBACK (A3) pruneWorktreePatches removes patches past the retention window', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const dir = path.join(getStateDir(workspace), 'worktree-patches');
    fs.mkdirSync(dir, { recursive: true });
    const fresh = path.join(dir, 'agent-fresh.patch');
    const old = path.join(dir, 'agent-old.patch');
    fs.writeFileSync(fresh, 'diff --git a/x b/x\n', 'utf8');
    fs.writeFileSync(old, 'diff --git a/y b/y\n', 'utf8');
    // Backdate the old patch 10 days (> the 7-day default retention).
    const tenDaysAgoSec = (Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(old, tenDaysAgoSec, tenDaysAgoSec);
    const removed = pruneWorktreePatches(workspace);
    assert.equal(removed, 1, 'exactly the stale patch was pruned');
    assert.equal(fs.existsSync(old), false, 'old patch removed');
    assert.equal(fs.existsSync(fresh), true, 'fresh patch kept');
  });
});

test('BUILD-LOOP P2.5 mergeBackLine: merged / not-merged / held notices by reason', () => {
  assert.match(mergeBackLine({ changedFiles: 3, applied: true }, 'a1', null), /3 file\(s\) merged into your tree/);
  assert.match(mergeBackLine({ changedFiles: 2, applied: false, applyError: 'drift' }, 'a1', null), /NOT merged \(drift\).*\/agents diff a1/);
  // 'review' (the knob): the user applies explicitly.
  assert.match(mergeBackLine({ changedFiles: 2, applied: false }, 'a1', 'review'), /HELD for review \(cli\.worktreeMergeReview\).*\/agents diff a1 apply/);
  // 'fanout' (a build slice): the synthesis gate owns the merge — no manual-apply step.
  const fan = mergeBackLine({ changedFiles: 2, applied: false }, 'a1', 'fanout');
  assert.match(fan, /HELD.*synthesis gate/);
  assert.doesNotMatch(fan, /agents diff a1 apply/);
  assert.equal(mergeBackLine({ changedFiles: 0 }, 'a1', 'review'), '', 'no changes → no notice');
});

// Produce a real HELD slice patch (the fan-out worker's preserved worktree).
async function makeHeldSlice(workspace: string, sliceId: string, file: string, content: string): Promise<{ id: string; patchPath?: string }> {
  const wt = prepareSharedWorktree(workspace, sliceId)!;
  fs.mkdirSync(path.dirname(path.join(wt.workspaceRoot, file)), { recursive: true });
  fs.writeFileSync(path.join(wt.workspaceRoot, file), content, 'utf8');
  const patchFile = path.join(getStateDir(workspace), 'worktree-patches', `${sliceId}.patch`);
  const cleanup = removeChildWorktree(wt.isolation, { applyBack: false, patchFile });
  return { id: sliceId, patchPath: cleanup.patchPath };
}

test('BUILD-LOOP P2.5 finalizeFanOutBuild merges non-overlapping slices', async () => {
  await withGitWorkspace(async (workspace) => {
    const s1 = await makeHeldSlice(workspace, 'slice-a', 'src/a.ts', 'export const a = 1;\n');
    const s2 = await makeHeldSlice(workspace, 'slice-b', 'src/b.ts', 'export const b = 2;\n');
    const out = finalizeFanOutBuild(workspace, [s1, s2], 'no findings, looks consistent');
    assert.equal(out.reviewApproved, true);
    assert.equal(out.mergedSlices.length, 2, out.reason);
    assert.equal(out.heldSlices.length, 0);
    assert.equal(fs.readFileSync(path.join(workspace, 'src', 'a.ts'), 'utf8'), 'export const a = 1;\n');
    assert.equal(fs.readFileSync(path.join(workspace, 'src', 'b.ts'), 'utf8'), 'export const b = 2;\n');
  });
});

test('BUILD-LOOP P2.5 finalizeFanOutBuild holds an overlapping slice (first writer wins)', async () => {
  await withGitWorkspace(async (workspace) => {
    // Both slices edit the SAME tracked file → overlap; first merges, second held.
    const s1 = await makeHeldSlice(workspace, 'ov-1', 'src/index.ts', 'export const x = 11;\n');
    const s2 = await makeHeldSlice(workspace, 'ov-2', 'src/index.ts', 'export const x = 22;\n');
    const out = finalizeFanOutBuild(workspace, [s1, s2], 'consistent');
    assert.deepEqual(out.mergedSlices.map((m) => m.id), ['ov-1']);
    assert.equal(out.heldSlices.length, 1);
    assert.equal(out.heldSlices[0].id, 'ov-2');
    assert.equal(out.overlaps.length, 1);
    assert.equal(fs.readFileSync(path.join(workspace, 'src', 'index.ts'), 'utf8'), 'export const x = 11;\n', 'first writer landed, not clobbered');
  });
});

test('BUILD-LOOP P2.5 finalizeFanOutBuild: a synthesis blocker holds every slice', async () => {
  await withGitWorkspace(async (workspace) => {
    const s1 = await makeHeldSlice(workspace, 'blk-a', 'src/a.ts', 'export const a = 1;\n');
    const s2 = await makeHeldSlice(workspace, 'blk-b', 'src/b.ts', 'export const b = 2;\n');
    const out = finalizeFanOutBuild(workspace, [s1, s2], 'blocker: slice B breaks the contract slice A relies on');
    assert.equal(out.reviewApproved, false);
    assert.equal(out.mergedSlices.length, 0, out.reason);
    assert.equal(out.heldSlices.length, 2);
    assert.equal(fs.existsSync(path.join(workspace, 'src', 'a.ts')), false, 'nothing merged on a blocker');
  });
});
