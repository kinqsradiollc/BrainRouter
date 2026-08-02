/**
 * ADR-027 D7 (P5-1) — the session's EXECUTION ROOT, decoupled from the window's
 * workspace.
 *
 * Today a session runs wherever its window points. That makes working in a git
 * worktree an all-or-nothing move: switch the window and every session follows,
 * including the ones that were mid-task somewhere else.
 *
 * Separating the two is mostly bookkeeping, except for one thing that is not:
 * a session's root is the base for every path authorization decision it makes.
 * Get this wrong and a path check passes against a root the session no longer
 * runs in. So the rules here are deliberately strict:
 *
 *  - The execution root is ALWAYS absolute and normalized. A relative root
 *    resolves against the process cwd, which no session controls.
 *  - Rebasing a session is refused while it holds work in flight. A root that
 *    changes underneath a running tool turns an authorized path into an
 *    unauthorized one halfway through.
 *  - The window workspace is retained separately, never overwritten, so
 *    "where did this session come from" survives a rebase.
 */
import path from 'node:path';

export interface SessionExecutionRoot {
  /** The workspace the window is pointed at. Never mutated by a rebase. */
  windowWorkspace: string;
  /** Where this session's tools actually run. Absolute, normalized. */
  executionRoot: string;
  /** Set when the root is a git worktree of the window workspace. */
  worktreeOf?: string;
}

export class ExecutionRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionRootError';
  }
}

function requireAbsolute(label: string, value: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ExecutionRootError(`${label} must be a non-empty path.`);
  }
  if (!path.isAbsolute(value)) {
    // A relative root would resolve against process.cwd(), which belongs to
    // whoever launched the app rather than to this session. Every path
    // authorization built on it would be answering the wrong question.
    throw new ExecutionRootError(
      `${label} must be absolute, received "${value}". A relative execution root ` +
      'resolves against the process working directory, which no session controls.',
    );
  }
  return path.normalize(value);
}

/** A session that runs where its window points — the default. */
export function windowRootedSession(windowWorkspace: string): SessionExecutionRoot {
  const root = requireAbsolute('windowWorkspace', windowWorkspace);
  return { windowWorkspace: root, executionRoot: root };
}

/**
 * Point a session at a worktree without moving its window.
 *
 * `worktreeOf` records the origin so the UI can say "this session runs in a
 * worktree of X" rather than showing a bare path with no explanation.
 */
export function worktreeRootedSession(input: {
  windowWorkspace: string;
  worktreePath: string;
}): SessionExecutionRoot {
  const windowWorkspace = requireAbsolute('windowWorkspace', input.windowWorkspace);
  const executionRoot = requireAbsolute('worktreePath', input.worktreePath);
  if (executionRoot === windowWorkspace) {
    // Not an error — it just is not a worktree, and labelling it as one would
    // make the UI claim an isolation that does not exist.
    return { windowWorkspace, executionRoot };
  }
  return { windowWorkspace, executionRoot, worktreeOf: windowWorkspace };
}

/**
 * Move a window to a different workspace WITHOUT dragging its sessions along.
 *
 * This is the whole point of the decoupling: a session pinned to a worktree
 * keeps running there when the window moves on.
 */
export function retargetWindow(
  session: SessionExecutionRoot,
  nextWindowWorkspace: string,
): SessionExecutionRoot {
  const nextWindow = requireAbsolute('nextWindowWorkspace', nextWindowWorkspace);
  const pinned = session.executionRoot !== session.windowWorkspace;
  if (pinned) return { ...session, windowWorkspace: nextWindow };
  // An unpinned session follows its window, which is the behaviour that
  // existed before this module and remains the default.
  return { windowWorkspace: nextWindow, executionRoot: nextWindow };
}

/**
 * Change where a session executes.
 *
 * Refused while work is in flight. A root that changes underneath a running
 * tool means a path authorized against the old root is applied against the new
 * one — the check passed, but not for the directory being written.
 */
export function rebaseSession(input: {
  session: SessionExecutionRoot;
  nextExecutionRoot: string;
  inFlightToolCalls: number;
}): SessionExecutionRoot {
  if (!Number.isInteger(input.inFlightToolCalls) || input.inFlightToolCalls < 0) {
    throw new ExecutionRootError(
      'inFlightToolCalls must be a non-negative integer; an unknown count cannot ' +
      'be assumed to be zero when the consequence is a mid-flight root change.',
    );
  }
  if (input.inFlightToolCalls > 0) {
    throw new ExecutionRootError(
      `Refusing to move the execution root while ${input.inFlightToolCalls} tool ` +
      'call(s) are in flight. A path authorized against the old root would be ' +
      'applied against the new one.',
    );
  }
  const next = requireAbsolute('nextExecutionRoot', input.nextExecutionRoot);
  const worktree = next !== input.session.windowWorkspace;
  return {
    windowWorkspace: input.session.windowWorkspace,
    executionRoot: next,
    ...(worktree ? { worktreeOf: input.session.windowWorkspace } : {}),
  };
}

/** True when this session runs somewhere other than its window's workspace. */
export function isPinnedAwayFromWindow(session: SessionExecutionRoot): boolean {
  return session.executionRoot !== session.windowWorkspace;
}

/**
 * The root every path check for this session must resolve against.
 *
 * A single accessor exists so no caller reaches for `windowWorkspace` when it
 * means "where does this session run" — the two were the same value until this
 * module, and that is exactly the habit that would survive the change.
 */
export function authorizationRoot(session: SessionExecutionRoot): string {
  return session.executionRoot;
}

/** Human-readable description for the UI. */
export function describeExecutionRoot(session: SessionExecutionRoot): string {
  if (!isPinnedAwayFromWindow(session)) return session.executionRoot;
  return `${session.executionRoot} (worktree of ${session.worktreeOf ?? session.windowWorkspace})`;
}
