/**
 * MAS-P4-T2 (0.4.1) — supervisor gates over delegation.
 *
 * A per-workspace policy controls whether (and when) the agent is
 * allowed to spawn child agents:
 *
 *   auto                   — spawn freely (default)
 *   ask-before-spawn       — confirm before any top-level spawn
 *   ask-before-write-child — confirm before a top-level write/shell child
 *   no-children            — never spawn (any depth)
 *
 * Gates only prompt at the top level (`depth === 0`). Once the user has
 * approved a fan-out, the grandchildren it spawns run without re-asking
 * — supervision is about the operation, not every nested step.
 * `no-children` is absolute and denies at every depth.
 *
 * Pure module (no I/O) so it unit-tests cleanly; the interactive prompt
 * + headless fail-closed handling lives in the spawn path.
 */

import type { AccessMode } from "./roles.js";

export type DelegationPolicy = "auto" | "ask-before-spawn" | "ask-before-write-child" | "no-children";

export const DELEGATION_POLICIES: readonly DelegationPolicy[] = [
  "auto",
  "ask-before-spawn",
  "ask-before-write-child",
  "no-children",
];

export function isDelegationPolicy(v: unknown): v is DelegationPolicy {
  return typeof v === "string" && (DELEGATION_POLICIES as readonly string[]).includes(v);
}

export function resolveDelegationPolicy(prefs: { delegationPolicy?: DelegationPolicy }): DelegationPolicy {
  return prefs.delegationPolicy && isDelegationPolicy(prefs.delegationPolicy) ? prefs.delegationPolicy : "auto";
}

export type DelegationGate = "allow" | "deny" | "ask";

/**
 * Decide whether a spawn is allowed, denied, or needs confirmation.
 * `childAccess` is the resolved access of the child being spawned;
 * `depth` is the parent's spawn-chain depth (0 = chat root).
 */
export function evaluateDelegationGate(input: {
  policy: DelegationPolicy;
  childAccess: AccessMode;
  depth: number;
}): DelegationGate {
  const { policy, childAccess, depth } = input;
  if (policy === "no-children") return "deny";
  if (policy === "auto") return "allow";
  // ask-* policies only gate the top-level spawn; nested spawns inside an
  // already-approved operation run freely.
  if (depth > 0) return "allow";
  if (policy === "ask-before-spawn") return "ask";
  // ask-before-write-child: only write/shell children need approval.
  if (policy === "ask-before-write-child") {
    return childAccess === "write" || childAccess === "shell" ? "ask" : "allow";
  }
  return "allow";
}
