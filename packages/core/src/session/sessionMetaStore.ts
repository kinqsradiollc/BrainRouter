/**
 * DESK-6m — per-session UI metadata (title, pin, archive, completion, group),
 * persisted alongside the other CLI state in `sessionMeta.json` keyed by
 * sessionKey. The transcript itself is the source of truth for a session's
 * CONTENT; this store holds the lightweight organizational state the desktop's
 * per-chat context menu (Pin / Mark completed / Rename / Move to group /
 * Archive) reads and writes. Absent entries mean "default" (active, ungrouped).
 */
import { getStateFile, readJsonFile, writeJsonFile } from '../storage/store.js';

export type SessionStatus = 'active' | 'completed';

export interface SessionMeta {
  /** User-given title, overrides the first-user-message in the sidebar. */
  title?: string;
  pinned?: boolean;
  archived?: boolean;
  status?: SessionStatus;
  /** Group/folder name the session is filed under (null/absent = ungrouped). */
  group?: string | null;
  /** DESK-6u — if this session was forked, the parent session key it branched
   *  from. Lets the desktop show a fork icon + a "Forked from conversation"
   *  link back to the original. */
  forkedFrom?: string;
}

type MetaStore = Record<string, SessionMeta>;

function metaFile(workspaceRoot: string): string {
  return getStateFile(workspaceRoot, 'sessionMeta.json');
}

export function readSessionMetaAll(workspaceRoot: string): MetaStore {
  return readJsonFile<MetaStore>(metaFile(workspaceRoot), {});
}

export function getSessionMeta(workspaceRoot: string, sessionKey: string): SessionMeta {
  return readSessionMetaAll(workspaceRoot)[sessionKey] ?? {};
}

/** Empty/false/null fields are pruned so the store stays minimal; an entry that
 *  becomes entirely default is removed. Returns the resulting (possibly {}) meta. */
export function setSessionMeta(workspaceRoot: string, sessionKey: string, patch: Partial<SessionMeta>): SessionMeta {
  const all = readSessionMetaAll(workspaceRoot);
  const next: SessionMeta = { ...(all[sessionKey] ?? {}), ...patch };
  for (const k of Object.keys(next) as Array<keyof SessionMeta>) {
    const v = next[k];
    if (v == null || v === false || v === '' || v === 'active') delete next[k];
  }
  if (Object.keys(next).length === 0) delete all[sessionKey];
  else all[sessionKey] = next;
  writeJsonFile(metaFile(workspaceRoot), all);
  return all[sessionKey] ?? {};
}

export function removeSessionMeta(workspaceRoot: string, sessionKey: string): void {
  const all = readSessionMetaAll(workspaceRoot);
  if (all[sessionKey]) {
    delete all[sessionKey];
    writeJsonFile(metaFile(workspaceRoot), all);
  }
}

/** Distinct, sorted group names currently in use (for the "Move to group" menu). */
export function listSessionGroups(workspaceRoot: string): string[] {
  const all = readSessionMetaAll(workspaceRoot);
  return [...new Set(Object.values(all).map((m) => m.group).filter((g): g is string => typeof g === 'string' && g.length > 0))].sort();
}
