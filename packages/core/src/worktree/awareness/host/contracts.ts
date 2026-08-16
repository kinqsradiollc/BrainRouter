export interface WorktreeAwarenessHost {
  /** `git worktree list --porcelain`, run in the given root. */
  listPorcelain(workspaceRoot: string): string;
  /**
   * Best-effort "does this worktree have uncommitted tracked changes?" — a
   * separate `git status` per worktree (porcelain worktree-list does not carry
   * it). Optional so awareness never hard-depends on it; returns false on any
   * error. ADR-042 D3 surfaces this in `worktree_list`.
   */
  isDirty?(worktreePath: string): boolean;
}
