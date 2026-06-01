import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { withTempWorkspaceAsync } from './_helpers.js';
import { prepareChildWorkspace } from '../orchestration/worktreeIsolation.js';
import { executeOrchestrationTool, trackedPromiseFor } from '../orchestration/tools.js';
import { getSession } from '../orchestration/orchestrator.js';

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
    }
  });
});
