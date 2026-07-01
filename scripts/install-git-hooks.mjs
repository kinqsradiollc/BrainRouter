#!/usr/bin/env node
/**
 * Point git at the committed `.githooks/` dir (Refactor R0.3). Runs from `prepare`
 * on every install, but is fully DEFENSIVE: it must never break `npm ci`.
 *  - no-op outside a git work tree (e.g. installed as a dependency, CI tarball)
 *  - no-op if the user already set a custom `core.hooksPath`
 *  - swallows every error
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(args) {
  return execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
}

try {
  // Only inside this repo's own work tree.
  const topLevel = git(['rev-parse', '--show-toplevel']);
  if (path.resolve(topLevel) !== root) process.exit(0);
  if (!existsSync(path.join(root, '.githooks', 'pre-commit'))) process.exit(0);

  let current = '';
  try {
    current = git(['config', '--local', '--get', 'core.hooksPath']);
  } catch {
    current = '';
  }
  // Respect a user's own custom hooksPath; only set when unset or already ours.
  if (current && current !== '.githooks') process.exit(0);
  if (current !== '.githooks') {
    execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root, stdio: 'ignore' });
    console.log('Installed git hooks → core.hooksPath=.githooks (bypass any time with --no-verify).');
  }
} catch {
  // Not a git repo / git unavailable / any failure — installing hooks is best
  // effort and must not fail the install.
  process.exit(0);
}
