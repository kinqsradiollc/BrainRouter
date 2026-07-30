import test from 'node:test';
import assert from 'node:assert/strict';
import {
  listOtherWorktrees,
  parseWorktreePorcelain,
  type WorktreeAwarenessHost,
} from '../worktree/concurrentWorktrees.js';
import { buildSystemPrompt } from '../prompt/systemPrompt.js';

const PORCELAIN = [
  'worktree /repo/main',
  'HEAD abc',
  'branch refs/heads/main',
  '',
  'worktree /repo/.worktrees/task-x',
  'HEAD def',
  'branch refs/heads/task/x',
  '',
  'worktree /repo/.worktrees/detached',
  'HEAD ghi',
  'detached',
  '',
].join('\n');

test('WORKTREE-AWARENESS: parseWorktreePorcelain lists OTHER worktrees, excluding self', () => {
  assert.deepEqual(
    parseWorktreePorcelain(PORCELAIN, '/repo/main'),
    ['/repo/.worktrees/task-x (task/x)', '/repo/.worktrees/detached (detached HEAD)'],
  );
  // From inside a linked worktree, the main tree + the sibling are the "others".
  assert.deepEqual(
    parseWorktreePorcelain(PORCELAIN, '/repo/.worktrees/task-x'),
    ['/repo/main (main)', '/repo/.worktrees/detached (detached HEAD)'],
  );
  // A single-worktree repo has no "others".
  assert.deepEqual(parseWorktreePorcelain('worktree /repo/main\nHEAD abc\nbranch refs/heads/main\n', '/repo/main'), []);
});

test('WORKTREE-AWARENESS: Runtime Context warns about concurrent worktrees only when present', () => {
  const base = { workspaceRoot: '/repo/main', launchCwd: '/repo/main', sessionKey: 's1', nowMs: 0 };
  const withWt = buildSystemPrompt({ ...base, activeWorktrees: ['/repo/wt (feature/x)'] });
  assert.ok(withWt.includes('Concurrent work areas'), 'awareness line present when other worktrees exist');
  assert.ok(withWt.includes('/repo/wt (feature/x)'), 'lists the other worktree');
  const without = buildSystemPrompt(base);
  assert.ok(!without.includes('Concurrent work areas'), 'no awareness line for a single-worktree repo');
});

test('repository guidance preserves unrelated dirty work and forbids generic rollback recovery', () => {
  const prompt = buildSystemPrompt({
    workspaceRoot: '/repo/main',
    launchCwd: '/repo/main',
    sessionKey: 's1',
    nowMs: 0,
  });
  assert.match(prompt, /dirty worktree is not a blocker/i);
  assert.match(prompt, /preserve unrelated user changes/i);
  assert.match(prompt, /failed checks need diagnosis/i);
  assert.match(prompt, /not generic rollback/i);
});

test('worktree awareness delegates Git discovery through an injected host', () => {
  const roots: string[] = [];
  const host: WorktreeAwarenessHost = {
    listPorcelain: (workspaceRoot) => {
      roots.push(workspaceRoot);
      return [
        'worktree /repo',
        'branch refs/heads/release',
        '',
        'worktree /repo-agent',
        'branch refs/heads/agent',
        '',
      ].join('\n');
    },
  };

  assert.deepEqual(listOtherWorktrees('/repo', host), ['/repo-agent (agent)']);
  assert.deepEqual(roots, ['/repo']);
});

test('worktree awareness stays best effort when the host cannot list Git state', () => {
  const host: WorktreeAwarenessHost = {
    listPorcelain: () => {
      throw new Error('git unavailable');
    },
  };

  assert.deepEqual(listOtherWorktrees('/repo', host), []);
});
