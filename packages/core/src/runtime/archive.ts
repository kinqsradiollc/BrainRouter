/**
 * MC-A6 — durable WORKSPACE ARCHIVES: work outlives the runtime.
 *
 * A `worktree` runtime is throwaway by design — `dispose()` tears the tree
 * down. The Phase-1 recovery patch already preserved uncommitted work, but
 * only as a single patch file keyed to the parent workspace's state dir. An
 * ARCHIVE generalizes that into a self-describing, resumable unit under the
 * user-global home:
 *
 *   <brainrouter-home>/runtime/archives/<id>/
 *     changes.patch   — git-delta of uncommitted work (the same recovery-patch
 *                       writer teardown uses: staged `add -A` + binary diff)
 *     files.tar.gz    — the UNTRACKED+modified files' current bytes (never the
 *                       whole repo — disk is constrained; payloads over
 *                       `cli.runtime.archiveMaxMB` skip the tarball and note it)
 *     manifest.json   — { id, workspaceRoot, baseCommit, branch, createdAt,
 *                       bytes, status, … }
 *
 * `resumeFromArchive(id)` inverts the capture: recreate a detached worktree at
 * the archived `baseCommit`, apply the patch, unpack the tarball, and return a
 * ready `RuntimeSpec` pointing inside the new tree. `listArchives()` /
 * `pruneArchives()` keep the archive root bounded (`cli.runtime.archiveKeep`).
 *
 * Everything here is best-effort at CAPTURE time (archiving must never block a
 * teardown) and fail-loud at RESUME time (a resume that can't restore the work
 * is an error, not a silent empty tree).
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getBrainrouterHome } from '../storage/store.js';
import { getCliKnobs } from '../config/config.js';
import {
  applyPatchFile,
  captureWorktreeChanges,
  createDetachedWorktree,
  removeChildWorktree,
} from '../worktree/worktreeIsolation.js';
import type { RuntimeSpec } from './runtimeTypes.js';

const PATCH_NAME = 'changes.patch';
const TAR_NAME = 'files.tar.gz';
const MANIFEST_NAME = 'manifest.json';

/** User-global root all runtime archives live under. */
export function runtimeArchivesRoot(): string {
  return path.join(getBrainrouterHome(), 'runtime', 'archives');
}

function archiveDir(id: string): string {
  return path.join(runtimeArchivesRoot(), id);
}

function runGit(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
  };
}

/** `archived` = patch (+ tarball) captured; `oversize` = payload beat the
 *  `cli.runtime.archiveMaxMB` cap, so only the patch was kept (noted). */
export type RuntimeArchiveStatus = 'archived' | 'oversize';

export interface RuntimeArchiveManifest {
  /** Archive id — the runtime instance id that was disposed. */
  id: string;
  /** PARENT workspace the runtime belonged to (where resume re-carves from). */
  workspaceRoot: string;
  /** Commit the archived tree was checked out at (resume target). */
  baseCommit: string;
  /** Branch name at capture time (`HEAD` for detached worktrees). */
  branch: string;
  createdAt: string;
  /** On-disk size of the archive payload (patch + tarball), in bytes. */
  bytes: number;
  status: RuntimeArchiveStatus;
  /** How many files differed from `baseCommit` at capture time. */
  changedFiles: number;
  /** Basename of the git-delta patch inside the archive dir (null = none written). */
  patchFile: string | null;
  /** Basename of the changed-files tarball (null = skipped: oversize/empty/failed). */
  filesTar: string | null;
  /** Why something was skipped (oversize payload, tar failure, …). */
  note?: string;
  /** Session the archived runtime hosted — the default resume session key. */
  sessionKey?: string;
}

export interface ArchiveWorkspaceInput {
  /** Archive id (the disposing runtime's instance id). */
  id: string;
  /** PARENT workspace root the runtime belonged to. */
  workspaceRoot: string;
  /** The working tree to archive (the runtime's worktree root). */
  treeRoot: string;
  sessionKey?: string;
  /** Tarball payload cap in BYTES (default: `cli.runtime.archiveMaxMB`). */
  maxBytes?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => string;
}

/**
 * Capture `treeRoot`'s uncommitted work into a durable archive. Returns the
 * manifest, or null when there is nothing to archive (clean tree, vanished
 * tree, or not a git checkout) — empty archives never spend disk.
 */
export function archiveWorkspace(input: ArchiveWorkspaceInput): RuntimeArchiveManifest | null {
  const nowFn = input.now ?? (() => new Date().toISOString());
  let tree: string;
  try {
    tree = fs.realpathSync(input.treeRoot);
  } catch {
    return null; // tree already gone — nothing to capture
  }
  const head = runGit(tree, ['rev-parse', 'HEAD']);
  if (!head.ok) return null; // not a git checkout — no delta to archive
  const baseCommit = head.stdout.trim();
  const branchRes = runGit(tree, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = (branchRes.ok && branchRes.stdout.trim()) || 'HEAD';

  const dir = archiveDir(input.id);
  fs.mkdirSync(dir, { recursive: true });

  // (1) Git-delta patch of the uncommitted work — the SAME recovery-patch
  // writer worktree teardown uses (staged `add -A`, full binary-safe diff).
  const capture = captureWorktreeChanges(tree, { patchFile: path.join(dir, PATCH_NAME) });
  if (capture.changedFiles === 0) {
    // Clean tree: nothing worth archiving. Remove the dir we just made so the
    // archive root only ever contains real, resumable archives.
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    return null;
  }

  // (2) Tarball of the UNTRACKED+modified files' current bytes — never the
  // whole repo. `captureWorktreeChanges` staged everything, so the cached
  // name-list vs HEAD is exactly the changed set; `--diff-filter=d` drops
  // deletions (nothing to pack for those — the patch carries them).
  const namesRes = runGit(tree, ['diff', '--cached', '--name-only', '-z', '--diff-filter=d', 'HEAD']);
  const names = namesRes.ok ? namesRes.stdout.split('\0').filter(Boolean) : [];
  let payloadBytes = 0;
  const present: string[] = [];
  for (const rel of names) {
    try {
      const st = fs.statSync(path.join(tree, rel));
      if (st.isFile()) {
        present.push(rel);
        payloadBytes += st.size;
      }
    } catch { /* vanished between diff and stat — skip */ }
  }

  const maxBytes = input.maxBytes ?? getCliKnobs().runtime.archiveMaxMB * 1024 * 1024;
  let filesTar: string | null = null;
  let status: RuntimeArchiveStatus = 'archived';
  let note: string | undefined;
  if (payloadBytes > maxBytes) {
    status = 'oversize';
    note = `changed-file payload is ${payloadBytes} bytes (> ${maxBytes} cap) — tarball skipped; the git-delta patch was still captured`;
  } else if (present.length > 0) {
    const listFile = path.join(dir, '.files.list');
    try {
      fs.writeFileSync(listFile, present.join('\n') + '\n', 'utf8');
      const tarRes = spawnSync(
        'tar',
        ['-czf', path.join(dir, TAR_NAME), '-C', tree, '-T', listFile],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 },
      );
      if (tarRes.status === 0) {
        filesTar = TAR_NAME;
      } else {
        note = `tar failed: ${(tarRes.stderr ?? '').trim() || tarRes.error?.message || 'non-zero exit'}`;
      }
    } catch (err) {
      note = `tar failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      try { fs.rmSync(listFile, { force: true }); } catch { /* best-effort */ }
    }
  }

  // What the archive actually occupies on disk (patch + tarball).
  let bytes = 0;
  for (const name of [PATCH_NAME, TAR_NAME]) {
    try { bytes += fs.statSync(path.join(dir, name)).size; } catch { /* absent */ }
  }

  const manifest: RuntimeArchiveManifest = {
    id: input.id,
    workspaceRoot: input.workspaceRoot,
    baseCommit,
    branch,
    createdAt: nowFn(),
    bytes,
    status,
    changedFiles: capture.changedFiles,
    patchFile: capture.patchPath ? PATCH_NAME : null,
    filesTar,
    ...(note ? { note } : {}),
    ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
  };
  fs.writeFileSync(path.join(dir, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  return manifest;
}

/**
 * All archives under the archive root, newest first. Same tolerance
 * conventions as the runtime state store: unreadable/mismatched manifests are
 * skipped (a manifest whose `id` doesn't match its directory name is treated
 * as corrupt — `archiveWorkspace` always writes dir === id).
 */
export function listArchives(): RuntimeArchiveManifest[] {
  const root = runtimeArchivesRoot();
  if (!fs.existsSync(root)) return [];
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out: RuntimeArchiveManifest[] = [];
  for (const entry of entries) {
    try {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(root, entry, MANIFEST_NAME), 'utf-8'),
      ) as RuntimeArchiveManifest;
      if (manifest && manifest.id === entry) out.push(manifest);
    } catch { /* skip unreadable */ }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export interface PruneArchivesOptions {
  /** Keep the newest N archives (default: `cli.runtime.archiveKeep`).
   *  0 = no count-based pruning (age-based still applies when set). */
  keepN?: number;
  /** Also drop archives older than this many days (off unless set). */
  maxAgeDays?: number;
  /** Injectable clock (epoch ms) for deterministic tests. */
  now?: () => number;
}

/** Bound the archive root: drop everything beyond the newest `keepN` and/or
 *  older than `maxAgeDays`. Returns the removed archive ids. */
export function pruneArchives(options: PruneArchivesOptions = {}): string[] {
  const keepN = options.keepN ?? getCliKnobs().runtime.archiveKeep;
  const nowMs = (options.now ?? Date.now)();
  const removed: string[] = [];
  listArchives().forEach((manifest, index) => {
    const overCount = keepN > 0 && index >= keepN;
    const ageMs = nowMs - Date.parse(manifest.createdAt);
    const overAge = options.maxAgeDays !== undefined
      && Number.isFinite(ageMs)
      && ageMs > options.maxAgeDays * 86_400_000;
    if (!overCount && !overAge) return;
    try {
      // listArchives guarantees manifest.id === its directory name, so this
      // never escapes the archive root.
      fs.rmSync(archiveDir(manifest.id), { recursive: true, force: true });
      removed.push(manifest.id);
    } catch { /* best-effort */ }
  });
  return removed;
}

export interface ResumeFromArchiveOptions {
  /** Session key for the recreated runtime spec (default: the archived one). */
  sessionKey?: string;
}

export interface ResumedArchive {
  /** Ready runtime spec — `workspaceRoot`/`launchCwd` point INSIDE the new tree. */
  spec: RuntimeSpec;
  /** The recreated detached worktree (checked out at the archived baseCommit). */
  worktreeRoot: string;
  manifest: RuntimeArchiveManifest;
  /** True when the git-delta patch applied cleanly. */
  patchApplied: boolean;
  patchError?: string;
  /** True when the changed-files tarball unpacked. */
  filesRestored: boolean;
}

/**
 * Invert an archive: recreate a detached worktree at the archived
 * `baseCommit`, re-apply the git-delta patch, then unpack the tarball (the
 * tarball's bytes are authoritative for untracked+modified files — a clean
 * patch apply and the unpack agree, and the unpack also covers the case where
 * the patch couldn't apply). Throws when the archive is missing, the parent
 * workspace can't host a worktree at `baseCommit`, or NOTHING of the archived
 * work could be restored.
 */
export function resumeFromArchive(id: string, options: ResumeFromArchiveOptions = {}): ResumedArchive {
  const dir = archiveDir(id);
  let manifest: RuntimeArchiveManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_NAME), 'utf-8')) as RuntimeArchiveManifest;
  } catch {
    throw new Error(`no archive '${id}' under ${runtimeArchivesRoot()}`);
  }

  // A fresh tree per resume (timestamped) — resuming twice never collides.
  const childId = `resume-${id}-${Date.now().toString(36)}`;
  const created = createDetachedWorktree(manifest.workspaceRoot, childId, manifest.baseCommit);
  if (!created) {
    throw new Error(
      `archive '${id}': could not recreate a worktree at ${manifest.baseCommit} from ${manifest.workspaceRoot}`,
    );
  }
  const worktreeRoot = created.worktreeRoot;

  let patchApplied = false;
  let patchError: string | undefined;
  if (manifest.patchFile) {
    const patchPath = path.join(dir, manifest.patchFile);
    if (fs.existsSync(patchPath)) {
      const res = applyPatchFile(worktreeRoot, patchPath);
      patchApplied = res.ok;
      patchError = res.error;
    } else {
      patchError = 'patch file missing from the archive';
    }
  }

  let filesRestored = false;
  if (manifest.filesTar) {
    const tarPath = path.join(dir, manifest.filesTar);
    if (fs.existsSync(tarPath)) {
      const tarRes = spawnSync('tar', ['-xzf', tarPath, '-C', worktreeRoot], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
      });
      filesRestored = tarRes.status === 0;
    }
  }

  if (manifest.changedFiles > 0 && !patchApplied && !filesRestored) {
    // Nothing restored: fail loudly and clean the useless tree back up.
    removeChildWorktree({ kind: 'git-worktree', ...created });
    throw new Error(
      `archive '${id}': restore failed (${patchError ?? 'no patch'}; no tarball) — archive left intact at ${dir}`,
    );
  }

  return {
    spec: {
      workspaceRoot: worktreeRoot,
      launchCwd: worktreeRoot,
      sessionKey: options.sessionKey ?? manifest.sessionKey ?? `session:archive:${id}`,
    },
    worktreeRoot,
    manifest,
    patchApplied,
    patchError,
    filesRestored,
  };
}
