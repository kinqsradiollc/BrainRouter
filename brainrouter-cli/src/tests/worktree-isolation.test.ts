import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { withTempWorkspaceAsync } from './_helpers.js';
import { prepareChildWorkspace, removeChildWorktree, reconcileOrphanWorktrees, applyPatchFile } from '../orchestration/worktreeIsolation.js';
import { executeOrchestrationTool, trackedPromiseFor } from '../orchestration/tools.js';
import { getSession, pruneWorktreePatches } from '../orchestration/orchestrator.js';
import { getCliStateDir, getBrainrouterHome } from '../state/cliState.js';
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

test('CODEX-WORKTREE-MERGEBACK (A3) pruneWorktreePatches removes patches past the retention window', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const dir = path.join(getCliStateDir(workspace), 'worktree-patches');
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
