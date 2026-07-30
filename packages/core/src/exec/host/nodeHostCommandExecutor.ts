import { spawnSync } from 'node:child_process';

import type {
  HostCommandExecutor,
  HostCommandResult,
} from './contracts.js';

export const nodeHostCommandExecutor: HostCommandExecutor = {
  run(plan, timeout): HostCommandResult {
    const result = spawnSync(plan.executable, plan.args, {
      cwd: plan.cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
      maxBuffer: 16_000_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return {
      ok: result.status === 0 && !result.error,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? result.error?.message ?? '',
      status: result.status ?? undefined,
    };
  },
};
