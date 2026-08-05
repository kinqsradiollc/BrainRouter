/**
 * ADR-028 A1/H1 — probing `gh stack` from a synchronous caller.
 *
 * `detectStackCapability` is async because a probe shells out. The build loop
 * is synchronous, so this is the small synchronous bridge: it answers the one
 * question the PR router needs, and answers "no" on any doubt.
 *
 * Failing closed is deliberate. A wrong "yes" here turns a working plain-PR
 * path into a failing stack command; a wrong "no" opens the pull request that
 * would have been opened anyway.
 */
import { execFileSync } from 'node:child_process';
import type { StackCapability } from './stackCapability.js';
import { parseVersion, meetsMinimum, MIN_GH } from './stackCapability.js';

function tryRun(cmd: string, args: string[], cwd: string): string | null {
  try {
    return execFileSync(cmd, args, {
      cwd, encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

export function probeStackCapability(cwd: string): StackCapability {
  const ghRaw = tryRun('gh', ['--version'], cwd);
  if (!ghRaw) {
    return { available: false, reason: 'The GitHub CLI (`gh`) is not installed.', remediable: true };
  }
  if (!meetsMinimum(parseVersion(ghRaw), MIN_GH)) {
    return {
      available: false,
      ghVersion: ghRaw.trim().split('\n')[0],
      reason: `Stacked pull requests need gh ${MIN_GH.major}.${MIN_GH.minor}+; this is ${ghRaw.trim().split('\n')[0]}.`,
      remediable: true,
    };
  }
  const extensions = tryRun('gh', ['extension', 'list'], cwd) ?? '';
  if (!/gh-stack/.test(extensions)) {
    return {
      available: false,
      ghVersion: ghRaw.trim().split('\n')[0],
      extensionInstalled: false,
      reason: 'The gh-stack extension is not installed. Run `gh extension install github/gh-stack`.',
      remediable: true,
    };
  }
  return { available: true, ghVersion: ghRaw.trim().split('\n')[0], extensionInstalled: true };
}
