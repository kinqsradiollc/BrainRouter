/**
 * Pure helpers for the Projects screen — a "project" is a workspace (a repo/dir
 * the host serves). The transport exposes them via `workspaceRecents()` (the list)
 * and `workspaceSessions(root)` (a project's chat sessions). These map roots to a
 * render-ready row model.
 */
export interface ProjectRow {
  root: string;
  name: string;
  current: boolean;
}

/** The display name of a project — the last path segment of its root. */
export function projectName(root: string): string {
  const parts = (root ?? '').split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '(untitled)';
}

/** Dedupe the recents into render-ready rows, flagging the active project. */
export function projectRows(recents: string[], current: string | null): ProjectRow[] {
  const seen = new Set<string>();
  const out: ProjectRow[] = [];
  for (const root of recents ?? []) {
    if (!root || seen.has(root)) continue;
    seen.add(root);
    out.push({ root, name: projectName(root), current: root === current });
  }
  return out;
}
