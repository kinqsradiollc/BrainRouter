import path from 'node:path';
/**
 * Worktree isolation implementation.
 *
 * Policy and recovery services live here; privileged Git/filesystem/config
 * operations are owned by the host adapter. The stable public path remains a
 * thin compatibility facade.
 */
import type { AccessMode } from '../../orchestration/roles/roles.js';
import type {
  ChildWorkspaceIsolationMode,
  ChildWorkspaceResolution,
  ChildWorktreeIsolation,
  RemoveChildWorktreeOptions,
  RemoveChildWorktreeResult,
  WorktreeChangeCapture,
} from './contracts.js';
import { nodeWorktreeIsolationHost as host } from './host/nodeWorktreeIsolationHost.js';
import { resolveAttachableWorktree } from '../concurrentWorktrees.js';
import { liveForeignOwner } from '../ownership/worktreeOwnership.js';

interface PrepareChildWorkspaceInput {
  parentWorkspaceRoot: string;
  parentLaunchCwd: string;
  childId: string;
  access: AccessMode;
  mode: ChildWorkspaceIsolationMode;
  /**
   * ADR-042 D7 — resume an EXISTING worktree instead of minting a fresh detached
   * copy. When set and the target is a listed worktree of this repo not owned by
   * a live foreign session, the child's workspaceRoot IS that worktree. Not
   * resumable ⇒ `fallback: 'create'` mints as usual, otherwise it fails.
   */
  attachTo?: { path?: string; branch?: string; fallback?: 'create' };
  /** The parent's session key — so an attach can tell self-owned from foreign (D6). */
  selfSessionKey?: string;
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

// DESK-6w (T4) — owning-git-root resolution is now the shared helper, so CLI
// worktrees and desktop workspace identity agree on the same repo root.
const gitRoot = host.findGitRoot;

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'child';
}

/**
 * A5 (0.4.11) — base dir for child worktrees. Default `<BRAINROUTER_HOME>/worktrees`
 * (≈ `~/.brainrouter/worktrees`), realpath-resolved so there's no `/var`→`/private/var`
 * symlink drift like the old `$TMPDIR/brainrouter-worktrees`. Override with the
 * `cli.worktreeRoot` knob (absolute path); an unwritable override falls back to
 * the default.
 */
function worktreeBase(): string {
  const custom = host.configuredWorktreeRoot();
  if (custom) {
    try {
      host.mkdir(custom);
      return host.realpath(custom);
    } catch { /* unwritable custom path → fall back to the default home base */ }
  }
  return path.join(host.brainrouterHome(), 'worktrees'); // host home is already realpath'd
}

function defaultWorktreePath(repoRoot: string, childId: string): string {
  const repoName = safeName(path.basename(repoRoot));
  return path.join(worktreeBase(), repoName, safeName(childId));
}

function launchCwdInWorktree(repoRoot: string, parentLaunchCwd: string, worktreeRoot: string): string {
  let realLaunch = parentLaunchCwd;
  try {
    realLaunch = host.realpath(parentLaunchCwd);
  } catch {
    realLaunch = path.resolve(parentLaunchCwd);
  }
  const rel = path.relative(repoRoot, realLaunch);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return worktreeRoot;
  const candidate = path.join(worktreeRoot, rel);
  return host.exists(candidate) ? candidate : worktreeRoot;
}

export function prepareChildWorkspace(input: PrepareChildWorkspaceInput): ChildWorkspaceResolution {
  const parentWorkspaceRoot = host.realpath(input.parentWorkspaceRoot);
  const parentLaunchCwd = (() => {
    try {
      const real = host.realpath(input.parentLaunchCwd);
      return isInside(parentWorkspaceRoot, real) ? real : parentWorkspaceRoot;
    } catch {
      return parentWorkspaceRoot;
    }
  })();

  if (input.access === 'read' || input.mode === 'off') {
    return { workspaceRoot: parentWorkspaceRoot, launchCwd: parentLaunchCwd, isolated: false };
  }

  const repoRoot = gitRoot(parentWorkspaceRoot);
  if (!repoRoot || !isInside(repoRoot, parentWorkspaceRoot)) {
    const notice = 'Child workspace isolation requested, but the parent workspace is not inside a git repository.';
    if (input.mode === 'git-worktree') throw new Error(notice);
    return { workspaceRoot: parentWorkspaceRoot, launchCwd: parentLaunchCwd, isolated: false, notice };
  }

  // ADR-042 D7 — resume an existing worktree rather than minting one.
  if (input.attachTo && (input.attachTo.path || input.attachTo.branch)) {
    const target = input.attachTo.path ?? input.attachTo.branch ?? '';
    const res = resolveAttachableWorktree(parentWorkspaceRoot, target);
    const foreign = res.ok && input.selfSessionKey
      ? liveForeignOwner(parentWorkspaceRoot, res.info.path, input.selfSessionKey)
      : null;
    if (res.ok && !foreign) {
      const real = host.realpath(res.info.path);
      return {
        workspaceRoot: real,
        launchCwd: launchCwdInWorktree(repoRoot, parentLaunchCwd, real),
        isolated: true,
        isolation: { kind: 'git-worktree', sourceRoot: repoRoot, worktreeRoot: real },
      };
    }
    if (input.attachTo.fallback !== 'create') {
      const why = foreign ? `it is owned by a live session (${foreign})` : (res.ok ? 'it is not resumable' : res.reason);
      const notice = `Child worktree attach to "${target}" failed: ${why}. Pass fallback:'create' to mint a fresh worktree instead.`;
      if (input.mode === 'git-worktree') throw new Error(notice);
      return { workspaceRoot: parentWorkspaceRoot, launchCwd: parentLaunchCwd, isolated: false, notice };
    }
    // fallback: 'create' — fall through to the mint path below.
  }

  const worktreeRoot = defaultWorktreePath(repoRoot, input.childId);
  if (!host.exists(worktreeRoot)) {
    host.mkdir(path.dirname(worktreeRoot));
    const created = host.runGit(repoRoot, ['worktree', 'add', '--detach', worktreeRoot, 'HEAD']);
    if (!created.ok) {
      const reason = created.stderr.trim() || created.stdout.trim() || 'unknown git worktree error';
      const notice = `Child workspace isolation requested, but git worktree creation failed: ${reason}`;
      if (input.mode === 'git-worktree') throw new Error(notice);
      return { workspaceRoot: parentWorkspaceRoot, launchCwd: parentLaunchCwd, isolated: false, notice };
    }
  }

  const realWorktreeRoot = host.realpath(worktreeRoot);
  return {
    workspaceRoot: realWorktreeRoot,
    launchCwd: launchCwdInWorktree(repoRoot, parentLaunchCwd, realWorktreeRoot),
    isolated: true,
    isolation: {
      kind: 'git-worktree',
      sourceRoot: repoRoot,
      worktreeRoot: realWorktreeRoot,
    },
  };
}

/**
 * BUILD-LOOP P2 (0.4.12) — create ONE detached worktree shared by a build run's
 * implement → verify → review children, so the verifier runs against the worker's
 * ACTUAL edits (not a fresh HEAD checkout) and the reviewer reads that same diff.
 * The caller passes the returned `workspaceRoot` as each child's
 * `workspaceRootOverride`, and at the end merges it back via `removeChildWorktree`
 * (gated on verify-green + review-ok). Returns null when the workspace isn't a git
 * repo (caller falls back to the shared parent tree, ungated).
 */
export function prepareSharedWorktree(
  parentWorkspaceRoot: string,
  label: string,
): { workspaceRoot: string; isolation: ChildWorktreeIsolation } | null {
  let root: string;
  try {
    root = host.realpath(parentWorkspaceRoot);
  } catch {
    return null;
  }
  const repoRoot = gitRoot(root);
  if (!repoRoot || !isInside(repoRoot, root)) return null;
  const worktreeRoot = defaultWorktreePath(repoRoot, `build-${safeName(label)}`);
  if (!host.exists(worktreeRoot)) {
    try {
      host.mkdir(path.dirname(worktreeRoot));
    } catch {
      return null;
    }
    const created = host.runGit(repoRoot, ['worktree', 'add', '--detach', worktreeRoot, 'HEAD']);
    if (!created.ok) return null;
  } else {
    // BUILD-LOOP P2 (review) — a worktree left behind by a prior run with the same
    // slug (crash, or a reused task) must NOT seed the new run with a dirty tree.
    // Reset it to a clean detached HEAD at the repo's CURRENT HEAD, preserving any
    // leftover edits to a recovery patch first so a crashed run's work is never
    // silently destroyed.
    resetStaleWorktree(repoRoot, worktreeRoot);
  }
  let real = worktreeRoot;
  try { real = host.realpath(worktreeRoot); } catch { /* use the raw path */ }
  return { workspaceRoot: real, isolation: { kind: 'git-worktree', sourceRoot: repoRoot, worktreeRoot: real } };
}

/** Reset a reused build worktree to a clean detached HEAD at the repo's current
 *  HEAD, after best-effort preserving any leftover tracked edits to a patch. */
function resetStaleWorktree(repoRoot: string, worktreeRoot: string): void {
  try {
    const status = host.runGit(worktreeRoot, ['status', '--porcelain']);
    if (status.ok && status.stdout.trim()) {
      const diff = host.runGit(worktreeRoot, ['diff', 'HEAD']);
      if (diff.ok && diff.stdout.trim()) {
        try {
          const dir = path.join(host.stateDir(repoRoot), 'worktree-patches');
          host.mkdir(dir);
          const token = `${path.basename(worktreeRoot)}-${host.now().toString(36)}`;
          host.writeText(path.join(dir, `leftover-${safeName(token)}.patch`), diff.stdout);
        } catch { /* best-effort preservation — the reset below is what matters */ }
      }
    }
  } catch { /* ignore — proceed to reset */ }
  const head = host.runGit(repoRoot, ['rev-parse', 'HEAD']);
  host.runGit(worktreeRoot, ['reset', '--hard', head.ok && head.stdout.trim() ? head.stdout.trim() : 'HEAD']);
  host.runGit(worktreeRoot, ['clean', '-fd']);
}

/**
 * BUILD-LOOP P2 (review) — is `candidate` a git worktree of the SAME repository as
 * `parentWorkspaceRoot`? The build orchestrator's `workspaceRootOverride` MUST be a
 * shared worktree of this repo, never an arbitrary path — otherwise a caller could
 * redirect a child's writes outside the workspace (ownership + write-validation are
 * computed relative to the child's `workspaceRoot`). Compares the resolved
 * `--git-common-dir` of both; returns false on any mismatch / non-repo / error.
 */
export function isSharedWorktreeOf(parentWorkspaceRoot: string, candidate: string): boolean {
  const commonDir = (dir: string): string | null => {
    const res = host.runGit(dir, ['rev-parse', '--git-common-dir']);
    if (!res.ok) return null;
    const out = res.stdout.trim();
    if (!out) return null;
    const abs = path.isAbsolute(out) ? out : path.join(dir, out);
    try { return host.realpath(abs); } catch { return path.resolve(abs); }
  };
  try {
    if (!host.exists(candidate)) return false;
    const a = commonDir(host.realpath(candidate));
    const b = commonDir(host.realpath(parentWorkspaceRoot));
    return a !== null && b !== null && a === b;
  } catch {
    return false;
  }
}

/**
 * BUILD-LOOP P2 (review) — map a child's requested launch cwd into the shared
 * worktree (so a command expecting to run from a subdirectory still does), falling
 * back to the worktree root when the mapped dir doesn't exist or the repo can't be
 * resolved. Mirrors the per-child isolation cwd mapping.
 */
export function sharedWorktreeLaunchCwd(parentWorkspaceRoot: string, parentLaunchCwd: string, worktreeRoot: string): string {
  const repoRoot = gitRoot(parentWorkspaceRoot);
  if (!repoRoot) return worktreeRoot;
  return launchCwdInWorktree(repoRoot, parentLaunchCwd, worktreeRoot);
}

/**
 * Where a child's full recovery patch is persisted, under the per-workspace CLI
 * state dir (NOT the repo). Lets the parent re-apply the child's work with
 * `git apply <path>` (or `/agents diff <id>`) even after the throwaway worktree is
 * gone. Shared by the spawn merge-back, teardown, and the build-loop finalize — so
 * it lives here (a leaf module) rather than in `tools.ts`, which avoids a runtime
 * import cycle (`tools` ↔ `workflowTool`).
 */
export function worktreePatchFile(workspaceRoot: string, childId: string): string {
  return path.join(host.stateDir(workspaceRoot), 'worktree-patches', `${childId}.patch`);
}

/**
 * The recovery-patch WRITER, factored out of `removeChildWorktree` (MC-A6) so
 * workspace archiving reuses the exact same capture: stage everything in
 * `worktreeRoot` (tracked edits, new files, deletions — `.gitignore` still
 * honored, so build artifacts stay out), persist a FULL binary-safe patch to
 * `opts.patchFile`, and report the changed-file count plus an uncapped
 * textual preview. Best-effort — returns a clean capture on any git failure;
 * never throws.
 */
export function captureWorktreeChanges(
  worktreeRoot: string,
  opts: { patchFile?: string; baseRef?: string } = {},
): WorktreeChangeCapture {
  const capture: WorktreeChangeCapture = { changedFiles: 0 };
  try {
    if (!host.exists(worktreeRoot)) return capture;
    // Stage everything (tracked edits, new files, deletions) so the patch is
    // COMPLETE. `.gitignore` is still honored, so node_modules/build output
    // stays out — the patch only carries real source changes.
    host.runGit(worktreeRoot, ['add', '-A']);
    const baseRef = opts.baseRef?.trim() || 'HEAD';
    const names = host.runGit(worktreeRoot, ['diff', '--cached', '--name-only', baseRef]);
    if (!names.ok || !names.stdout.trim()) return capture;
    capture.changedFiles = names.stdout.split(/\r?\n/).filter(Boolean).length;

    // Full, binary-safe patch — used for both persistence and apply. Never capped.
    const fullRes = host.runGit(worktreeRoot, ['diff', '--cached', '--binary', baseRef]);
    const fullPatch = fullRes.ok ? fullRes.stdout : '';
    if (fullPatch.trim() && opts.patchFile) {
      try {
        host.mkdir(path.dirname(opts.patchFile));
        host.writeText(opts.patchFile, fullPatch);
        capture.patchPath = opts.patchFile;
      } catch { /* persistence is best-effort */ }
    }

    // Human preview: plain text diff, uncapped here (callers cap).
    const previewRes = host.runGit(worktreeRoot, ['diff', '--cached', baseRef]);
    capture.preview = (previewRes.ok ? previewRes.stdout : names.stdout).trim();
  } catch { /* capture is best-effort — never throw at teardown/archive time */ }
  return capture;
}

/**
 * MC-A6 — provision a NEW detached worktree of `parentWorkspaceRoot`'s repo
 * at an arbitrary `ref` (default HEAD), under the same worktree base the
 * child isolation uses (`cli.worktreeRoot` knob honored). Backs
 * resume-from-archive, which recreates a tree at the archived base commit.
 * Unlike `prepareChildWorkspace`, an already-existing directory for
 * `childId` is a failure (never adopt someone else's tree). Returns null
 * when the workspace isn't a git repo or git refuses.
 */
export function createDetachedWorktree(
  parentWorkspaceRoot: string,
  childId: string,
  ref = 'HEAD',
): { sourceRoot: string; worktreeRoot: string; baseOid: string } | null {
  let root: string;
  try {
    root = host.realpath(parentWorkspaceRoot);
  } catch {
    return null;
  }
  const repoRoot = gitRoot(root);
  if (!repoRoot || !isInside(repoRoot, root)) return null;
  const worktreeRoot = defaultWorktreePath(repoRoot, childId);
  if (host.exists(worktreeRoot)) return null;
  try {
    host.mkdir(path.dirname(worktreeRoot));
  } catch {
    return null;
  }
  const base = host.runGit(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`]);
  if (!base.ok || !/^[a-f0-9]{40,64}$/i.test(base.stdout.trim())) return null;
  const baseOid = base.stdout.trim();
  const created = host.runGit(repoRoot, ['worktree', 'add', '--detach', worktreeRoot, baseOid]);
  if (!created.ok) return null;
  let real = worktreeRoot;
  try { real = host.realpath(worktreeRoot); } catch { /* use the raw path */ }
  return { sourceRoot: repoRoot, worktreeRoot: real, baseOid };
}

/**
 * ADR-042 S4 (D3) — create a NAMED-branch worktree under worktreeBase(). Unlike
 * createDetachedWorktree (which mints detached HEADs for child isolation), this
 * is what "a feature lives in a worktree" needs: a branch first, the worktree as
 * its home. Returns the created path + branch, or `{ error }` carrying git's
 * reason. The branch name is metacharacter-checked before it reaches git.
 */
export function createNamedWorktree(
  parentWorkspaceRoot: string,
  branch: string,
  fromRef = 'HEAD',
): { repoRoot: string; worktreeRoot: string; branch: string } | { error: string } {
  const name = String(branch ?? '').trim();
  if (!name) return { error: 'A branch name is required.' };
  if (name.startsWith('-') || name.startsWith('/') || name.includes('..') || /[\s~^:?*\[\]\\]/.test(name)) return { error: `Invalid branch name: ${branch}` };
  let root: string;
  try { root = host.realpath(parentWorkspaceRoot); } catch { return { error: 'Workspace path cannot be resolved.' }; }
  const repoRoot = gitRoot(root);
  if (!repoRoot) return { error: 'Not a git repository — cannot create a worktree.' };
  const worktreeRoot = path.join(worktreeBase(), safeName(path.basename(repoRoot)), safeName(name));
  if (host.exists(worktreeRoot)) return { error: `A worktree directory already exists at ${worktreeRoot}.` };
  const base = host.runGit(repoRoot, ['rev-parse', '--verify', `${fromRef}^{commit}`]);
  if (!base.ok || !/^[a-f0-9]{40,64}$/i.test(base.stdout.trim())) return { error: `Cannot resolve --from ref: ${fromRef}` };
  try { host.mkdir(path.dirname(worktreeRoot)); } catch { /* best-effort; git errors if truly unwritable */ }
  const created = host.runGit(repoRoot, ['worktree', 'add', '-b', name, worktreeRoot, base.stdout.trim()]);
  if (!created.ok) return { error: created.stderr.trim() || `git worktree add failed for branch ${name}.` };
  let real = worktreeRoot;
  try { real = host.realpath(worktreeRoot); } catch { /* raw path */ }
  return { repoRoot, worktreeRoot: real, branch: name };
}

/**
 * ADR-042 S4 (D3) — remove a worktree via `git worktree remove`. Git refuses to
 * remove a DIRTY worktree unless force is set, so uncommitted work is preserved
 * by default; the caller (worktree_done) surfaces the dirt and routes removal
 * through the destructive-command guard before calling this. Never `--force`s
 * on its own.
 */
export function removeWorktreeAt(
  parentWorkspaceRoot: string,
  worktreePath: string,
  opts: { force?: boolean } = {},
): { ok: boolean; error?: string } {
  let root: string;
  try { root = host.realpath(parentWorkspaceRoot); } catch { return { ok: false, error: 'Workspace path cannot be resolved.' }; }
  const repoRoot = gitRoot(root);
  if (!repoRoot) return { ok: false, error: 'Not a git repository.' };
  const args = ['worktree', 'remove'];
  if (opts.force) args.push('--force');
  args.push(worktreePath);
  const r = host.runGit(repoRoot, args);
  if (!r.ok) return { ok: false, error: r.stderr.trim() || 'git worktree remove failed.' };
  return { ok: true };
}

/**
 * Capture a child worktree's changes, optionally merge them back onto the parent
 * tree, then remove the worktree. This is BOTH halves of the isolation contract:
 *
 *  - capture — stage everything (incl. untracked + deletions; `.gitignore` still
 *    excludes build artifacts) and record a capped preview, a changed-file count,
 *    and a FULL binary-safe recovery patch persisted to `patchFile`. Nothing is
 *    silently lost — the complete patch survives the worktree's removal.
 *  - merge-back — when `applyBack` is set (the child finished cleanly), the
 *    persisted patch is `git apply --check`'d and, only if it applies cleanly,
 *    applied onto the parent working tree. A drifted/conflicting patch is left
 *    on disk for a manual apply rather than smearing conflict markers into the
 *    user's tree.
 *
 * Without the removal half, isolated children leaked worktree dirs under
 * `$TMPDIR/brainrouter-worktrees/` forever and `git worktree list` drifted from
 * the filesystem. Best-effort + never throws — cleanup must not break teardown.
 */
export function removeChildWorktree(
  isolation: ChildWorktreeIsolation | null | undefined,
  opts: RemoveChildWorktreeOptions = {},
): RemoveChildWorktreeResult {
  if (!isolation || isolation.kind !== 'git-worktree') return { ok: true };
  const maxDiffChars = opts.maxDiffChars ?? 4000;
  const { sourceRoot, worktreeRoot } = isolation;
  let diff: string | undefined;
  let changedFiles: number | undefined;
  let patchPath: string | undefined;
  let applied: boolean | undefined;
  let applyError: string | undefined;
  let recoveryRef: string | undefined;

  try {
    if (host.exists(worktreeRoot)) {
      // Capture via the shared recovery-patch writer (also used by MC-A6
      // workspace archiving): stage + count + persist the full binary patch.
      const capture = captureWorktreeChanges(worktreeRoot, { patchFile: opts.patchFile });
      if (capture.changedFiles > 0) {
        changedFiles = capture.changedFiles;
        patchPath = capture.patchPath;

        // Human preview: plain text diff, capped (pointing at the full patch).
        const body = capture.preview ?? '';
        diff = body.length > maxDiffChars
          ? `${body.slice(0, maxDiffChars)}\n… [diff truncated${patchPath ? ` — full patch at ${patchPath}` : ''}]`
          : body;

        // Merge-back: apply the child's work onto the parent tree on clean exit.
        // Check first so a non-applying patch never mutates the parent tree.
        if (opts.applyBack && patchPath) {
          const check = host.runGit(sourceRoot, ['apply', '--check', '--whitespace=nowarn', patchPath]);
          if (check.ok) {
            const applyRes = host.runGit(sourceRoot, ['apply', '--whitespace=nowarn', patchPath]);
            applied = applyRes.ok;
            if (!applyRes.ok) applyError = applyRes.stderr.trim() || 'git apply failed';
          } else {
            applied = false;
            applyError = check.stderr.trim() || 'patch does not apply cleanly to the parent tree';
          }
        }
      }
    }
  } catch { /* capture/apply is best-effort — never block teardown */ }

  // Preserve committed work before destructive removal. A detached child may
  // have created commits that are not reachable from the parent branch; pin
  // those commits under a CAS-created recovery ref. If that proof/write fails,
  // retain the whole worktree rather than relying on reflog luck.
  if (host.exists(worktreeRoot)) {
    const childHead = host.runGit(worktreeRoot, ['rev-parse', '--verify', 'HEAD']);
    const parentHead = host.runGit(sourceRoot, ['rev-parse', '--verify', 'HEAD']);
    if (childHead.ok && parentHead.ok && childHead.stdout.trim() !== parentHead.stdout.trim()) {
      const head = childHead.stdout.trim();
      const preserved = host.runGit(sourceRoot, ['merge-base', '--is-ancestor', head, parentHead.stdout.trim()]);
      if (!preserved.ok) {
        recoveryRef = `refs/brainrouter/recovery/${safeName(path.basename(worktreeRoot))}-${head.slice(0, 12)}`;
        const zero = '0'.repeat(head.length);
        const pinned = host.runGit(sourceRoot, ['update-ref', recoveryRef, head, zero]);
        if (!pinned.ok) {
          return {
            ok: false, diff, changedFiles, patchPath, applied, applyError,
            notice: `Worktree retained: could not prove or create a recovery ref for committed HEAD ${head.slice(0, 12)}.`,
          };
        }
      }
    }
  }

  // Remove the worktree, then prune the admin entry so `git worktree list` stays honest.
  const removed = host.runGit(sourceRoot, ['worktree', 'remove', '--force', worktreeRoot]);
  if (!removed.ok) {
    return {
      ok: false, diff, changedFiles, patchPath, applied, applyError, recoveryRef,
      notice: `Worktree retained because git worktree remove failed: ${removed.stderr.trim() || 'non-zero exit'}`,
    };
  }
  host.runGit(sourceRoot, ['worktree', 'prune']);
  return {
    ok: true,
    diff,
    changedFiles,
    patchPath,
    applied,
    applyError,
    recoveryRef,
  };
}

/**
 * CODEX-WORKTREE-MERGEBACK (A2) — manually apply a persisted recovery patch onto
 * a tree (backs `/agents diff <id> apply`). Gated by `git apply --check` first so
 * a non-applying patch never mutates the tree (no smeared conflict markers).
 * Returns `ok` + a human reason on failure; never throws.
 */
export function applyPatchFile(cwd: string, patchFile: string): { ok: boolean; error?: string } {
  try {
    if (!host.exists(patchFile)) return { ok: false, error: 'patch file not found' };
    const check = host.runGit(cwd, ['apply', '--check', '--whitespace=nowarn', patchFile]);
    if (!check.ok) return { ok: false, error: check.stderr.trim() || 'patch does not apply cleanly' };
    const applied = host.runGit(cwd, ['apply', '--whitespace=nowarn', patchFile]);
    return applied.ok ? { ok: true } : { ok: false, error: applied.stderr.trim() || 'git apply failed' };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'git apply threw' };
  }
}

/**
 * Reconcile: prune git's stale worktree admin entries and delete any leftover
 * `<worktreeBase>/<repo>/*` dirs that git no longer tracks (orphans from a crashed
 * prior process). Best-effort; returns how many dirs it removed. Mirrors
 * `reconcileStale` for session records.
 *
 * CRITICAL — `opts.keepChildIds` MUST list every LIVE (running/pending) child id so
 * their worktrees are NEVER GC'd. This runs on the periodic background refresh, not
 * just at startup, so without the guard a transient git-tracking miss (a freshly
 * `git worktree add`ed worktree not yet in `worktree list`, a sibling terminal on the
 * same repo, or a prune race) would delete a RUNNING child's worktree out from under
 * it — the child then ENOENTs on every tool call until the agent loop fails.
 */
export function reconcileOrphanWorktrees(workspaceRoot: string, opts?: { keepChildIds?: Iterable<string> }): number {
  let removed = 0;
  try {
    const repoRoot = gitRoot(workspaceRoot);
    if (!repoRoot) return 0;
    host.runGit(repoRoot, ['worktree', 'prune']);
    const base = path.join(worktreeBase(), safeName(path.basename(repoRoot)));
    if (!host.exists(base)) return 0;
    const tracked = new Set(
      (host.runGit(repoRoot, ['worktree', 'list', '--porcelain']).stdout.match(/^worktree (.+)$/gm) ?? [])
        .map((l) => l.replace(/^worktree /, '').trim()),
    );
    // Live children's worktree dir names (the dir basename is `safeName(childId)`),
    // by both the raw id and its sanitized form — never GC these.
    const keep = new Set<string>();
    for (const id of opts?.keepChildIds ?? []) { keep.add(id); keep.add(safeName(id)); }
    for (const entry of host.readDirectory(base)) {
      if (keep.has(entry)) continue; // a live child owns this worktree — leave it alone
      const dir = path.join(base, entry);
      let real = dir;
      try { real = host.realpath(dir); } catch { /* use dir */ }
      if (!tracked.has(real) && !tracked.has(dir)) {
        try { host.removeTree(dir); removed++; } catch { /* noop */ }
      }
    }
  } catch { /* best-effort */ }
  return removed;
}
