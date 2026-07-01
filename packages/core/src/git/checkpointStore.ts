/**
 * PER-TURN GIT CHECKPOINT STORE (§5.3) — session-scoped persistence over the pure
 * `checkpoint.ts` capture/restore core. One checkpoint directory per turn under
 * the session's state dir, so the desktop transcript can offer "roll back to this
 * turn" with real git-state rollback (not just transcript rewind).
 *
 *   <sessionStateDir>/git-checkpoints/turn-<index>/{working.patch, untracked/, head.bundle, metadata.json}
 *
 * Turn index follows the same convention the desktop already uses for rewind: the
 * transcript entry index. Pure fs over the storage helpers + the checkpoint core.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getSessionStateDir } from '../storage/store.js';
import {
  createGitCheckpoint,
  restoreGitCheckpoint,
  type GitCheckpoint,
  type RestoreResult,
} from './checkpoint.js';

export interface TurnCheckpoint extends GitCheckpoint {
  turnIndex: number;
}

function checkpointsRoot(workspaceRoot: string, sessionKey: string): string {
  return path.join(getSessionStateDir(workspaceRoot, sessionKey), 'git-checkpoints');
}

function turnDir(workspaceRoot: string, sessionKey: string, turnIndex: number): string {
  return path.join(checkpointsRoot(workspaceRoot, sessionKey), `turn-${turnIndex}`);
}

/**
 * Capture a checkpoint for `turnIndex` (overwriting any stale one). Returns null
 * when the workspace isn't a git repo (no-op — the desktop simply won't offer
 * git rollback for that session). Best-effort: a capture failure never blocks a
 * turn, so callers ignore null.
 */
export function recordTurnCheckpoint(
  workspaceRoot: string,
  sessionKey: string,
  repoRoot: string,
  turnIndex: number,
): TurnCheckpoint | null {
  const dir = turnDir(workspaceRoot, sessionKey, turnIndex);
  fs.rmSync(dir, { recursive: true, force: true });
  const cp = createGitCheckpoint(repoRoot, dir);
  return cp ? { ...cp, turnIndex } : null;
}

/** Read the stored checkpoint record for a turn, or null if none/corrupt. */
export function readTurnCheckpoint(
  workspaceRoot: string,
  sessionKey: string,
  turnIndex: number,
): TurnCheckpoint | null {
  const metaPath = path.join(turnDir(workspaceRoot, sessionKey, turnIndex), 'metadata.json');
  if (!fs.existsSync(metaPath)) return null;
  try {
    const cp = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as GitCheckpoint;
    if (!cp || typeof cp.headSha !== 'string') return null;
    return { ...cp, turnIndex };
  } catch {
    return null;
  }
}

/** Turn indices that have a recorded checkpoint, ascending. */
export function listTurnCheckpoints(workspaceRoot: string, sessionKey: string): number[] {
  const root = checkpointsRoot(workspaceRoot, sessionKey);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .map((name) => /^turn-(\d+)$/.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
}

/**
 * Roll the repo back to the git state captured at `turnIndex`. Fail-closed via
 * the restore core; returns a clear error when no checkpoint exists for the turn.
 */
export function rollbackToTurnCheckpoint(
  workspaceRoot: string,
  sessionKey: string,
  repoRoot: string,
  turnIndex: number,
): RestoreResult {
  const cp = readTurnCheckpoint(workspaceRoot, sessionKey, turnIndex);
  if (!cp) return { ok: false, error: `no git checkpoint recorded for turn ${turnIndex}` };
  return restoreGitCheckpoint(repoRoot, cp);
}

/** Drop checkpoints for turns AFTER `turnIndex` (e.g. once a rollback is committed to). */
export function pruneTurnCheckpointsAfter(
  workspaceRoot: string,
  sessionKey: string,
  turnIndex: number,
): void {
  for (const idx of listTurnCheckpoints(workspaceRoot, sessionKey)) {
    if (idx > turnIndex) fs.rmSync(turnDir(workspaceRoot, sessionKey, idx), { recursive: true, force: true });
  }
}
