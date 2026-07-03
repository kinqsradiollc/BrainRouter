/**
 * HONK-H1 (0.4.x) — emit a real GitHub Pull Request from a finished build loop.
 *
 * The "Honk" fleet-agent model delivers a bounded coding agent's work as a PR for
 * review, NOT by merging into the user's working tree. After a `/build` whose
 * Verify is green and Review has no blocker, `finalizeBuildLoop` captures the work
 * as a full binary patch; this module takes that patch and:
 *
 *   1. creates a FRESH detached worktree on a UNIQUE `honk/<slug>-<hash>-<run>`
 *      branch off the base branch,
 *   2. applies the patch there, commits, and pushes the branch to `origin`,
 *   3. opens a DRAFT PR with `gh pr create` (a human reviews before merge),
 *   4. removes the throwaway worktree.
 *
 * The user's working tree is never touched (that's the whole point — it avoids the
 * workspace-reset hazard of mutating the active branch). If anything fails (no
 * `gh`, no GitHub remote, push/auth error) the caller falls back to the normal
 * merge-back so the work is never lost.
 *
 * Safety properties (see the H1 review):
 *  - Every shell-out passes an argv array (no shell string), and the base ref +
 *    branch are validated against a safe-ref allowlist, so agent-/config-derived
 *    values can neither inject a command nor flip a git flag (no leading `-`).
 *  - The branch carries a per-run token, so a re-run never reuses an existing
 *    branch (which would fail `git apply` and silently fall back to mutating the
 *    user's tree).
 *  - Interactive credential prompts are disabled (`GIT_TERMINAL_PROMPT=0`,
 *    `GH_PROMPT_DISABLED=1`) so a missing/expired auth fails fast instead of
 *    hanging the synchronous reply path.
 *  - Agent-authored text (PR title/body) and command stderr are run through a
 *    secret redactor before they leave the machine or surface to the user.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getBrainrouterHome } from '../storage/store.js';
import { parseGitHubRemote, slugifyBranchPart } from '../track/git/index.js';

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
    timeout: 45_000,
    maxBuffer: 16_000_000,
    // Never block on an interactive credential / SSO prompt — fail fast so the
    // synchronous build-finalize path can't hang. (stdin is already 'ignore'.)
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
  });
  return {
    ok: res.status === 0 && !res.error,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? res.error?.message ?? '',
  };
};

/** Mask the secret shapes BrainRouter knows about before text leaves the machine. */
const SECRET_PATTERNS: RegExp[] = [
  /\bbr_[A-Za-z0-9._-]{8,}\b/g,
  /\bsk-[A-Za-z0-9._-]{8,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, // GitHub tokens
  /\b(api[_-]?key|secret|password|token|authorization|bearer)\b(\s*[:=]\s*|\s+)['"]?[A-Za-z0-9._\-/+]{6,}['"]?/gi,
];
export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (acc, re) => acc.replace(re, (m) => (/^(api|secret|password|token|author|bearer)/i.test(m) ? m.replace(/['"]?[A-Za-z0-9._\-/+]{6,}['"]?$/, '«redacted»') : '«redacted»')),
    value ?? '',
  );
}

/**
 * A git-ref that is safe to pass as a positional/option VALUE to git/gh: no
 * leading `-` (would be parsed as a flag), no whitespace/control chars, and none
 * of git's ref-format metacharacters. Used to gate the base branch (a user knob)
 * and the generated branch before either reaches a command line.
 */
export function isSafeRef(ref: string): boolean {
  if (!ref || ref.length > 240) return false;
  if (ref.startsWith('-') || ref.startsWith('/') || ref.endsWith('/')) return false;
  if (ref.includes('..') || ref.includes('@{')) return false;
  // eslint-disable-next-line no-control-regex
  return !/[\s~^:?*\[\\\x00-\x1f\x7f]/.test(ref);
}

export interface EmitPrInput {
  /** The git repository root (the worktree's `sourceRoot`). */
  sourceRoot: string;
  /** Full binary patch produced by the build worktree (from `removeChildWorktree`). */
  patchPath: string;
  /** Workflow slug — seeds the branch name and the default PR title. */
  slug: string;
  /** Per-run token making the branch unique (so re-runs never reuse a branch). */
  runToken: string;
  /** PR title (caller-derived; redacted again here as defense-in-depth). */
  title: string;
  /** PR body (caller-derived; redacted again here as defense-in-depth). */
  body: string;
  /** Base branch override; when absent the repo's current branch is used. */
  baseBranch?: string;
  /** Open the PR as a draft (default true — a human reviews before merge). */
  draft?: boolean;
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
 * Unique, git-safe branch name: `honk/<slug>-<6 hex of patch>-<runToken>`. The
 * patch-hash aids traceability; the per-run token guarantees uniqueness so a
 * re-run can never collide with an existing branch (which would make `git apply`
 * fail and silently degrade to mutating the user's tree).
 */
export function prBranchName(slug: string, patchContent: string, runToken: string): string {
  const hash = createHash('sha1').update(patchContent).digest('hex').slice(0, 6);
  const run = slugifyBranchPart(runToken).slice(0, 16) || 'run';
  return `honk/${slugifyBranchPart(slug)}-${hash}-${run}`;
}

/** First meaningful line of the implement output, else `Build: <slug>`. Capped at 72 chars, secret-redacted. */
export function derivePrTitle(slug: string, implementOutput: string): string {
  const firstLine = redactSecrets(implementOutput ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^[#>*\-\s]+/, '').trim())
    .find((l) => l.length > 0);
  const base = firstLine && firstLine.length >= 8 ? firstLine : `Build: ${slug}`;
  return base.length > 72 ? `${base.slice(0, 69)}…` : base;
}

/** PR body: a short provenance header + the (secret-redacted) review summary.
 *  CC-CONFIG-A5 — `attributionSessionUrl` (default true) appends a BrainRouter
 *  provenance footer; set false to omit it (private repos / clean history). */
export function derivePrBody(opts: {
  slug: string;
  verifyGreen: boolean;
  changedFiles: number;
  reviewOutput?: string;
  attributionSessionUrl?: boolean;
}): string {
  const review = redactSecrets((opts.reviewOutput ?? '').trim());
  const reviewBlock = review ? `\n\n### Review summary\n\n${review.slice(0, 3000)}` : '';
  const footer = opts.attributionSessionUrl === false
    ? ''
    : `\n\n— Generated by BrainRouter's build loop.`;
  return (
    `Automated PR from BrainRouter's build loop (\`${opts.slug}\`).\n\n` +
    `- Verify: ${opts.verifyGreen ? '✅ green' : '⚠️ not green'}\n` +
    `- Files changed: ${opts.changedFiles}\n` +
    `- Delivered as a PR for review — not merged into the working tree.` +
    reviewBlock +
    footer
  );
}

/** Parse the PR URL + number from `gh pr create` stdout (it prints the URL). */
export function parsePrUrl(stdout: string): { url?: string; number?: number } {
  const url = (stdout.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/) ?? [])[0];
  if (!url) return {};
  const num = Number(url.match(/\/pull\/(\d+)/)?.[1]);
  return { url, number: Number.isFinite(num) ? num : undefined };
}

/** Resolve the base branch: explicit override → current branch → undefined; validated as a safe ref. */
function resolveBaseBranch(run: CmdRunner, sourceRoot: string, override?: string): string | undefined {
  const explicit = override && override.trim();
  if (explicit) return isSafeRef(explicit) ? explicit : undefined;
  const cur = run('git', ['branch', '--show-current'], sourceRoot);
  const branch = cur.ok ? cur.stdout.trim() : '';
  return branch && isSafeRef(branch) ? branch : undefined;
}

/** Throwaway worktree path for the (unique) PR branch. */
function prWorktreePath(branch: string): string {
  const safe = branch.replace(/[^a-zA-Z0-9._-]+/g, '-');
  return path.join(getBrainrouterHome(), 'worktrees', '_pr', safe);
}

/**
 * Emit a PR from a captured patch. Pure-orchestration over the injected runner —
 * never throws; returns a structured result the caller turns into an outcome.
 */
export function emitPrFromPatch(input: EmitPrInput, run: CmdRunner = defaultCmdRunner): EmitPrResult {
  const { sourceRoot, patchPath, slug, runToken, baseBranch } = input;
  const title = redactSecrets(input.title);
  const body = redactSecrets(input.body);
  const redactErr = (s: string): string => redactSecrets((s ?? '').trim());

  if (!patchPath || !fs.existsSync(patchPath)) return { ok: false, skipped: 'no-patch' };
  if (!isGhAvailable(run, sourceRoot)) return { ok: false, skipped: 'no-gh', error: 'GitHub CLI (gh) not found on PATH' };

  // Require a GitHub remote — without one there's nothing to open a PR against.
  const remote = run('git', ['remote', 'get-url', 'origin'], sourceRoot);
  const gh = remote.ok ? parseGitHubRemote(remote.stdout.trim()) : undefined;
  if (!gh) return { ok: false, skipped: 'no-remote', error: 'origin is not a GitHub remote' };

  const base = resolveBaseBranch(run, sourceRoot, baseBranch);
  if (!base) return { ok: false, skipped: 'base-unknown', error: 'could not resolve a safe base branch (detached HEAD or unsafe ref?)' };

  let patch: string;
  try {
    patch = fs.readFileSync(patchPath, 'utf8');
  } catch (err: any) {
    return { ok: false, error: `could not read patch: ${redactErr(err?.message ?? String(err))}` };
  }
  if (!patch.trim()) return { ok: false, skipped: 'no-patch' };

  const branch = prBranchName(slug, patch, runToken);
  if (!isSafeRef(branch)) return { ok: false, error: 'generated branch name is not a safe ref' };
  const wt = prWorktreePath(branch);

  // The per-run token makes `branch`/`wt` unique, so there is no stale entry to
  // reuse — but clean defensively in case a prior emit with this exact token died.
  run('git', ['worktree', 'remove', '--force', wt], sourceRoot);
  try { if (fs.existsSync(wt)) fs.rmSync(wt, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.mkdirSync(path.dirname(wt), { recursive: true }); } catch { /* best-effort */ }

  const cleanup = (): void => {
    run('git', ['worktree', 'remove', '--force', wt], sourceRoot);
    run('git', ['worktree', 'prune'], sourceRoot);
  };

  // Fresh UNIQUE branch off the base, isolated from the user's working tree. No
  // reuse fallback: a unique branch should never already exist, and reusing one
  // would re-apply an already-committed patch (fails) → tree-mutation fallback.
  const add = run('git', ['worktree', 'add', '-b', branch, wt, base], sourceRoot);
  if (!add.ok) { cleanup(); return { ok: false, branch, error: `git worktree add failed: ${redactErr(add.stderr)}` }; }

  const apply = run('git', ['apply', '--whitespace=nowarn', patchPath], wt);
  if (!apply.ok) { cleanup(); return { ok: false, branch, error: `git apply failed: ${redactErr(apply.stderr)}` }; }

  run('git', ['add', '-A'], wt);
  const commit = run('git', ['commit', '-m', title, '-m', body], wt);
  if (!commit.ok && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
    cleanup();
    return { ok: false, branch, error: `git commit failed: ${redactErr(commit.stderr)}` };
  }

  const push = run('git', ['push', '-u', 'origin', branch], wt);
  if (!push.ok) { cleanup(); return { ok: false, branch, pushed: false, error: `git push failed: ${redactErr(push.stderr)}` }; }

  const createArgs = ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', body];
  if (input.draft !== false) createArgs.push('--draft');
  const pr = run('gh', createArgs, wt);
  cleanup();
  if (!pr.ok) {
    return { ok: false, branch, pushed: true, error: `gh pr create failed: ${redactErr(pr.stderr || pr.stdout)}` };
  }
  const { url, number } = parsePrUrl(pr.stdout);
  return { ok: true, branch, pushed: true, prUrl: url, prNumber: number };
}
