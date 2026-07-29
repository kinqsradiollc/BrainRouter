/**
 * Host-neutral worktree isolation contracts.
 *
 * Extracted verbatim from worktreeIsolation.ts. These records describe
 * authority, lifecycle results, and recovery state without performing I/O.
 */
export type ChildWorkspaceIsolationMode = 'off' | 'auto' | 'git-worktree';

export interface ChildWorktreeIsolation {
  kind: 'git-worktree';
  sourceRoot: string;
  worktreeRoot: string;
}

export interface ChildWorkspaceResolution {
  workspaceRoot: string;
  launchCwd: string;
  isolated: boolean;
  isolation?: ChildWorktreeIsolation;
  notice?: string;
}

export interface RemoveChildWorktreeOptions {
  /**
   * Cap on the human-readable preview diff. The FULL recovery patch written to
   * `patchFile` is never capped, so no work is lost to truncation. Default 4000.
   */
  maxDiffChars?: number;
  /**
   * CODEX-WORKTREE-MERGEBACK — when true, the child's changes are git-applied
   * back onto the parent working tree (used on a child's CLEAN completion). The
   * apply is gated by `git apply --check` first, so a patch that doesn't apply
   * cleanly leaves the parent tree untouched (no conflict markers) — the work is
   * still recoverable from `patchFile`. Defaults to false (capture-only).
   */
  applyBack?: boolean;
  /**
   * Absolute path to persist the full (uncapped, binary-safe) recovery patch.
   * Lets the parent re-apply the child's work with `git apply <patchFile>` even
   * after the throwaway worktree is gone. Required for `applyBack` to do anything.
   */
  patchFile?: string;
}

export interface RemoveChildWorktreeResult {
  ok: boolean;
  /** Capped, human-readable preview of the child's changes. */
  diff?: string;
  /** Number of files the child changed in its worktree. */
  changedFiles?: number;
  /** Where the full recovery patch was written (iff changes + a writable `patchFile`). */
  patchPath?: string;
  /** True when `applyBack` was requested and the patch cleanly applied to the parent tree. */
  applied?: boolean;
  /** Why an `applyBack` attempt was skipped/failed — the patch is still at `patchPath` for manual `git apply`. */
  applyError?: string;
  /** Worktree-removal notice (force-removal fallback). */
  notice?: string;
  /** Recovery ref created when the worktree HEAD contained commits not reachable from the parent. */
  recoveryRef?: string;
}

/** What `captureWorktreeChanges` found (and persisted) in a working tree. */
export interface WorktreeChangeCapture {
  /** Number of files changed vs the requested base (0 = nothing captured). */
  changedFiles: number;
  /** Where the FULL binary-safe patch landed (iff changes + writable `patchFile`). */
  patchPath?: string;
  /** Uncapped plain-text diff body (callers cap for display). */
  preview?: string;
}

/** Why a clean child's changes are held instead of merged back. */
export type WorktreeHoldReason = 'review' | 'fanout';
