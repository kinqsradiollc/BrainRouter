/**
 * ADR-052 P4.2 — one-shot "notify me when that session next goes idle".
 *
 * A session (the requester) can ask to be pinged ONCE when another local
 * session (the watched session) next finishes a turn. The subscription is
 * durable (survives a restart) and self-clearing: draining it on the watched
 * session's turn-completion returns the pending requesters and removes them, so
 * a second idle never re-fires. Machine-local, workspace-scoped.
 *
 * Pure store logic over a workspace state file — no delivery here; the caller
 * (turn finalization) delivers the notice via `sendLocalSessionMessage`.
 */
import { getStateFile, readJsonFile, writeJsonFile } from '../../storage/store.js';

interface IdleSubscription {
  /** The session to notify when `watched` goes idle. */
  requester: string;
  /** When the subscription was made (epoch ms), for observability. */
  at: number;
}

/** watched session key → its pending one-shot subscribers. */
interface IdleNotifyFile {
  byWatched: Record<string, IdleSubscription[]>;
}

const EMPTY: IdleNotifyFile = { byWatched: {} };
const FILE = 'idle-notify.json';

function read(workspaceRoot: string): IdleNotifyFile {
  const raw = readJsonFile<IdleNotifyFile>(getStateFile(workspaceRoot, FILE), EMPTY);
  return raw && typeof raw === 'object' && raw.byWatched ? raw : { byWatched: {} };
}

/**
 * Subscribe `requester` to be notified once when `watched` next goes idle.
 * Idempotent per (watched, requester); a self-subscription is ignored.
 */
export function subscribeIdleNotice(workspaceRoot: string, watched: string, requester: string, nowMs: number): boolean {
  const w = (watched ?? '').trim();
  const r = (requester ?? '').trim();
  if (!w || !r || w === r) return false;
  const store = read(workspaceRoot);
  const subs = store.byWatched[w] ?? (store.byWatched[w] = []);
  if (subs.some((s) => s.requester === r)) return true; // already subscribed
  subs.push({ requester: r, at: nowMs });
  writeJsonFile(getStateFile(workspaceRoot, FILE), store);
  return true;
}

/**
 * Take (and CLEAR) the pending subscribers for `watched` — call this when the
 * watched session goes idle. Returns the requester session keys to notify; a
 * second call returns none (one-shot).
 */
export function drainIdleNotices(workspaceRoot: string, watched: string): string[] {
  const w = (watched ?? '').trim();
  if (!w) return [];
  const store = read(workspaceRoot);
  const subs = store.byWatched[w];
  if (!subs || subs.length === 0) return [];
  delete store.byWatched[w];
  writeJsonFile(getStateFile(workspaceRoot, FILE), store);
  return subs.map((s) => s.requester);
}
