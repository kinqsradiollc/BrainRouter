/**
 * CC-PARITY (0.4.17) — model-availability + version-range policy.
 *
 * Pure helpers so the agent-init and Fast-mode gates can be unit-tested without
 * a live provider or a real config file:
 *
 *  - `isModelAllowed` / `assertModelAllowed` enforce `cli.availableModels` when
 *    `cli.enforceAvailableModels` is on (empty list ⇒ no restriction).
 *  - `compareSemver` / `checkVersionRange` compare `version.ts` against the
 *    optional `cli.requiredMinimumVersion` / `requiredMaximumVersion` bounds.
 */

/** True when `model` is sanctioned. An empty/undefined allowlist ⇒ always true
 *  (no restriction). Matching is exact after trimming. */
export function isModelAllowed(model: string, availableModels: readonly string[] | undefined): boolean {
  const list = (availableModels ?? []).map((m) => (m ?? '').trim()).filter(Boolean);
  if (list.length === 0) return true;
  return list.includes((model ?? '').trim());
}

/**
 * Enforcement gate: returns an error MESSAGE when the model must be rejected,
 * or `null` when it is allowed. Only rejects when `enforce` is true AND the
 * allowlist is non-empty AND the model is not on it. `context` tags the message
 * (e.g. "Fast mode" / "agent init") for a clearer surface.
 */
export function assertModelAllowed(
  model: string,
  availableModels: readonly string[] | undefined,
  enforce: boolean,
  context = 'This install',
): string | null {
  if (!enforce) return null;
  const list = (availableModels ?? []).map((m) => (m ?? '').trim()).filter(Boolean);
  if (list.length === 0) return null;
  if (isModelAllowed(model, list)) return null;
  return `${context} restricts models to [${list.join(', ')}]; "${(model ?? '').trim()}" is not permitted.`;
}

/** Parse the leading `major.minor.patch` of a semver-ish string, ignoring any
 *  pre-release / build suffix. Returns `[0,0,0]` for an unparseable input. */
function parseSemver(v: string): [number, number, number] {
  const m = (v ?? '').trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return [0, 0, 0];
  return [Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

/** -1 / 0 / 1 for a<b / a==b / a>b, comparing major.minor.patch numerically. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}

export interface VersionRangeResult {
  /** True when `current` sits within [min, max] (blank bounds are open). */
  ok: boolean;
  /** A human-readable explanation when `ok` is false; otherwise `null`. */
  message: string | null;
}

/**
 * Compare `current` against the optional `min`/`max` bounds. A blank bound is
 * treated as unbounded on that side. When the current version is below `min` or
 * above `max`, `ok` is false with an explanatory message.
 */
export function checkVersionRange(current: string, min?: string, max?: string): VersionRangeResult {
  const lo = (min ?? '').trim();
  const hi = (max ?? '').trim();
  if (lo && compareSemver(current, lo) < 0) {
    return { ok: false, message: `BrainRouter ${current} is below the required minimum ${lo}.` };
  }
  if (hi && compareSemver(current, hi) > 0) {
    return { ok: false, message: `BrainRouter ${current} is above the supported maximum ${hi}.` };
  }
  return { ok: true, message: null };
}
