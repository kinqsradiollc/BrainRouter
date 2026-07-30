import { execFileSync } from 'node:child_process';

import type { WorktreeAwarenessHost } from './contracts.js';

export const nodeWorktreeAwarenessHost: WorktreeAwarenessHost = {
  listPorcelain(workspaceRoot): string {
    return execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  },
};
