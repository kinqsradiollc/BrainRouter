/**
 * User-global workspace/session persistence.
 *
 * State paths stay inside the BrainRouter home, session buckets are exact and
 * collision-resistant, and long opaque keys are recovered only from a private
 * marker whose hash still matches the directory name.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeFileAtomic } from '../util/fs/atomicFile.js';

export function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * User-global brainrouter home. Defaults to `~/.brainrouter`. Override with
 * the `BRAINROUTER_HOME` env var — tests set this to keep their state out of
 * the real user home.
 */
export function getBrainrouterHome(): string {
  const override = process.env.BRAINROUTER_HOME?.trim();
  const target = override ?? path.join(os.homedir(), '.brainrouter');
  fs.mkdirSync(target, { recursive: true });
  // Resolve symlinks (eg. macOS /tmp → /private/tmp) so callers comparing
  // against `realpathSync(workspaceRoot)` see the same root.
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

/**
 * Per-workspace state root inside the global home. Encodes the absolute
 * workspace path with a readable prefix + short hash so two workspaces with
 * the same basename never collide.
 *
 *   ~/.brainrouter/workspaces/BrainRouter-3a7f9c12/
 */
export function getWorkspaceStateRoot(workspaceRoot: string): string {
  const abs = fs.realpathSync(workspaceRoot);
  const home = getBrainrouterHome();
  const encoded = encodeWorkspacePath(abs);
  const dir = path.join(home, 'workspaces', encoded);
  fs.mkdirSync(dir, { recursive: true });
  // Migration check fires here (idempotent) so hooks/ and memories/ get
  // moved over even if the caller never goes through getStateDir.
  migrateLegacyWorkspaceState(workspaceRoot, dir);
  return dir;
}

function encodeWorkspacePath(absWorkspaceRoot: string): string {
  const base = path.basename(absWorkspaceRoot).replace(/[^A-Za-z0-9._-]+/g, '_') || 'root';
  const hash = crypto.createHash('sha1').update(absWorkspaceRoot).digest('hex').slice(0, 8);
  return `${base.slice(0, 60)}-${hash}`;
}

/**
 * CLI state directory for a workspace. Defaults to
 *   ~/.brainrouter/workspaces/<encoded>/cli
 * Older builds wrote to <workspaceRoot>/.brainrouter/cli — `getWorkspaceStateRoot`
 * handles the one-time migration so transcripts/goals/plans/hooks/memories
 * follow the user instead of cluttering the project.
 */
export function getStateDir(workspaceRoot: string): string {
  const wsRoot = getWorkspaceStateRoot(workspaceRoot);
  const stateDir = path.join(wsRoot, 'cli');
  if (!isPathInside(wsRoot, stateDir)) {
    throw new Error('CLI state directory escapes workspace state root.');
  }
  fs.mkdirSync(stateDir, { recursive: true });
  return stateDir;
}

let migrationAttempted = new Set<string>();
const WORKSPACE_LOCAL_PRESERVED_ENTRIES = new Set(['workflows', 'workspace.json']);
const WORKSPACE_MANIFEST_CLAIM_PATTERN = /^\.workspace\.json\.[0-9]+\.[0-9a-f]{24}\.claim$/;

function isWorkspaceLocalArtifact(entryName: string): boolean {
  return WORKSPACE_LOCAL_PRESERVED_ENTRIES.has(entryName) ||
    WORKSPACE_MANIFEST_CLAIM_PATTERN.test(entryName);
}

function migrateLegacyWorkspaceState(workspaceRoot: string, newRoot: string): void {
  if (migrationAttempted.has(workspaceRoot)) return;
  migrationAttempted.add(workspaceRoot);
  try {
    const abs = fs.realpathSync(workspaceRoot);
    const legacyRoot = path.join(abs, '.brainrouter');
    if (!fs.existsSync(legacyRoot)) return;
    // If the legacy tree IS the new tree (because BRAINROUTER_HOME points at the
    // workspace), do nothing.
    if (path.resolve(legacyRoot) === path.resolve(newRoot)) return;
    // The workspace-local "workflows/" tree is intentionally part of the
    // workspace and must NOT be migrated away — that's the documented
    // place to keep spec.md / tasks.md / walkthrough.md so the team can
    // commit them. We only rescue cli/, hooks/, and memories/.
    const markerFile = path.join(newRoot, '.migrated-from-workspace');
    if (!fs.existsSync(markerFile)) {
      for (const sub of ['cli', 'hooks', 'memories']) {
        const src = path.join(legacyRoot, sub);
        if (fs.existsSync(src)) {
          copyDirRecursive(src, path.join(newRoot, sub));
        }
      }
      fs.writeFileSync(markerFile, `Migrated from ${legacyRoot} at ${new Date().toISOString()}\n`, 'utf8');
      process.stderr.write(`brainrouter: migrated legacy state from ${legacyRoot} to ${newRoot}\n`);
    }
    // Now neutralize the legacy directory so the agent's list_dir / read_file
    // don't see stale state in the workspace tree. The important state has
    // already been rescue-copied into the new home above (guaranteed by the
    // marker check), so legacy state is deleted outright. Committable
    // workflows, the workspace manifest, and a crash-recovery claim for that
    // manifest remain project-local — we no longer create a
    // `.brainrouter.migrated/` archive in the project tree.
    const entries = fs.readdirSync(legacyRoot, { withFileTypes: true });
    let removedAny = false;
    for (const entry of entries) {
      if (isWorkspaceLocalArtifact(entry.name)) continue;
      const from = path.join(legacyRoot, entry.name);
      try {
        fs.rmSync(from, { recursive: true, force: true });
        removedAny = true;
      } catch {
        // best-effort: skip files we can't remove
      }
    }
    if (removedAny) {
      process.stderr.write(`brainrouter: removed legacy in-workspace state under ${legacyRoot} (rescued to ${newRoot})\n`);
    }
    // One-time SWEEP: older builds archived legacy state into a
    // `<ws>/.brainrouter.migrated/` folder. Now that the rescue-copy has run
    // and the marker exists (migration complete), delete any such stale
    // archive so pre-existing ones from older builds also disappear.
    try {
      const staleArchive = path.join(abs, '.brainrouter.migrated');
      if (fs.existsSync(staleArchive) && fs.existsSync(markerFile)) {
        fs.rmSync(staleArchive, { recursive: true, force: true });
        process.stderr.write(`brainrouter: swept stale archive ${staleArchive}\n`);
      }
    } catch {
      // best-effort sweep
    }
    // If the workspace-local `.brainrouter/` is now completely empty (no
    // `workflows/` to preserve), remove the empty shell so the user
    // doesn't see a stray folder reappear every session. We only delete
    // it when empty — never when it still has committable workflow
    // artifacts inside.
    try {
      const remaining = fs.readdirSync(legacyRoot);
      if (remaining.length === 0) {
        fs.rmdirSync(legacyRoot);
      }
    } catch {
      // best-effort cleanup
    }
  } catch (err: any) {
    // Migration is best-effort. If it fails (permissions etc.), the CLI still
    // runs against the new location and the user can copy manually.
    process.stderr.write(`brainrouter: legacy-state migration skipped (${err.message ?? err})\n`);
  }
}

/**
 * Workspace-local state directory, e.g. `<workspace>/.brainrouter/`. Reserved
 * for artifacts that are *meant* to be committed alongside the code — durable
 * workflow specs, task breakdowns, walkthrough notes. Everything else
 * (sessions, hooks, hookify rules, memories, preferences, transcripts) lives
 * under `getWorkspaceStateRoot` in the user-global home so the project tree
 * stays clean.
 */
export function getWorkspaceLocalDir(workspaceRoot: string): string {
  const root = fs.realpathSync(workspaceRoot);
  const dir = path.join(root, '.brainrouter');
  if (!isPathInside(root, dir)) {
    throw new Error('Workspace-local brainrouter directory escapes workspace root.');
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function copyDirRecursive(src: string, dst: string): void {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, dstPath);
    } else if (entry.isFile()) {
      if (fs.existsSync(dstPath)) continue; // don't clobber existing state
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

export function getStateFile(workspaceRoot: string, fileName: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(fileName)) {
    throw new Error(`Invalid CLI state file name: ${fileName}`);
  }

  const stateDir = getStateDir(workspaceRoot);
  const filePath = path.join(stateDir, fileName);
  if (!isPathInside(stateDir, filePath)) {
    throw new Error(`CLI state file escapes state directory: ${fileName}`);
  }
  return filePath;
}

const SESSION_DIRECTORY_NAME_MAX = 180;
// `~` is outside the base64url alphabet, so a legacy short-key encoding can
// never be mistaken for a v2 hash bucket.
const HASHED_SESSION_DIRECTORY_PREFIX = 'v2~';
const SESSION_KEY_MARKER = '.session-key.json';
const SESSION_KEY_MARKER_MAX_BYTES = 16 * 1024;

/**
 * Encode a sessionKey to a safe directory name. Short keys retain the legacy
 * round-trippable base64url path. Long keys use a full SHA-256 name rather than
 * truncation; their exact value lives in a private marker inside that bucket.
 */
export function encodeSessionKey(sessionKey: string): string {
  const encoded = Buffer.from(sessionKey, 'utf8').toString('base64url');
  if (encoded.length <= SESSION_DIRECTORY_NAME_MAX) return encoded;
  return `${HASHED_SESSION_DIRECTORY_PREFIX}${crypto.createHash('sha256').update(sessionKey, 'utf8').digest('base64url')}`;
}

export function decodeSessionKey(encoded: string): string {
  if (encoded.startsWith(HASHED_SESSION_DIRECTORY_PREFIX)) return encoded;
  try {
    return Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return encoded;
  }
}

/** Exactly-180 legacy names are ambiguous because old builds truncated there. */
export function sessionEncodingRequiresExactMarker(encoded: string): boolean {
  return encoded.startsWith(HASHED_SESSION_DIRECTORY_PREFIX) ||
    encoded.length === SESSION_DIRECTORY_NAME_MAX;
}

/** Only shorter legacy transcript filenames remain unambiguously reversible. */
export function isSafeLegacySessionEncoding(encoded: string): boolean {
  return encoded.length < SESSION_DIRECTORY_NAME_MAX &&
    !encoded.startsWith(HASHED_SESSION_DIRECTORY_PREFIX);
}

/**
 * Per-session state bucket at `<workspace>/.brainrouter/cli/sessions/<encoded>/`.
 * Goal, plan, transcript, and any future per-session artifacts live together
 * here so users can browse one folder per chat session instead of hunting
 * across siblings.
 */
export function getSessionStateDir(workspaceRoot: string, sessionKey: string): string {
  const stateDir = getStateDir(workspaceRoot);
  assertPrivateDirectory(stateDir);
  const sessionsDir = path.join(stateDir, 'sessions');
  ensurePrivateChildDirectory(stateDir, sessionsDir);
  const encoded = encodeSessionKey(sessionKey);
  const sessionDir = path.join(sessionsDir, encoded);
  if (!isPathInside(sessionsDir, sessionDir)) {
    throw new Error('Session state directory escapes CLI state dir.');
  }
  if (encoded.startsWith(HASHED_SESSION_DIRECTORY_PREFIX) &&
      !fs.existsSync(path.join(sessionDir, SESSION_KEY_MARKER))) {
    assertNoAmbiguousLegacyLongKeyState(stateDir, sessionsDir, sessionKey);
  }
  ensurePrivateChildDirectory(sessionsDir, sessionDir);
  if (sessionEncodingRequiresExactMarker(encoded)) {
    ensureHashedSessionKeyMarker(sessionDir, encoded, sessionKey);
  }
  return sessionDir;
}

export function getSessionStateFile(workspaceRoot: string, sessionKey: string, fileName: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(fileName)) {
    throw new Error(`Invalid session state file name: ${fileName}`);
  }
  const sessionDir = getSessionStateDir(workspaceRoot, sessionKey);
  const filePath = path.join(sessionDir, fileName);
  if (!isPathInside(sessionDir, filePath)) {
    throw new Error('Session state file escapes session directory.');
  }
  return filePath;
}

/**
 * List every persisted session bucket: returns `{ sessionKey, dir, modifiedAt }`
 * newest first. Used by `/sessions` to render a picker.
 */
export function listSessionDirs(workspaceRoot: string): Array<{ sessionKey: string; dir: string; modifiedAt: string }> {
  const sessionsDir = path.join(getStateDir(workspaceRoot), 'sessions');
  if (!fs.existsSync(sessionsDir)) return [];
  const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  const out: Array<{ sessionKey: string; dir: string; modifiedAt: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(sessionsDir, entry.name);
    let sessionKey: string;
    try {
      assertPrivateChildDirectory(sessionsDir, dir);
      sessionKey = sessionEncodingRequiresExactMarker(entry.name)
        ? readHashedSessionKeyMarker(dir, entry.name)
        : decodeSessionKey(entry.name);
    } catch {
      // Never guess a hashed identity when its exact marker is missing,
      // corrupt, or mismatched. Other healthy sessions remain listable.
      continue;
    }
    let mtime = new Date(0);
    try {
      const stat = fs.statSync(dir);
      mtime = stat.mtime;
      // The transcript drives "last activity" better than the dir mtime.
      const transcript = path.join(dir, 'transcript.jsonl');
      if (fs.existsSync(transcript)) {
        mtime = fs.statSync(transcript).mtime;
      }
    } catch { /* unreadable */ }
    out.push({
      sessionKey,
      dir,
      modifiedAt: mtime.toISOString(),
    });
  }
  return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

function ensureHashedSessionKeyMarker(
  sessionDir: string,
  encoded: string,
  sessionKey: string,
): void {
  const marker = path.join(sessionDir, SESSION_KEY_MARKER);
  const deadline = Date.now() + 1_000;
  while (!fs.existsSync(marker)) {
    const existingEntries = fs.readdirSync(sessionDir);
    if (existingEntries.length > 0) {
      const onlyConcurrentStages = existingEntries.every((entry) =>
        /^\.\.session-key\.json\.[0-9]+\.[0-9a-f]{24}\.tmp$/.test(entry));
      if (onlyConcurrentStages && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        continue;
      }
      throw new Error('Ambiguous session state directory is missing its exact-key marker.');
    }
    try {
      writeFileAtomic(marker, `${JSON.stringify({ schemaVersion: 1, sessionKey })}\n`, {
        mode: 0o600,
        exclusive: true,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const stored = readHashedSessionKeyMarker(sessionDir, encoded);
  if (stored !== sessionKey) {
    throw new Error('Session state directory hash collision or identity mismatch.');
  }
}

function readHashedSessionKeyMarker(sessionDir: string, encoded: string): string {
  const marker = path.join(sessionDir, SESSION_KEY_MARKER);
  let descriptor: number | undefined;
  try {
    const before = fs.lstatSync(marker);
    if (before.isSymbolicLink() || !before.isFile() || before.size < 2 ||
        before.size > SESSION_KEY_MARKER_MAX_BYTES) {
      throw new Error('Invalid hashed session-key marker.');
    }
    const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    descriptor = fs.openSync(marker, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('Hashed session-key marker changed during read.');
    }
    if (process.platform !== 'win32' && (opened.mode & 0o777) !== 0o600) {
      fs.fchmodSync(descriptor, 0o600);
    }
    const expected = fs.fstatSync(descriptor);
    const raw = fs.readFileSync(descriptor, 'utf8');
    const after = fs.lstatSync(marker);
    const afterRead = fs.fstatSync(descriptor);
    if (after.isSymbolicLink() || !after.isFile() || after.dev !== expected.dev ||
        after.ino !== expected.ino || after.size !== expected.size ||
        after.mtimeMs !== expected.mtimeMs || after.ctimeMs !== expected.ctimeMs ||
        afterRead.size !== expected.size || afterRead.mtimeMs !== expected.mtimeMs ||
        afterRead.ctimeMs !== expected.ctimeMs) {
      throw new Error('Hashed session-key marker changed during read.');
    }
    const parsed = JSON.parse(raw) as { schemaVersion?: unknown; sessionKey?: unknown };
    if (parsed.schemaVersion !== 1 || typeof parsed.sessionKey !== 'string' ||
        encodeSessionKey(parsed.sessionKey) !== encoded) {
      throw new Error('Invalid hashed session-key marker.');
    }
    return parsed.sessionKey;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('Missing hashed session-key marker.');
    }
    throw error;
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* preserve the original failure */ }
    }
  }
}

function ensurePrivateChildDirectory(parent: string, directory: string): void {
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  assertPrivateChildDirectory(parent, directory);
}

function assertNoAmbiguousLegacyLongKeyState(
  stateDir: string,
  sessionsDir: string,
  sessionKey: string,
): void {
  const legacyName = Buffer.from(sessionKey, 'utf8').toString('base64url').slice(0, SESSION_DIRECTORY_NAME_MAX);
  const legacyBucket = path.join(sessionsDir, legacyName);
  const legacyMarker = path.join(legacyBucket, SESSION_KEY_MARKER);
  let ambiguousBucket = false;
  try {
    const stat = fs.lstatSync(legacyBucket);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      ambiguousBucket = true;
    } else if (fs.existsSync(legacyMarker)) {
      // A marker proves this is a new exact-180 key, not an unattributed old
      // long-key bucket. Its mismatch is intentional and safe.
      readHashedSessionKeyMarker(legacyBucket, legacyName);
    } else {
      ambiguousBucket = fs.readdirSync(legacyBucket).length > 0;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') ambiguousBucket = true;
  }
  const legacyTranscript = path.join(stateDir, 'transcripts', `${legacyName}.jsonl`);
  let ambiguousTranscript = false;
  try {
    const stat = fs.lstatSync(legacyTranscript);
    ambiguousTranscript = stat.isSymbolicLink() || !stat.isFile() || stat.size > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') ambiguousTranscript = true;
  }
  if (ambiguousBucket || ambiguousTranscript) {
    throw new Error(
      `Legacy long-key session state is ambiguous and requires manual recovery before this exact session can resume: ${legacyName}`,
    );
  }
}

function assertPrivateChildDirectory(parent: string, directory: string): void {
  if (!isPathInside(parent, directory)) {
    throw new Error(`Session state directory escapes its parent: ${directory}`);
  }
  assertPrivateDirectory(directory);
  const realParent = fs.realpathSync(parent);
  const realDirectory = fs.realpathSync(directory);
  if (!isPathInside(realParent, realDirectory)) {
    throw new Error(`Session state directory escapes through a symbolic link: ${directory}`);
  }
}

function assertPrivateDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Unsafe session state directory: ${directory}`);
  }
  try {
    fs.chmodSync(directory, 0o700);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  }
  if (process.platform !== 'win32' && (fs.statSync(directory).mode & 0o777) !== 0o700) {
    throw new Error(`Session state directory is not private: ${directory}`);
  }
}

export function readJsonFile<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) {
      return fallback;
    }
    return JSON.parse(raw) as T;
  } catch (err: any) {
    // Falling back instead of throwing means a single corrupted state file
    // (truncated JSON from Ctrl-C mid-write, partial migration, hand-edit)
    // can't prevent the REPL from booting. Quarantine the bad file so the
    // user can inspect it, then return the caller's fallback value. The
    // alternative — propagating — meant a half-byte goal.json bricked the
    // entire CLI because createSystemMessage reads it on every turn start.
    try {
      const quarantine = `${filePath}.corrupt-${Date.now()}`;
      fs.renameSync(filePath, quarantine);
      console.warn(
        `[brainrouter] could not parse ${filePath} (${err.message}); ` +
        `moved to ${quarantine} and falling back to default.`,
      );
    } catch {
      // Couldn't quarantine — just warn and continue with the fallback.
      console.warn(`[brainrouter] could not parse ${filePath}: ${err.message}; using default.`);
    }
    return fallback;
  }
}

export function writeJsonFile(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  // Temp suffix needs to be unique even when two writers run in the same
  // millisecond (e.g. goal + plan + prefs writes during a single
  // auto-continuation tick). Date.now() is millisecond-resolution so the old
  // form `${pid}.${ms}.tmp` collides under load; add a 6-byte random nonce.
  const nonce = crypto.randomBytes(6).toString('hex');
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${nonce}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}
