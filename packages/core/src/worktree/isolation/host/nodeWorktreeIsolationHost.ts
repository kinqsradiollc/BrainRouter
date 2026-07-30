import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { getCliKnobs } from '../../../config/config.js';
import { findGitRoot } from '../../../git/workspaceGit.js';
import { getBrainrouterHome, getStateDir } from '../../../storage/store.js';
import type { WorktreeIsolationHost } from './contracts.js';

export const nodeWorktreeIsolationHost: WorktreeIsolationHost = {
  realpath: (value) => fs.realpathSync(value),
  mkdir: (value) => fs.mkdirSync(value, { recursive: true }),
  exists: (value) => fs.existsSync(value),
  writeText: (file, value) => fs.writeFileSync(file, value, 'utf8'),
  readDirectory: (value) => fs.readdirSync(value),
  removeTree: (value) => fs.rmSync(value, { recursive: true, force: true }),
  runGit: (cwd, args) => {
    const result = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    });
    return {
      ok: result.status === 0,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? result.error?.message ?? '',
    };
  },
  findGitRoot,
  configuredWorktreeRoot: () => getCliKnobs().worktreeRoot?.trim() || undefined,
  brainrouterHome: getBrainrouterHome,
  stateDir: getStateDir,
  now: Date.now,
};
