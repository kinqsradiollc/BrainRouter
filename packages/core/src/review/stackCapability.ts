/**
 * ADR-028 A1 — is `gh stack` usable here?
 *
 * The extension is not guaranteed present. It needs `gh` 2.90+, git 2.20+, and
 * an explicit `gh extension install github/gh-stack`. Any of those missing
 * means the create path opens an ordinary pull request instead — which is what
 * the repository did yesterday, so it is not an error.
 *
 * This file holds the SHAPE of the answer and the version arithmetic.
 * `stackProbe.ts` is the detector that runs; there is deliberately no second,
 * async, cached one. The cached detector that used to live here
 * (`detectStackCapability` / `stackCapabilityFor`) was retired: it had no
 * caller outside its own test, and a cache with no invalidation caller is a
 * staleness bug waiting for someone to install the extension.
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
