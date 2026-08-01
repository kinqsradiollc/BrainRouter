/**
 * ADR-027 D7 (P5-1) — the session execution root.
 *
 * D7: "A session gains an execution root distinct from the window's workspace.
 * The agent can work in a worktree while the session, chat, and project list
 * stay put — no new window, no new project entry. Worktrees become a property
 * of the SESSION, not a new workspace."
 *
 * Today a worktree is a workspace, so entering one means a new window, a new
 * project entry, and a new session — the conversation is left behind exactly
 * when its context is most useful. Splitting the two makes "work on this in a
 * worktree" a property of the current session instead of a relocation.
 *
 * The safety rule that makes the split viable: the execution root is where
 * WORK happens, and every path the agent touches must resolve inside it. A
 * session whose root is a worktree but whose writes land in the main checkout
 * is worse than no worktree at all — it looks isolated and is not, so the
 * isolation gets trusted.
 */

import path from 'node:path';

export interface ExecutionRoot {
  /** Absolute path work happens in. A worktree, or the workspace itself. */
  path: string;
  /** How this root came to be, for display and for cleanup decisions. */
  kind: 'workspace' | 'worktree';
  /** Branch checked out here, when known. */
  branch?: string;
  /**
   * Whether removing the session should remove this root. True only for
   * worktrees the session itself created — never for the workspace, and never
   * for a worktree the human made and pointed the session at.
   */
  ownedBySession: boolean;
}

export interface SessionRootBinding {
  sessionId: string;
  /** The window's workspace. Unchanged by any of this. */
  workspaceRoot: string;
  /** Where this session's work happens. Defaults to the workspace. */
  executionRoot: ExecutionRoot;
}

/** A session with no worktree: execution root IS the workspace. */
export function defaultBinding(sessionId: string, workspaceRoot: string): SessionRootBinding {
  return {
    sessionId,
    workspaceRoot,
    executionRoot: { path: workspaceRoot, kind: 'workspace', ownedBySession: false },
  };
}

export class ExecutionRootError extends Error {
  constructor(message: string) { super(message); this.name = 'ExecutionRootError'; }
}

/**
 * Point a session at a worktree without moving the session.
 *
 * The workspace root is preserved unchanged — that is the entire point of D7.
 * The chat, the project entry, and the window all continue to belong to the
 * workspace; only where commands run changes.
 */
export function bindWorktree(
  binding: SessionRootBinding,
  worktree: { path: string; branch?: string; createdBySession: boolean },
): SessionRootBinding {
  if (!path.isAbsolute(worktree.path)) {
    throw new ExecutionRootError(`Worktree path must be absolute: ${worktree.path}`);
  }
  return {
    ...binding,
    // Deliberately NOT touching workspaceRoot.
    executionRoot: {
      path: path.normalize(worktree.path),
      kind: 'worktree',
      ...(worktree.branch ? { branch: worktree.branch } : {}),
      ownedBySession: worktree.createdBySession,
    },
  };
}

/** Return a session to its workspace. The worktree may still exist on disk. */
export function unbindWorktree(binding: SessionRootBinding): SessionRootBinding {
  return defaultBinding(binding.sessionId, binding.workspaceRoot);
}

/**
 * Whether a path is inside the session's execution root.
 *
 * The check every write must pass. Compares resolved, normalised paths with a
 * separator guard, so `/repo-backup` is not treated as inside `/repo` — the
 * classic prefix bug, and one that grants exactly the access the boundary
 * exists to deny.
 */
export function isWithinExecutionRoot(binding: SessionRootBinding, target: string): boolean {
  const root = path.resolve(binding.executionRoot.path);
  const resolved = path.resolve(root, target);
  return resolved === root || resolved.startsWith(root + path.sep);
}

/**
 * Resolve a path for execution, refusing anything outside the root.
 *
 * Throws rather than clamping. Silently rewriting a path to sit inside the root
 * would make a command that meant one file operate on another — a worse
 * outcome than refusing, and much harder to notice.
 */
export function resolveForExecution(binding: SessionRootBinding, target: string): string {
  const resolved = path.resolve(binding.executionRoot.path, target);
  if (!isWithinExecutionRoot(binding, target)) {
    throw new ExecutionRootError(
      `Path escapes this session's execution root: ${resolved} is outside ${binding.executionRoot.path}`,
    );
  }
  return resolved;
}

export interface RootCleanupPlan {
  /** Worktree path to remove, or null when nothing should be. */
  removeWorktree: string | null;
  reason: string;
}

/**
 * What ending a session should clean up.
 *
 * Only a worktree the SESSION created is removed. A worktree the human made and
 * pointed a session at is theirs — removing it would delete work that outlives
 * the conversation, and the session has no way to know what else depends on it.
 */
export function planRootCleanup(binding: SessionRootBinding): RootCleanupPlan {
  const root = binding.executionRoot;
  if (root.kind !== 'worktree') {
    return { removeWorktree: null, reason: 'Session ran in the workspace; nothing to remove.' };
  }
  if (!root.ownedBySession) {
    return { removeWorktree: null, reason: 'The worktree pre-existed this session and is not ours to remove.' };
  }
  return { removeWorktree: root.path, reason: 'Removing the worktree this session created.' };
}

/** Short description of where a session is working, for the UI. */
export function describeExecutionRoot(binding: SessionRootBinding): string {
  const root = binding.executionRoot;
  if (root.kind === 'workspace') return 'Working in the project workspace.';
  const branch = root.branch ? ` on ${root.branch}` : '';
  return `Working in a worktree${branch} — the project and this chat stay where they are.`;
}
