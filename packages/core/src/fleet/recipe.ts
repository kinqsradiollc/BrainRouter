/**
 * HONK-H3.2 — "recipe" fleet build: run a deterministic command (a codemod, a
 * dependency bump, a formatter) in a repo and deliver the result as a PR. This is
 * the migration executor that does NOT need the LLM agent runtime — the unit of
 * work is a shell command, so it composes with `makeFleetBuildExecutor` by being a
 * `runBuild` implementation.
 *
 * Isolation is the whole point: the command runs in a throwaway git worktree off
 * the repo's HEAD, and the diff is captured with `applyBack:false` — the user's
 * working tree is never touched, no matter what the command does. A failed command
 * throws (→ the queue's backoff/retry); a command that changed nothing is a skip.
 *
 * The command RUNNER is a required injected dependency (no default): unattended
 * fleet work must run under a sandbox, so the caller (CLI/host) supplies a sandboxed
 * runner rather than this leaf module silently shelling out unconfined.
 */
import {
  prepareSharedWorktree,
  removeChildWorktree,
  worktreePatchFile,
  type ChildWorktreeIsolation,
  type RemoveChildWorktreeOptions,
  type RemoveChildWorktreeResult,
} from '../worktree/worktreeIsolation.js';
import type { FleetJobRecord } from './fleetStore.js';
import type { FleetBuildResult, FleetBuildSkip } from './executors.js';

export interface RecipeRunCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface RecipeRunBuildDeps {
  /**
   * REQUIRED. Run `command` in `cwd` (the isolated worktree) and report success.
   * The caller is responsible for sandboxing — this module never provides an
   * unconfined default for unattended execution.
   */
  runCommand: (command: string, cwd: string) => RecipeRunCommandResult;
  /** Create the isolated worktree (default: `prepareSharedWorktree`). */
  prepareWorktree?: (
    repo: string,
    label: string,
  ) => { workspaceRoot: string; isolation: ChildWorktreeIsolation } | null;
  /** Capture the diff + tear down the worktree (default: `removeChildWorktree`). */
  removeWorktree?: (isolation: ChildWorktreeIsolation, opts: RemoveChildWorktreeOptions) => RemoveChildWorktreeResult;
  /** Where to persist the recovery patch (default: `worktreePatchFile`). */
  patchFileFor?: (repo: string, childId: string) => string;
}

/** A job's recipe input. `command` is the only required field. */
export interface FleetRecipeInput {
  command: string;
  slug?: string;
  title?: string;
  body?: string;
  baseBranch?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v : undefined;
}

/**
 * Build a `runBuild` (for `makeFleetBuildExecutor`) that runs the job's recipe
 * command in an isolated worktree and yields a patch — or a skip when there is
 * nothing to ship. Throws when the command fails so the queue retries it.
 */
export function makeRecipeRunBuild(
  deps: RecipeRunBuildDeps,
): (job: FleetJobRecord) => Promise<FleetBuildResult | FleetBuildSkip> {
  const prepare = deps.prepareWorktree ?? prepareSharedWorktree;
  const remove = deps.removeWorktree ?? removeChildWorktree;
  const patchFileFor = deps.patchFileFor ?? worktreePatchFile;

  return async (job: FleetJobRecord): Promise<FleetBuildResult | FleetBuildSkip> => {
    const repo = job.workspaceRoot;
    const command = str((job.input as Partial<FleetRecipeInput>).command);
    if (!command) return { skipped: 'no-command' };

    const prep = prepare(repo, job.id);
    if (!prep) return { skipped: 'not-a-git-repo' };

    let removal: RemoveChildWorktreeResult;
    let cmd: RecipeRunCommandResult;
    try {
      cmd = deps.runCommand(command, prep.workspaceRoot);
    } finally {
      // Always tear the worktree down (capture-only) so a thrown command can't
      // leak a worktree. patchFile is keyed on the job id for traceability.
      removal = remove(prep.isolation, { applyBack: false, patchFile: patchFileFor(repo, job.id) });
    }

    if (!cmd.ok) throw new Error(`fleet recipe command failed: ${(cmd.stderr || cmd.stdout || '').slice(0, 300)}`);
    if (!removal.changedFiles || !removal.patchPath) return { skipped: 'no-changes' };

    const input = job.input as Partial<FleetRecipeInput>;
    const slug = str(input.slug) ?? 'fleet-migration';
    return {
      sourceRoot: prep.isolation.sourceRoot,
      patchPath: removal.patchPath,
      slug,
      title: str(input.title) ?? `Fleet migration (${slug})`,
      body:
        str(input.body) ??
        `Automated fleet migration in \`${repo}\`.\n\n- Recipe: \`${command}\`\n- Files changed: ${removal.changedFiles}\n- Delivered as a PR for review.`,
      baseBranch: str(input.baseBranch),
    };
  };
}
