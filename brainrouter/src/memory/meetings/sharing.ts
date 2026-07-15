/**
 * Meetings sharing model (ADR-018 D8) — pure logic, no I/O.
 *
 * Four-level ladder: private < team < org < public. `private`/`team`/`org` are backend
 * visibility scopes; `public` additionally mints a revocable share token served (redacted,
 * summary-only) from an unauthenticated public route. Downgrading out of `public` must
 * revoke the token.
 */

import type { MeetingVisibility } from "./types.js";

export const MEETING_VISIBILITIES: readonly MeetingVisibility[] = [
  "private",
  "team",
  "org",
  "public",
] as const;

const RANK: Record<MeetingVisibility, number> = { private: 0, team: 1, org: 2, public: 3 };

export function isMeetingVisibility(value: unknown): value is MeetingVisibility {
  return typeof value === "string" && (MEETING_VISIBILITIES as readonly string[]).includes(value);
}

/** True when `to` is a strictly narrower scope than `from` (e.g. public → org). */
export function isScopeDowngrade(from: MeetingVisibility, to: MeetingVisibility): boolean {
  return RANK[to] < RANK[from];
}

export function isPublicScope(scope: MeetingVisibility): boolean {
  return scope === "public";
}

/** The `public` route exposes content beyond the account boundary — treat as outward-facing. */
export function isOutwardFacing(scope: MeetingVisibility): boolean {
  return scope === "public";
}

/**
 * Validate a scope + its required parameters. `team` requires a `teamId`; a non-team scope
 * must not carry one. Throws {@link MeetingScopeError} on violation.
 */
export function assertScopeParams(scope: MeetingVisibility, teamId?: string): void {
  if (!isMeetingVisibility(scope)) {
    throw new MeetingScopeError(`Unknown sharing scope "${String(scope)}".`);
  }
  if (scope === "team" && !teamId) {
    throw new MeetingScopeError("Team sharing requires a teamId.");
  }
  if (scope !== "team" && teamId) {
    throw new MeetingScopeError(`teamId is only valid for team scope, not "${scope}".`);
  }
}

/**
 * The backend `MemoryVisibility` value a scope maps to. `public` is stored as `org`
 * visibility (org members still read it in-app) *plus* a public share token — the token,
 * not the visibility column, is what grants anonymous read.
 */
export function scopeToBackendVisibility(
  scope: MeetingVisibility,
): "private" | "team" | "org" {
  return scope === "public" ? "org" : scope;
}

export class MeetingScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeetingScopeError";
  }
}
