/**
 * ADR-042 D6 — one writing session per worktree, enforced by a registry not by
 * vibes. A small file-backed map `worktree path → { sessionKey, updatedAt }`
 * under the per-workspace CLI state root (sibling of the runtime-instance
 * store). Ownership is recorded on enter/create and cleared on done/session-end;
 * a record whose owner has not refreshed within the staleness window is treated
 * as unowned (the owning session died without cleanup). This is the enforcement
 * the passive worktree-awareness prompt line never had.
 */
import fs from 'node:fs';
import path from 'node:path';

import { getStateDir } from '../../storage/store.js';

export interface WorktreeOwner {
  sessionKey: string;
  /** Epoch ms of the last enter/create by the owner — the liveness heartbeat. */
  updatedAt: number;
}
type OwnerMap = Record<string, WorktreeOwner>;

/** Owner records older than this without a refresh are considered dead. */
export const OWNER_STALE_MS = 15 * 60_000;

function ownersFile(workspaceRoot: string): string {
  return path.join(getStateDir(workspaceRoot), 'runtime', 'worktree-owners.json');
}
function readOwners(file: string): OwnerMap {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as OwnerMap) : {};
  } catch {
    return {};
  }
}
function writeOwners(file: string, map: OwnerMap): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(map, null, 2));
  } catch {
    /* best-effort — awareness/enforcement must not break a turn */
  }
}
const key = (p: string) => path.resolve(p);

// --- Pure core (file + now injected) — unit-testable without global state. ---

export function recordWorktreeOwnerIn(file: string, worktreePath: string, sessionKey: string, now: number): void {
  const map = readOwners(file);
  map[key(worktreePath)] = { sessionKey, updatedAt: now };
  writeOwners(file, map);
}

export function clearWorktreeOwnerIn(file: string, worktreePath: string): void {
  const map = readOwners(file);
  if (Object.prototype.hasOwnProperty.call(map, key(worktreePath))) {
    delete map[key(worktreePath)];
    writeOwners(file, map);
  }
}

/**
 * The LIVE FOREIGN owner of `worktreePath`, or null when it is unowned, owned by
 * `selfSessionKey`, or owned by a session whose record is stale (dead).
 */
export function liveForeignOwnerIn(
  file: string,
  worktreePath: string,
  selfSessionKey: string,
  now: number,
  staleMs = OWNER_STALE_MS,
): string | null {
  const rec = readOwners(file)[key(worktreePath)];
  if (!rec) return null;
  if (rec.sessionKey === selfSessionKey) return null;
  if (now - rec.updatedAt > staleMs) return null;
  return rec.sessionKey;
}

export function readOwnersIn(file: string): OwnerMap {
  return readOwners(file);
}

// --- Workspace-scoped wrappers (production; use the real state dir + clock). ---

export function recordWorktreeOwner(workspaceRoot: string, worktreePath: string, sessionKey: string): void {
  recordWorktreeOwnerIn(ownersFile(workspaceRoot), worktreePath, sessionKey, Date.now());
}
export function clearWorktreeOwner(workspaceRoot: string, worktreePath: string): void {
  clearWorktreeOwnerIn(ownersFile(workspaceRoot), worktreePath);
}
export function liveForeignOwner(workspaceRoot: string, worktreePath: string, selfSessionKey: string): string | null {
  return liveForeignOwnerIn(ownersFile(workspaceRoot), worktreePath, selfSessionKey, Date.now());
}
/** All owner records for the workspace — used to enrich the feature map (D5). */
export function listWorktreeOwners(workspaceRoot: string): OwnerMap {
  return readOwnersIn(ownersFile(workspaceRoot));
}
