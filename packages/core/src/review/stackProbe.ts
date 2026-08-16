/**
 * ADR-028 A1/H1 — the detector that runs.
 *
 * The build loop and the Track create-PR path are synchronous, so this is the
 * small synchronous probe behind them: it answers the one question the PR
 * router needs, and answers "no" on any doubt.
 *
 * Failing closed is deliberate. A wrong "yes" here turns a working plain-PR
 * path into a failing stack command; a wrong "no" opens the pull request that
 * would have been opened anyway.
 *
 * All three of A1's requirements are checked here — `gh` 2.90+, git 2.20+, and
 * the extension — because this is the only detector. The cached async one was
 * retired rather than kept beside it: two detectors that can disagree is worse
 * than one that is checked at each call.
 */
import { execFileSync } from 'node:child_process';
import type { StackCapability } from './stackCapability.js';
import { parseVersion, meetsMinimum, MIN_GH, MIN_GIT } from './stackCapability.js';

/** Runs a command and returns its stdout, or null when it cannot run at all. */
export type ProbeRunner = (cmd: string, args: readonly string[], cwd: string) => string | null;

const execRunner: ProbeRunner = (cmd, args, cwd) => {
  try {
    return execFileSync(cmd, [...args], {
      cwd, encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
};

/** First line only: `gh --version` prints a release-notes URL underneath it. */
function firstLine(text: string): string {
  return text.trim().split('\n')[0]!.trim();
}

export function probeStackCapability(cwd: string, run: ProbeRunner = execRunner): StackCapability {
  const ghRaw = run('gh', ['--version'], cwd);
  if (!ghRaw) {
    return { available: false, reason: 'The GitHub CLI (`gh`) is not installed.', remediable: true };
  }
  const ghVersion = firstLine(ghRaw);
  if (!meetsMinimum(parseVersion(ghRaw), MIN_GH)) {
    return {
      available: false,
      ghVersion,
      reason: `Stacked pull requests need gh ${MIN_GH.major}.${MIN_GH.minor}+; this is ${ghVersion}.`,
      remediable: true,
    };
  }

  // git is checked as well as gh: `gh stack` drives git's own rebase machinery,
  // and on a git too old for it the extension fails partway through a restack
  // rather than up front — which is the failure mode that leaves a half-rebased
  // tree behind.
  const gitRaw = run('git', ['--version'], cwd);
  const gitVersion = gitRaw ? firstLine(gitRaw) : '';
  if (!meetsMinimum(parseVersion(gitRaw ?? ''), MIN_GIT)) {
    return {
      available: false,
      ghVersion,
      ...(gitVersion ? { gitVersion } : {}),
      reason:
        `Stacked pull requests need git ${MIN_GIT.major}.${MIN_GIT.minor}+` +
        `${gitVersion ? `; this is ${gitVersion}` : ', which was not found'}.`,
      remediable: true,
    };
  }

  const extensions = run('gh', ['extension', 'list'], cwd) ?? '';
  if (!/gh-stack/.test(extensions)) {
    return {
      available: false,
      ghVersion,
      gitVersion,
      extensionInstalled: false,
      reason: 'The gh-stack extension is not installed. Run `gh extension install github/gh-stack`.',
      remediable: true,
    };
  }
  return { available: true, ghVersion, gitVersion, extensionInstalled: true };
}
