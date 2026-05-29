import fs from 'node:fs';
import { getSessionStateFile } from './cliState.js';

/**
 * 0.4.x-3b — file-restore undo log for `/rewind --files`.
 *
 * Each time the agent first mutates a workspace file within a turn, we record
 * the file's PRIOR content tagged with the turn's user-ordinal (the count of
 * user transcript entries at that point — the same key the `/rewind` timeline
 * uses). To restore the workspace to the end of turn N, we revert every file
 * mutated in turns > N to its earliest-post-N prior content. `null` prior
 * content means the file didn't exist (created that turn) → restore = delete.
 *
 * Append-only JSONL at `<session-state>/file-mutations.jsonl`. The restore
 * planner is pure (unit-tested); the command handler always previews +
 * confirms before touching the disk.
 */

const LOG_FILE = 'file-mutations.jsonl';

export interface FileMutationRecord {
  /** User-turn ordinal at mutation time (1-based; aligns with RewindTurn.absoluteTurn). */
  turn: number;
  /** Workspace-relative path. */
  path: string;
  /** File content before the turn's first mutation, or null if it didn't exist. */
  priorContent: string | null;
}

export interface RestoreAction {
  path: string;
  action: 'write' | 'delete';
  /** Present when action === 'write'. */
  content?: string;
}

/**
 * Pure: plan the restore to the END of turn `turnN`. For each file mutated in
 * a turn > N, restore it to the prior content of its EARLIEST post-N mutation
 * (its state at the end of turn N). Files only touched in turns ≤ N are left
 * as-is (their current content already reflects end-of-turn-N).
 */
export function planRestore(records: FileMutationRecord[], turnN: number): RestoreAction[] {
  const earliestPostN = new Map<string, FileMutationRecord>();
  for (const r of records) {
    if (r.turn <= turnN) continue;
    const existing = earliestPostN.get(r.path);
    if (!existing || r.turn < existing.turn) earliestPostN.set(r.path, r);
  }
  return [...earliestPostN.values()]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((r) =>
      r.priorContent === null
        ? { path: r.path, action: 'delete' as const }
        : { path: r.path, action: 'write' as const, content: r.priorContent },
    );
}

export function recordFileMutation(workspaceRoot: string, sessionKey: string, rec: FileMutationRecord): void {
  try {
    const file = getSessionStateFile(workspaceRoot, sessionKey, LOG_FILE);
    fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
  } catch {
    // Snapshotting must never break a tool call.
  }
}

export function readFileMutations(workspaceRoot: string, sessionKey: string): FileMutationRecord[] {
  try {
    const file = getSessionStateFile(workspaceRoot, sessionKey, LOG_FILE);
    const raw = fs.readFileSync(file, 'utf8');
    const out: FileMutationRecord[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (typeof r?.turn === 'number' && typeof r?.path === 'string') out.push(r as FileMutationRecord);
      } catch {
        /* tolerate a bad line */
      }
    }
    return out;
  } catch {
    return [];
  }
}
