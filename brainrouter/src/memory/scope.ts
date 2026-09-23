/**
 * Where a recalled record came from, relative to the caller — and the order
 * that follows from it.
 *
 * PREFER, never hide. A plain user-wide search lets a note written in a
 * personal session outrank the repository the question is about, and injects
 * it as authoritative context into a codebase session. Filtering it out
 * entirely would also lose the cross-repo lesson that is occasionally exactly
 * what you want. Ordering it last, and marking where it came from, loses
 * neither.
 *
 * A workspace can have MORE THAN ONE identity. Chat turns are tagged with the
 * folder-path hash, while an ingested repository is tagged with the hash of its
 * git remote (ADR-015), so one checkout's memories arrive under two tags.
 * Treating only one of them as "here" labels the repo's own ingested files as
 * another workspace's — which is why the caller passes every identity it has.
 */

export type ScopeMatch = "session" | "workspace" | "untagged" | "other-workspace";

export interface CallerScope {
  /** The caller's session. Records captured in it rank first. */
  sessionKey?: string;
  /** Every identity of the caller's workspace — folder hash, repo hash, … */
  workspaceTags?: readonly string[];
  /** A single identity, for callers that only know one. Merged with the above. */
  workspaceTag?: string;
}

/** The two shapes a hit arrives in: FTS rows are snake_case, records camelCase. */
function provenanceOf(hit: unknown): { workspaceTag?: string | null; sessionKey?: string | null } {
  const row = (hit ?? {}) as Record<string, unknown>;
  const pick = (a: string, b: string): string | null | undefined => {
    const value = row[a] ?? row[b];
    return typeof value === "string" || value === null ? value : undefined;
  };
  return { workspaceTag: pick("workspaceTag", "workspace_tag"), sessionKey: pick("sessionKey", "session_key") };
}

/** The caller's workspace identities as one set; empty when it named none. */
export function callerWorkspaceTags(scope: CallerScope): Set<string> {
  const tags = new Set<string>();
  for (const tag of [...(scope.workspaceTags ?? []), scope.workspaceTag]) {
    const trimmed = typeof tag === "string" ? tag.trim() : "";
    if (trimmed) tags.add(trimmed);
  }
  return tags;
}

export function scopeMatchOf(hit: unknown, scope: CallerScope): ScopeMatch {
  const { workspaceTag, sessionKey } = provenanceOf(hit);
  if (scope.sessionKey && sessionKey === scope.sessionKey) return "session";
  if (workspaceTag && callerWorkspaceTags(scope).has(workspaceTag)) return "workspace";
  // A record with no workspace predates tagging (or was captured without a
  // workspace); it belongs to everywhere, so it sits above another repo's.
  if (!workspaceTag) return "untagged";
  return "other-workspace";
}

const SCOPE_ORDER: Record<ScopeMatch, number> = {
  session: 0, workspace: 1, untagged: 2, "other-workspace": 3,
};

export function preferCallerScope<T>(
  hits: readonly T[],
  scope: CallerScope,
): Array<T & { scopeMatch: ScopeMatch }> {
  return hits
    .map((hit) => ({ ...hit, scopeMatch: scopeMatchOf(hit, scope) }))
    // Stable within a rank: the search's own relevance order is preserved.
    .sort((a, b) => SCOPE_ORDER[a.scopeMatch] - SCOPE_ORDER[b.scopeMatch]);
}
