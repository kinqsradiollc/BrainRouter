/**
 * HONK-H1 (0.4.x) — emit a real GitHub Pull Request from a finished build loop.
 *
 * The "Honk" fleet-agent model delivers a bounded coding agent's work as a PR for
 * review, NOT by merging into the user's working tree. After a `/build` whose
 * Verify is green and Review has no blocker, `finalizeBuildLoop` captures the work
 * as a full binary patch; this module takes that patch and:
 *
 *   1. creates a FRESH detached worktree on a new branch off the base branch,
 *   2. applies the patch there, commits, and pushes the branch to `origin`,
 *   3. opens a PR with `gh pr create`,
 *   4. removes the throwaway worktree.
 *
 * The user's working tree is never touched (that's the whole point — it avoids the
 * workspace-reset hazard of mutating the active branch). If anything fails (no
 * `gh`, no GitHub remote, push/auth error) the caller falls back to the normal
 * merge-back so the work is never lost. Every shell-out passes an argv array (no
 * shell string), so agent-derived titles/bodies/branch names can't inject.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getBrainrouterHome } from '../storage/store.js';
import { parseGitHubRemote, slugifyBranchPart } from '../track/gitWorkflow.js';

/** Injectable command runner so tests can drive the flow without real git/gh. */
export type CmdRunner = (
  cmd: string,
  args: string[],
  cwd: string,
) => { ok: boolean; stdout: string; stderr: string };

export const defaultCmdRunner: CmdRunner = (cmd, args, cwd) => {
  const res = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
    maxBuffer: 16_000_000,
  });
  return {
    ok: res.status === 0 && !res.error,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? res.error?.message ?? '',
  };
};

export interface EmitPrInput {
  /** The git repository root (the worktree's `sourceRoot`). */
  sourceRoot: string;
  /** Full binary patch produced by the build worktree (from `removeChildWorktree`). */
  patchPath: string;
  /** Workflow slug — seeds the branch name and the default PR title. */
  slug: string;
  /** PR title (already derived by the caller). */
  title: string;
  /** PR body (already derived by the caller). */
  body: string;
  /** Base branch override; when absent the repo's current branch is used. */
  baseBranch?: string;
}

export interface EmitPrResult {
  ok: boolean;
  prUrl?: string;
  prNumber?: number;
  branch?: string;
  pushed?: boolean;
  /** Why the emit was a no-op / declined (distinct from a hard error). */
  skipped?: 'no-gh' | 'no-remote' | 'no-patch' | 'base-unknown';
  error?: string;
}

/** `true` when the GitHub CLI is installed and on PATH. */
export function isGhAvailable(run: CmdRunner = defaultCmdRunner, cwd: string = process.cwd()): boolean {
  return run('gh', ['--version'], cwd).ok;
}

/**
 * Deterministic, git-safe branch name: `honk/<slug>-<8 hex of patch>`. Hashing the
 * patch keeps re-runs that produced the SAME change on the same branch (idempotent
 * PR updates) while distinct work gets a distinct branch.
 */
export function prBranchName(slug: string, patchContent: string): string {
  const hash = createHash('sha1').update(patchContent).digest('hex').slice(0, 8);
  return `honk/${slugifyBranchPart(slug)}-${hash}`;
}

/** First meaningful line of the implement output, else `Build: <slug>`. Capped at 72 chars. */
export function derivePrTitle(slug: string, implementOutput: string): string {
  const firstLine = (implementOutput ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^[#>*\-\s]+/, '').trim())
    .find((l) => l.length > 0);
  const base = firstLine && firstLine.length >= 8 ? firstLine : `Build: ${slug}`;
  return base.length > 72 ? `${base.slice(0, 69)}…` : base;
}

/** PR body: a short provenance header + the review summary (capped). */
export function derivePrBody(opts: {
  slug: string;
  verifyGreen: boolean;
  changedFiles: number;
  reviewOutput?: string;
}): string {
  const review = (opts.reviewOutput ?? '').trim();
  const reviewBlock = review ? `\n\n### Review summary\n\n${review.slice(0, 3000)}` : '';
  return (
    `Automated PR from BrainRouter's build loop (\`${opts.slug}\`).\n\n` +
    `- Verify: ${opts.verifyGreen ? '✅ green' : '⚠️ not green'}\n` +
    `- Files changed: ${opts.changedFiles}\n` +
    `- Delivered as a PR for review — not merged into the working tree.` +
    reviewBlock +
    `\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`
  );
}

/** Parse the PR URL + number from `gh pr create` stdout (it prints the URL). */
export function parsePrUrl(stdout: string): { url?: string; number?: number } {
  const url = (stdout.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/) ?? [])[0];
  if (!url) return {};
  const num = Number(url.match(/\/pull\/(\d+)/)?.[1]);
  return { url, number: Number.isFinite(num) ? num : undefined };
}

/** Resolve the base branch: explicit override → current branch → undefined. */
function resolveBaseBranch(run: CmdRunner, sourceRoot: string, override?: string): string | undefined {
  if (override && override.trim()) return override.trim();
  const cur = run('git', ['branch', '--show-current'], sourceRoot);
  const branch = cur.ok ? cur.stdout.trim() : '';
  return branch || undefined;
}

/** Throwaway worktree path for the PR branch (sibling of the build worktrees). */
function prWorktreePath(branch: string): string {
  const safe = branch.replace(/[^a-zA-Z0-9._-]+/g, '-');
  return path.join(getBrainrouterHome(), 'worktrees', '_pr', safe);
}

/**
 * Emit a PR from a captured patch. Pure-orchestration over the injected runner —
 * never throws; returns a structured result the caller turns into an outcome.
 */
export function emitPrFromPatch(input: EmitPrInput, run: CmdRunner = defaultCmdRunner): EmitPrResult {
  const { sourceRoot, patchPath, slug, title, body, baseBranch } = input;

  if (!patchPath || !fs.existsSync(patchPath)) return { ok: false, skipped: 'no-patch' };
  if (!isGhAvailable(run, sourceRoot)) return { ok: false, skipped: 'no-gh', error: 'GitHub CLI (gh) not found on PATH' };

  // Require a GitHub remote — without one there's nothing to open a PR against.
  const remote = run('git', ['remote', 'get-url', 'origin'], sourceRoot);
  const gh = remote.ok ? parseGitHubRemote(remote.stdout.trim()) : undefined;
  if (!gh) return { ok: false, skipped: 'no-remote', error: 'origin is not a GitHub remote' };

  const base = resolveBaseBranch(run, sourceRoot, baseBranch);
  if (!base) return { ok: false, skipped: 'base-unknown', error: 'could not resolve a base branch (detached HEAD?)' };

  let patch: string;
  try {
    patch = fs.readFileSync(patchPath, 'utf8');
  } catch (err: any) {
    return { ok: false, error: `could not read patch: ${err?.message ?? err}` };
  }
  if (!patch.trim()) return { ok: false, skipped: 'no-patch' };

  const branch = prBranchName(slug, patch);
  const wt = prWorktreePath(branch);

  // Clean any stale worktree dir from a prior aborted emit on this exact branch.
  run('git', ['worktree', 'remove', '--force', wt], sourceRoot);
  try { if (fs.existsSync(wt)) fs.rmSync(wt, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.mkdirSync(path.dirname(wt), { recursive: true }); } catch { /* best-effort */ }

  const cleanup = (): void => {
    run('git', ['worktree', 'remove', '--force', wt], sourceRoot);
    run('git', ['worktree', 'prune'], sourceRoot);
  };

  // Fresh branch off the base, isolated from the user's working tree.
  const add = run('git', ['worktree', 'add', '-b', branch, wt, base], sourceRoot);
  if (!add.ok) {
    // Branch may already exist (idempotent re-run) → check it out without -b.
    const reuse = run('git', ['worktree', 'add', wt, branch], sourceRoot);
    if (!reuse.ok) { cleanup(); return { ok: false, branch, error: `git worktree add failed: ${add.stderr.trim()}` }; }
  }

  const apply = run('git', ['apply', '--whitespace=nowarn', patchPath], wt);
  if (!apply.ok) { cleanup(); return { ok: false, branch, error: `git apply failed: ${apply.stderr.trim()}` }; }

  run('git', ['add', '-A'], wt);
  const commit = run('git', ['commit', '-m', title, '-m', body], wt);
  if (!commit.ok && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
    cleanup();
    return { ok: false, branch, error: `git commit failed: ${commit.stderr.trim()}` };
  }

  const push = run('git', ['push', '-u', 'origin', branch], wt);
  if (!push.ok) { cleanup(); return { ok: false, branch, pushed: false, error: `git push failed: ${push.stderr.trim()}` }; }

  const pr = run('gh', ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', body], wt);
  cleanup();
  if (!pr.ok) {
    return { ok: false, branch, pushed: true, error: `gh pr create failed: ${pr.stderr.trim() || pr.stdout.trim()}` };
  }
  const { url, number } = parsePrUrl(pr.stdout);
  return { ok: true, branch, pushed: true, prUrl: url, prNumber: number };
}
