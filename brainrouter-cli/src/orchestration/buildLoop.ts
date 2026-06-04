/**
 * BUILD-LOOP P2 (0.4.12) — the merge gate for a `build` workflow run.
 *
 * A build run's implement → verify → review phases all execute in ONE shared
 * worktree `W` (allocated by `run_workflow` via `prepareSharedWorktree`, passed
 * to every child as `workspaceRootOverride`). After the phases finish, this gates
 * the merge: `W` is applied onto the user's tree only when **verify looks green
 * AND review has no blocker**. Otherwise the work is preserved as a recovery
 * patch (the 0.4.11 no-loss fallback) the user can apply via `/agents diff` /
 * `git apply` — nothing half-merged ever lands in the tree.
 */
import path from 'node:path';
import { removeChildWorktree, type ChildWorktreeIsolation } from './worktreeIsolation.js';
import { getCliStateDir } from '../state/cliState.js';
import type { PhasePlanExecution } from './phaseOrchestrator.js';

export interface BuildLoopMergeOutcome {
  merged: boolean;
  verifyGreen: boolean;
  reviewApproved: boolean;
  changedFiles?: number;
  patchPath?: string;
  applyError?: string;
  reason: string;
}

/** The verifier role reports PASS / FAIL; treat an explicit failure as not-green. */
export function verifyLooksGreen(output: string): boolean {
  const raw = output ?? '';
  const t = raw.toLowerCase();
  if (/\bfail(ed|ing|ure|s)?\b/.test(t) || /\bverdict[:=]?\s*fail/.test(t) || /✗|✘/.test(raw)) return false;
  return /\bpass(ed|ing|es)?\b/.test(t) || /\bverdict[:=]?\s*pass/.test(t) || /\b(all|tests?)\b.*\b(green|ok)\b/.test(t) || /✓|✔/.test(raw);
}

/** A review that flags a `blocker` finding blocks the auto-merge. */
export function reviewHasBlocker(output: string): boolean {
  return /\bblocker\b/i.test(output ?? '');
}

export function finalizeBuildLoop(
  workspaceRoot: string,
  slug: string,
  shared: { isolation: ChildWorktreeIsolation },
  execution: PhasePlanExecution,
): BuildLoopMergeOutcome {
  const phaseOutput = (id: string) => execution.phases.find((p) => p.id === id)?.output ?? '';
  // No verify phase in the plan → "didn't fail" counts as green.
  const verifyPhase = execution.phases.find((p) => p.id === 'verify');
  const verifyGreen = verifyPhase ? verifyLooksGreen(verifyPhase.output) : true;
  const reviewApproved = !reviewHasBlocker(phaseOutput('review'));
  const apply = verifyGreen && reviewApproved;

  const patchFile = path.join(getCliStateDir(workspaceRoot), 'worktree-patches', `build-${slug}.patch`);
  const cleanup = removeChildWorktree(shared.isolation, { applyBack: apply, patchFile });
  const merged = apply && cleanup.applied === true;

  let reason: string;
  if (!apply) {
    const why = [!verifyGreen ? 'verify not green' : null, !reviewApproved ? 'review has a blocker' : null].filter(Boolean).join(' + ');
    reason = `merge gated (${why}) — ${cleanup.changedFiles ?? 0} file(s) preserved as a patch (apply with /agents diff or git apply)`;
  } else if (merged) {
    reason = `verify green + review ok → merged ${cleanup.changedFiles ?? 0} file(s) into your tree`;
  } else {
    reason = `gate passed but the patch did not apply cleanly (${cleanup.applyError ?? 'conflict'}) — work preserved as a patch`;
  }

  return {
    merged,
    verifyGreen,
    reviewApproved,
    changedFiles: cleanup.changedFiles,
    patchPath: cleanup.patchPath,
    applyError: cleanup.applyError,
    reason,
  };
}
