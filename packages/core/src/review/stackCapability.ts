/**
 * ADR-028 A1 — is `gh stack` usable here?
 *
 * The extension is not guaranteed present. It needs `gh` 2.90+, git 2.20+, and
 * an explicit `gh extension install github/gh-stack`. Any of those missing
 * means stack actions must be **hidden**, not offered-and-failing: an action
 * that always errors is worse than one that is not offered, because the agent
 * retries it and the human reads the retries as a defect in us.
 *
 * Detection is cached per workspace. It shells out, so doing it per turn would
 * add latency to every session for an answer that changes when someone installs
 * software — which is not often.
 */

export interface StackCapability {
  available: boolean;
  /** Present and parseable versions, when we got that far. */
  ghVersion?: string;
  gitVersion?: string;
  extensionInstalled?: boolean;
  /** Why it is unavailable, in words a human can act on. Absent when available. */
  reason?: string;
  /** True when installing something would fix it — as opposed to a repo setting. */
  remediable?: boolean;
}

export const MIN_GH = { major: 2, minor: 90 } as const;
export const MIN_GIT = { major: 2, minor: 20 } as const;

/** Parse `gh version 2.91.0 (…)` or `git version 2.39.5` → {major, minor}. */
export function parseVersion(text: string): { major: number; minor: number } | null {
  const m = /(\d+)\.(\d+)(?:\.\d+)?/.exec(text ?? '');
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return Number.isInteger(major) && Number.isInteger(minor) ? { major, minor } : null;
}

export function meetsMinimum(
  found: { major: number; minor: number } | null,
  min: { major: number; minor: number },
): boolean {
  if (!found) return false;
  if (found.major !== min.major) return found.major > min.major;
  return found.minor >= min.minor;
}

export interface CapabilityProbe {
  /** `gh --version`. Returns null when the binary is absent. */
  ghVersion(): Promise<string | null>;
  /** `git --version`. Returns null when the binary is absent. */
  gitVersion(): Promise<string | null>;
  /** `gh extension list` contains github/gh-stack. */
  hasStackExtension(): Promise<boolean>;
}

/**
 * Probe once and describe the result.
 *
 * Every unavailable path names the *specific* missing piece. "Stacks are not
 * available" tells the human nothing; "gh is 2.71, stacks need 2.90" tells them
 * exactly what to do, and the difference is whether the feature looks broken or
 * looks like it needs one command.
 */
export async function detectStackCapability(probe: CapabilityProbe): Promise<StackCapability> {
  let ghRaw: string | null;
  try {
    ghRaw = await probe.ghVersion();
  } catch {
    ghRaw = null;
  }
  if (!ghRaw) {
    return { available: false, reason: 'The GitHub CLI (`gh`) is not installed.', remediable: true };
  }
  const gh = parseVersion(ghRaw);
  if (!meetsMinimum(gh, MIN_GH)) {
    return {
      available: false,
      ghVersion: ghRaw.trim(),
      reason: `Stacked pull requests need gh ${MIN_GH.major}.${MIN_GH.minor}+; this is ${ghRaw.trim()}.`,
      remediable: true,
    };
  }

  let gitRaw: string | null;
  try {
    gitRaw = await probe.gitVersion();
  } catch {
    gitRaw = null;
  }
  const git = parseVersion(gitRaw ?? '');
  if (!meetsMinimum(git, MIN_GIT)) {
    return {
      available: false,
      ghVersion: ghRaw.trim(),
      ...(gitRaw ? { gitVersion: gitRaw.trim() } : {}),
      reason: `Stacked pull requests need git ${MIN_GIT.major}.${MIN_GIT.minor}+${gitRaw ? `; this is ${gitRaw.trim()}` : ', which was not found'}.`,
      remediable: true,
    };
  }

  let installed = false;
  try {
    installed = await probe.hasStackExtension();
  } catch {
    installed = false;
  }
  if (!installed) {
    return {
      available: false,
      ghVersion: ghRaw.trim(),
      gitVersion: gitRaw!.trim(),
      extensionInstalled: false,
      reason: 'The gh-stack extension is not installed. Run `gh extension install github/gh-stack`.',
      remediable: true,
    };
  }

  return {
    available: true,
    ghVersion: ghRaw.trim(),
    gitVersion: gitRaw!.trim(),
    extensionInstalled: true,
  };
}

/** Per-workspace cache. Detection shells out; the answer changes rarely. */
const cache = new Map<string, StackCapability>();

export async function stackCapabilityFor(
  workspaceRoot: string,
  probe: CapabilityProbe,
): Promise<StackCapability> {
  const hit = cache.get(workspaceRoot);
  if (hit) return hit;
  const result = await detectStackCapability(probe);
  cache.set(workspaceRoot, result);
  return result;
}

/** Clear the cache — after an install, or in tests. */
export function resetStackCapabilityCache(workspaceRoot?: string): void {
  if (workspaceRoot) cache.delete(workspaceRoot);
  else cache.clear();
}
