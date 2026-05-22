import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

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
  // moved over even if the caller never goes through getCliStateDir.
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
export function getCliStateDir(workspaceRoot: string): string {
  const wsRoot = getWorkspaceStateRoot(workspaceRoot);
  const stateDir = path.join(wsRoot, 'cli');
  if (!isPathInside(wsRoot, stateDir)) {
    throw new Error('CLI state directory escapes workspace state root.');
  }
  fs.mkdirSync(stateDir, { recursive: true });
  return stateDir;
}

let migrationAttempted = new Set<string>();
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
    // don't see stale state in the workspace tree. Anything that ISN'T a
    // workflows/ folder is moved to .brainrouter.migrated/. If only
    // workflows/ remains, the workspace-local .brainrouter/ stays as the
    // canonical home for committable artifacts.
    const archiveRoot = path.join(abs, '.brainrouter.migrated');
    const entries = fs.readdirSync(legacyRoot, { withFileTypes: true });
    let archivedAny = false;
    for (const entry of entries) {
      if (entry.name === 'workflows') continue;
      const from = path.join(legacyRoot, entry.name);
      const to = path.join(archiveRoot, entry.name);
      try {
        fs.mkdirSync(archiveRoot, { recursive: true });
        if (!fs.existsSync(to)) {
          fs.renameSync(from, to);
          archivedAny = true;
        } else {
          // Already archived from a prior run — just remove the stale copy.
          fs.rmSync(from, { recursive: true, force: true });
        }
      } catch {
        // best-effort: skip files we can't rename
      }
    }
    if (archivedAny) {
      process.stderr.write(`brainrouter: archived legacy in-workspace state to ${archiveRoot} (safe to delete after verifying)\n`);
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

export function getCliStateFile(workspaceRoot: string, fileName: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(fileName)) {
    throw new Error(`Invalid CLI state file name: ${fileName}`);
  }

  const stateDir = getCliStateDir(workspaceRoot);
  const filePath = path.join(stateDir, fileName);
  if (!isPathInside(stateDir, filePath)) {
    throw new Error(`CLI state file escapes state directory: ${fileName}`);
  }
  return filePath;
}

/**
 * Encode a sessionKey to a safe directory name. Base64url keeps it short and
 * round-trippable so listSessions can recover the original key. The 180-char
 * cap matches the previous transcript filename limit.
 */
export function encodeSessionKey(sessionKey: string): string {
  return Buffer.from(sessionKey, 'utf8').toString('base64url').slice(0, 180);
}

export function decodeSessionKey(encoded: string): string {
  try {
    return Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return encoded;
  }
}

/**
 * Per-session state bucket at `<workspace>/.brainrouter/cli/sessions/<encoded>/`.
 * Goal, plan, transcript, and any future per-session artifacts live together
 * here so users can browse one folder per chat session instead of hunting
 * across siblings.
 */
export function getSessionStateDir(workspaceRoot: string, sessionKey: string): string {
  const stateDir = getCliStateDir(workspaceRoot);
  const sessionsDir = path.join(stateDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const sessionDir = path.join(sessionsDir, encodeSessionKey(sessionKey));
  if (!isPathInside(sessionsDir, sessionDir)) {
    throw new Error('Session state directory escapes CLI state dir.');
  }
  fs.mkdirSync(sessionDir, { recursive: true });
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
  const sessionsDir = path.join(getCliStateDir(workspaceRoot), 'sessions');
  if (!fs.existsSync(sessionsDir)) return [];
  const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  const out: Array<{ sessionKey: string; dir: string; modifiedAt: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(sessionsDir, entry.name);
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
      sessionKey: decodeSessionKey(entry.name),
      dir,
      modifiedAt: mtime.toISOString(),
    });
  }
  return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
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
