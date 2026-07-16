/**
 * K-CLI — local→server thread id mapping. The server assigns its own thread id
 * (`ct_…`) on create, so re-pushing the SAME local session must not spawn a new
 * thread every time. We persist, per workspace, a small json that remembers
 * which server thread a given local `sessionKey` was last synced to; a re-push
 * then REPLACEs that thread's messages instead of duplicating it.
 *
 * The store is additive and self-contained — its own file under the CLI state
 * dir, keyed by sessionKey — so it never touches the local transcript store or
 * any unrelated session meta. The merge is a pure function (unit-tested); the
 * fs read/write are thin wrappers around it.
 */
import fs from 'node:fs';
import { getStateFile } from '@kinqs/brainrouter-core/storage';

const MAPPING_FILE = 'chat-sync-threads.json';
const MAPPING_VERSION = 1 as const;

/** One local session's link to the server thread it last synced to. */
export interface ChatSyncThreadLink {
  /** Server thread id (`ct_…`). */
  threadId: string;
  /** ISO timestamp of the last successful push. */
  syncedAt: string;
  /** Message count of the last push (for a friendly status line). */
  messageCount: number;
}

export interface ChatSyncMapping {
  version: typeof MAPPING_VERSION;
  /** Keyed by local sessionKey. */
  threads: Record<string, ChatSyncThreadLink>;
}

export function emptyMapping(): ChatSyncMapping {
  return { version: MAPPING_VERSION, threads: {} };
}

/** Look up the server thread a local session was last synced to, if any. */
export function getThreadLink(mapping: ChatSyncMapping, sessionKey: string): ChatSyncThreadLink | undefined {
  return mapping.threads[sessionKey];
}

/**
 * Pure, immutable upsert of one session→thread link. Returns a NEW mapping so
 * callers never mutate the value they read (and tests can assert on both).
 */
export function upsertThreadLink(
  mapping: ChatSyncMapping,
  sessionKey: string,
  link: ChatSyncThreadLink,
): ChatSyncMapping {
  return {
    version: MAPPING_VERSION,
    threads: { ...mapping.threads, [sessionKey]: link },
  };
}

/** Absolute path to this workspace's mapping file (under the CLI state dir). */
export function chatSyncMappingPath(workspaceRoot: string): string {
  return getStateFile(workspaceRoot, MAPPING_FILE);
}

/**
 * Read the mapping from disk. Tolerant: a missing, empty, malformed, or
 * wrong-shaped file yields an empty mapping rather than throwing, so a corrupt
 * cache can never block a push (the worst case is a duplicate thread).
 */
export function loadIdMapping(filePath: string): ChatSyncMapping {
  try {
    if (!fs.existsSync(filePath)) return emptyMapping();
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    return normalizeMapping(parsed);
  } catch {
    return emptyMapping();
  }
}

export function saveIdMapping(filePath: string, mapping: ChatSyncMapping): void {
  fs.writeFileSync(filePath, `${JSON.stringify(mapping, null, 2)}\n`, 'utf8');
}

/** Coerce arbitrary parsed json into a well-formed mapping, dropping junk rows. */
function normalizeMapping(raw: unknown): ChatSyncMapping {
  const out = emptyMapping();
  if (!raw || typeof raw !== 'object') return out;
  const threads = (raw as { threads?: unknown }).threads;
  if (!threads || typeof threads !== 'object') return out;
  for (const [sessionKey, value] of Object.entries(threads as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    if (typeof v.threadId !== 'string' || !v.threadId) continue;
    out.threads[sessionKey] = {
      threadId: v.threadId,
      syncedAt: typeof v.syncedAt === 'string' ? v.syncedAt : '',
      messageCount: typeof v.messageCount === 'number' ? v.messageCount : 0,
    };
  }
  return out;
}
