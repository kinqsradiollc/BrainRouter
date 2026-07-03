/**
 * MAS-P4-T4 (0.4.1) — auto-chain follow-ups.
 *
 * When a `worker` child finishes, the CLI can automatically chain a
 * review and/or verify pass on its output — closing the "agent shipped,
 * did it actually work?" loop without the user remembering to ask. This
 * generalises the old boolean `/auto-review` into a mode:
 *
 *   off    — nothing (default)
 *   review — spawn a reviewer on the diff
 *   verify — spawn a verifier (runs tests/build)
 *   both   — reviewer + verifier
 *
 * Only `worker` completions chain, and reviewers/verifiers are not
 * workers, so a follow-up never triggers another follow-up — the chain
 * is inherently one level deep. `maxFollowups` (default 2) is an extra
 * belt-and-braces cap.
 *
 * Pure module (no I/O) so it unit-tests cleanly.
 */

export type AutoChainMode = "off" | "review" | "verify" | "both";

export const AUTO_CHAIN_MODES: readonly AutoChainMode[] = ["off", "review", "verify", "both"];

export function isAutoChainMode(value: unknown): value is AutoChainMode {
  return typeof value === "string" && (AUTO_CHAIN_MODES as readonly string[]).includes(value);
}

/**
 * Resolve the effective mode from preferences. `autoChain` is canonical;
 * we fall back to the legacy `autoReview` boolean so existing configs
 * keep working (`autoReview: true` ⇒ `review`).
 */
export function resolveAutoChainMode(prefs: { autoChain?: AutoChainMode; autoReview?: boolean }): AutoChainMode {
  if (prefs.autoChain && isAutoChainMode(prefs.autoChain)) return prefs.autoChain;
  return prefs.autoReview ? "review" : "off";
}

/** The follow-up roles a mode chains, capped at `maxFollowups` (default 2). */
export function autoChainRoles(mode: AutoChainMode, maxFollowups = 2): Array<"reviewer" | "verifier"> {
  const roles: Array<"reviewer" | "verifier"> =
    mode === "review" ? ["reviewer"] : mode === "verify" ? ["verifier"] : mode === "both" ? ["reviewer", "verifier"] : [];
  return roles.slice(0, Math.max(0, maxFollowups));
}
