/**
 * DESK-6m — per-session UI metadata (title, pin, archive, completion, group),
 * persisted alongside the other CLI state in `sessionMeta.json` keyed by
 * sessionKey. The transcript itself is the source of truth for a session's
 * CONTENT; this store holds the lightweight organizational state the desktop's
 * per-chat context menu (Pin / Mark completed / Rename / Move to group /
 * Archive) reads and writes. Absent entries mean "default" (active, ungrouped).
 * Every mutation holds one cross-process lock through read, precedence/CAS,
 * and durable replacement so concurrent CLI/Desktop hosts cannot lose rows.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getStateFile } from '../../storage/store.js';
import { writeFileAtomic } from '../../util/fs/atomicFile.js';
import {
  MAX_SESSION_TITLE,
  normalizeAgentTitle,
  normalizeExplicitSessionTitle,
  type SessionTitleSource,
} from '../sessionTitle.js';

export type SessionStatus = 'active' | 'completed';

export interface SessionMeta {
  /** User-given title, overrides the first-user-message in the sidebar. */
  title?: string;
  /** Missing on legacy rows means human-provided and is therefore protected. */
  titleSource?: SessionTitleSource;
  pinned?: boolean;
  archived?: boolean;
  status?: SessionStatus;
  /** Group/folder name the session is filed under (null/absent = ungrouped). */
  group?: string | null;
  /** DESK-6u — if this session was forked, the parent session key it branched
   *  from. Lets the desktop show a fork icon + a "Forked from conversation"
   *  link back to the original. */
  forkedFrom?: string;
  /** §session-pr — the git branch this session last ran a turn on (captured by
   *  the desktop on activity). Lets the sidebar match a session to its PR and
   *  show a live PR-status icon. */
  branch?: string;
}

type MetaStore = Record<string, SessionMeta>;

const SESSION_META_LOCK_TIMEOUT_MS = 3_000;
const SESSION_META_LOCK_RETRY_MS = 10;
const SESSION_META_INCOMPLETE_LOCK_GRACE_MS = 500;
const SESSION_META_MAX_STORE_BYTES = 8 * 1024 * 1024;
const SESSION_META_MAX_TEXT_BYTES = 4_096;
const SESSION_META_MAX_BRANCH_BYTES = 1_024;
const SESSION_META_MAX_SESSION_KEY_BYTES = 512;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

interface SessionMetaLockOwner {
  pid: number;
  token: string;
  acquiredAt: number;
}

interface SessionMetaWriteHooks {
  beforeWrite?: () => void;
}

let sessionMetaWriteHooks: SessionMetaWriteHooks | undefined;

/** Focused concurrency failure-injection seam; never configured by production. */
export function __setSessionMetaWriteHooksForTests(hooks: SessionMetaWriteHooks | undefined): void {
  sessionMetaWriteHooks = hooks;
}

function metaFile(workspaceRoot: string): string {
  return getStateFile(workspaceRoot, 'sessionMeta.json');
}

export function readSessionMetaAll(workspaceRoot: string): MetaStore {
  const file = metaFile(workspaceRoot);
  const raw = readStrictSessionMetaFile(file);
  if (raw === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Session metadata store is corrupt: ${file}`);
  }
  return validateSessionMetaStore(parsed, file);
}

export function getSessionMeta(workspaceRoot: string, sessionKey: string): SessionMeta {
  return ownSessionMeta(readSessionMetaAll(workspaceRoot), sessionKey) ?? {};
}

/** Empty/false/null fields are pruned so the store stays minimal; an entry that
 *  becomes entirely default is removed. Returns the resulting (possibly {}) meta. */
export function setSessionMeta(workspaceRoot: string, sessionKey: string, patch: Partial<SessionMeta>): SessionMeta {
  return withSessionMetaLock(workspaceRoot, () => {
    const all = readSessionMetaAll(workspaceRoot);
    const next = applySessionMetaPatch(all, sessionKey, patch);
    writeSessionMetaAll(workspaceRoot, all);
    return next;
  });
}

function applySessionMetaPatch(
  all: MetaStore,
  sessionKey: string,
  patch: Partial<SessionMeta>,
): SessionMeta {
  const next: SessionMeta = { ...(ownSessionMeta(all, sessionKey) ?? {}), ...patch };
  if (Object.prototype.hasOwnProperty.call(patch, 'title') &&
      !Object.prototype.hasOwnProperty.call(patch, 'titleSource')) {
    // Existing callers that set a title are human-facing rename paths. Clear a
    // previous agent marker so the new explicit title cannot be overwritten.
    delete next.titleSource;
  }
  if (!next.title) delete next.titleSource;
  for (const k of Object.keys(next) as Array<keyof SessionMeta>) {
    const v = next[k];
    if (v == null || v === false || v === '' || v === 'active') delete next[k];
  }
  if (Object.keys(next).length === 0) delete all[sessionKey];
  else defineSessionMeta(all, sessionKey, next);
  return ownSessionMeta(all, sessionKey) ?? {};
}

export interface SessionTitleExpectation {
  title?: string;
  titleSource?: SessionTitleSource;
}

export interface SessionTitleCompareAndSetResult {
  updated: boolean;
  reason: 'updated' | 'changed' | 'precedence' | 'invalid';
  meta: SessionMeta;
}

function titlePriority(source: SessionTitleSource): number {
  if (source === 'human') return 4;
  if (source === 'hook') return 3;
  if (source === 'agent') return 2;
  return 1;
}

function effectiveStoredTitleSource(meta: SessionMeta): SessionTitleSource {
  if (!meta.title) return 'derived';
  return meta.titleSource ?? 'human';
}

/** Store an explicit title without allowing a lower-authority source to win. */
export function setSessionTitle(
  workspaceRoot: string,
  sessionKey: string,
  title: string,
  source: Exclude<SessionTitleSource, 'derived'>,
): SessionMeta {
  const normalized = source === 'agent'
    ? normalizeAgentTitle(title)
    : normalizeExplicitSessionTitle(title);
  if (!normalized) throw new Error(`Invalid ${source} session title.`);
  return withSessionMetaLock(workspaceRoot, () => {
    const all = readSessionMetaAll(workspaceRoot);
    const current = ownSessionMeta(all, sessionKey) ?? {};
    if (current.title && titlePriority(source) < titlePriority(effectiveStoredTitleSource(current))) {
      return current;
    }
    const next = applySessionMetaPatch(all, sessionKey, {
      title: normalized,
      titleSource: source,
    });
    writeSessionMetaAll(workspaceRoot, all);
    return next;
  });
}

/**
 * Compare-and-set for asynchronous title proposals.
 *
 * A proposal loses if metadata changed while the model was running or if an
 * equal/higher-authority title already exists. Legacy unlabelled titles count
 * as human titles, so upgrades never rename a person's session.
 */
export function compareAndSetSessionTitle(
  workspaceRoot: string,
  sessionKey: string,
  expected: SessionTitleExpectation,
  proposal: { title: string; source: SessionTitleSource },
): SessionTitleCompareAndSetResult {
  const normalized = proposal.source === 'agent'
    ? normalizeAgentTitle(proposal.title)
    : normalizeExplicitSessionTitle(proposal.title);
  return withSessionMetaLock(workspaceRoot, () => {
    const all = readSessionMetaAll(workspaceRoot);
    const current = ownSessionMeta(all, sessionKey) ?? {};
    if (current.title !== expected.title || current.titleSource !== expected.titleSource) {
      return { updated: false, reason: 'changed', meta: current };
    }
    if (!normalized) return { updated: false, reason: 'invalid', meta: current };
    if (current.title && titlePriority(proposal.source) <= titlePriority(effectiveStoredTitleSource(current))) {
      return { updated: false, reason: 'precedence', meta: current };
    }
    const meta = applySessionMetaPatch(all, sessionKey, {
      title: normalized,
      titleSource: proposal.source,
    });
    writeSessionMetaAll(workspaceRoot, all);
    return { updated: true, reason: 'updated', meta };
  });
}

export function removeSessionMeta(workspaceRoot: string, sessionKey: string): void {
  withSessionMetaLock(workspaceRoot, () => {
    const all = readSessionMetaAll(workspaceRoot);
    if (!ownSessionMeta(all, sessionKey)) return;
    delete all[sessionKey];
    writeSessionMetaAll(workspaceRoot, all);
  });
}

/** Distinct, sorted group names currently in use (for the "Move to group" menu). */
export function listSessionGroups(workspaceRoot: string): string[] {
  const all = readSessionMetaAll(workspaceRoot);
  return [...new Set(Object.values(all).map((m) => m.group).filter((g): g is string => typeof g === 'string' && g.length > 0))].sort();
}

function writeSessionMetaAll(workspaceRoot: string, all: MetaStore): void {
  sessionMetaWriteHooks?.beforeWrite?.();
  const file = metaFile(workspaceRoot);
  const validated = validateSessionMetaStore(all, file);
  const serialized = `${JSON.stringify(validated, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > SESSION_META_MAX_STORE_BYTES) {
    throw new Error('Session metadata store exceeds its bounded byte capacity.');
  }
  writeFileAtomic(file, serialized, { mode: 0o600 });
}

function ownSessionMeta(all: MetaStore, sessionKey: string): SessionMeta | undefined {
  return Object.prototype.hasOwnProperty.call(all, sessionKey) ? all[sessionKey] : undefined;
}

function defineSessionMeta(all: MetaStore, sessionKey: string, meta: SessionMeta): void {
  Object.defineProperty(all, sessionKey, {
    value: meta,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function readStrictSessionMetaFile(file: string): string | undefined {
  let before: fs.Stats;
  try {
    before = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile() || before.size < 1 ||
      before.size > SESSION_META_MAX_STORE_BYTES) {
    throw new Error(`Unsafe or invalid session metadata store: ${file}`);
  }
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || !sameFileVersion(before, opened)) {
      throw new Error(`Session metadata store changed while opening: ${file}`);
    }
    if (process.platform !== 'win32' && (opened.mode & 0o777) !== 0o600) {
      fs.fchmodSync(descriptor, 0o600);
    }
    const expected = fs.fstatSync(descriptor);
    const raw = fs.readFileSync(descriptor, 'utf8');
    const afterRead = fs.fstatSync(descriptor);
    const afterPath = fs.lstatSync(file);
    if (!sameFileVersion(expected, afterRead) || afterPath.isSymbolicLink() ||
        !afterPath.isFile() || !sameFileVersion(expected, afterPath)) {
      throw new Error(`Session metadata store changed while reading: ${file}`);
    }
    return raw;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function sameFileVersion(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

function validateSessionMetaStore(value: unknown, file: string): MetaStore {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Session metadata store has an invalid schema: ${file}`);
  }
  const output: MetaStore = {};
  for (const [sessionKey, candidate] of Object.entries(value)) {
    validateSessionKey(sessionKey, file);
    defineSessionMeta(output, sessionKey, validateSessionMeta(candidate, sessionKey, file));
  }
  return output;
}

function validateSessionMeta(value: unknown, sessionKey: string, file: string): SessionMeta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Session metadata for "${sessionKey}" has an invalid schema: ${file}`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    'title', 'titleSource', 'pinned', 'archived', 'status', 'group', 'forkedFrom', 'branch',
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error(`Session metadata for "${sessionKey}" has unknown fields: ${file}`);
  }
  const title = optionalMetaText(record.title, MAX_SESSION_TITLE, 'title', sessionKey, file);
  const titleSource = record.titleSource;
  if (titleSource !== undefined && titleSource !== 'derived' && titleSource !== 'agent' &&
      titleSource !== 'hook' && titleSource !== 'human') {
    throw new Error(`Session metadata for "${sessionKey}" has an invalid title source: ${file}`);
  }
  if (titleSource !== undefined && title === undefined) {
    throw new Error(`Session metadata for "${sessionKey}" has a title source without a title: ${file}`);
  }
  const pinned = optionalBoolean(record.pinned, 'pinned', sessionKey, file);
  const archived = optionalBoolean(record.archived, 'archived', sessionKey, file);
  if (record.status !== undefined && record.status !== 'active' && record.status !== 'completed') {
    throw new Error(`Session metadata for "${sessionKey}" has an invalid status: ${file}`);
  }
  const group = record.group === null
    ? null
    : optionalMetaText(record.group, SESSION_META_MAX_TEXT_BYTES, 'group', sessionKey, file);
  const forkedFrom = optionalMetaText(
    record.forkedFrom,
    SESSION_META_MAX_SESSION_KEY_BYTES,
    'forkedFrom',
    sessionKey,
    file,
  );
  const branch = optionalMetaText(
    record.branch,
    SESSION_META_MAX_BRANCH_BYTES,
    'branch',
    sessionKey,
    file,
  );
  return {
    ...(title !== undefined ? { title } : {}),
    ...(titleSource !== undefined ? { titleSource: titleSource as SessionTitleSource } : {}),
    ...(pinned !== undefined ? { pinned } : {}),
    ...(archived !== undefined ? { archived } : {}),
    ...(record.status !== undefined ? { status: record.status as SessionStatus } : {}),
    ...(group !== undefined ? { group } : {}),
    ...(forkedFrom !== undefined ? { forkedFrom } : {}),
    ...(branch !== undefined ? { branch } : {}),
  };
}

function validateSessionKey(sessionKey: string, file: string): void {
  if (!sessionKey || sessionKey !== sessionKey.trim() || CONTROL_CHARACTER.test(sessionKey) ||
      Buffer.byteLength(sessionKey, 'utf8') > SESSION_META_MAX_SESSION_KEY_BYTES) {
    throw new Error(`Session metadata store contains an invalid session key: ${file}`);
  }
}

function optionalMetaText(
  value: unknown,
  maxLengthOrBytes: number,
  field: string,
  sessionKey: string,
  file: string,
): string | undefined {
  if (value === undefined) return undefined;
  const exceeds = field === 'title'
    ? typeof value === 'string' && value.length > maxLengthOrBytes
    : typeof value === 'string' && Buffer.byteLength(value, 'utf8') > maxLengthOrBytes;
  if (typeof value !== 'string' || !value || CONTROL_CHARACTER.test(value) || exceeds) {
    throw new Error(`Session metadata for "${sessionKey}" has an invalid ${field}: ${file}`);
  }
  return value;
}

function optionalBoolean(
  value: unknown,
  field: string,
  sessionKey: string,
  file: string,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`Session metadata for "${sessionKey}" has an invalid ${field}: ${file}`);
  }
  return value;
}

function withSessionMetaLock<T>(workspaceRoot: string, operation: () => T): T {
  const file = metaFile(workspaceRoot);
  const lockDir = `${file}.lock`;
  const ownerFile = path.join(lockDir, 'owner.json');
  const owner: SessionMetaLockOwner = {
    pid: process.pid,
    token: randomUUID(),
    acquiredAt: Date.now(),
  };
  const deadline = Date.now() + SESSION_META_LOCK_TIMEOUT_MS;

  while (true) {
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      fs.writeFileSync(ownerFile, `${JSON.stringify(owner)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      break;
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* exact lock cleanup only */ }
        throw error;
      }
      reapAbandonedSessionMetaLock(lockDir, ownerFile);
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for the session metadata store lock.');
      }
      const remaining = Math.max(1, Math.min(SESSION_META_LOCK_RETRY_MS, deadline - Date.now()));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, remaining);
    }
  }

  try {
    return operation();
  } finally {
    releaseSessionMetaLock(lockDir, ownerFile, owner.token);
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST';
}

function reapAbandonedSessionMetaLock(lockDir: string, ownerFile: string): void {
  let owner: SessionMetaLockOwner | undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(ownerFile, 'utf8')) as Partial<SessionMetaLockOwner>;
    if (Number.isInteger(parsed.pid) && typeof parsed.token === 'string' && parsed.token &&
        Number.isFinite(parsed.acquiredAt)) {
      owner = parsed as SessionMetaLockOwner;
    }
  } catch {
    // A process can die between mkdir and owner write. The directory mtime
    // supplies a bounded grace window before another writer reclaims it.
  }
  if (owner && processIsAlive(owner.pid)) return;
  if (!owner) {
    try {
      if (Date.now() - fs.statSync(lockDir).mtimeMs < SESSION_META_INCOMPLETE_LOCK_GRACE_MS) return;
    } catch {
      return;
    }
  }
  try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* another contender won the reap */ }
}

function processIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !!error && typeof error === 'object' && 'code' in error && error.code !== 'ESRCH';
  }
}

function releaseSessionMetaLock(lockDir: string, ownerFile: string, token: string): void {
  try {
    const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8')) as Partial<SessionMetaLockOwner>;
    if (owner.token !== token) return;
    fs.rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // Cleanup is best effort so a successful metadata mutation is not masked.
  }
}
