/**
 * ADR-015 P1c / D4 — the memory scope tag for a captured turn.
 *
 * Turn-capture is keyed to REPO identity when the session knows its git remote
 * (a `repoTag` — 16 hex chars, `hash(normalizedRemoteUrl)`, computed once in core
 * and carried by the client's git-info), so recall survives a moved/renamed folder
 * or a second clone. With no repo identity it falls back to the path hash, leaving
 * non-git workspaces exactly as they were.
 *
 * The repo-file ingest path (ingestRepo) already puts the repoTag in the one
 * `workspaceTag` slot; capture does the same through this helper, so a repo-scoped
 * write and a repo-scoped recall — the client sends the same repoTag — agree on
 * exactly one tag. The repoTag is a hash of a public remote URL (ADR-015 §security),
 * so honouring a client-supplied one is no more sensitive than the path hash it
 * replaces, and it only ever scopes the caller's own tenant-isolated memory.
 */
import { workspaceTagFromPath } from "@kinqs/brainrouter-types";

/**
 * Prefer the repo identity tag; fall back to the workspace path hash. Returns
 * `null` only when neither a repoTag nor a workspaceRoot is available (the same
 * NULL-tolerant, unscoped case recall already understands).
 */
export function repoScopedWorkspaceTag(
  repoTag: string | null | undefined,
  workspaceRoot: string | null | undefined,
): string | null {
  const tag = (repoTag ?? "").trim();
  if (tag) return tag;
  return workspaceTagFromPath(workspaceRoot ?? undefined);
}
