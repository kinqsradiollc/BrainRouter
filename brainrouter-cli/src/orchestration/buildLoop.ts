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
  const lower = raw.toLowerCase();
  // "0 failed", "no failures", "zero failing", "failures: 0" / "failed = 0" are
  // explicit SUCCESS signals — count them as green AND strip them before the
  // failure check so they don't read as red (the false-negative this guards).
  const benignNoFailure =
    /\b(?:0|no|zero)\s+fail(?:ed|ing|ures?|s)?\b/.test(lower) ||
    /\bfail(?:ed|ing|ures?|s)?\s*[:=]\s*0\b/.test(lower);
  const t = lower
    .replace(/\b(?:0|no|zero)\s+fail(?:ed|ing|ures?|s)?\b/g, ' ')
    .replace(/\bfail(?:ed|ing|ures?|s)?\s*[:=]\s*0\b/g, ' ');
  // A real failure token surviving the strip (e.g. "1 failed") is still red.
  if (/\bfail(ed|ing|ure|s)?\b/.test(t) || /\bverdict[:=]?\s*fail/.test(t) || /✗|✘/.test(raw)) return false;
  return (
    benignNoFailure ||
    /\bpass(ed|ing|es)?\b/.test(t) ||
    /\bverdict[:=]?\s*pass/.test(t) ||
    /\bsucceed(ed)?\b/.test(t) ||
    /\bsuccess(ful(ly)?)?\b/.test(t) ||
    /\b(all|tests?)\b.*\b(green|ok)\b/.test(t) ||
    /✓|✔/.test(raw)
  );
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

  // Unique patch name per finalize so a preserved recovery patch from an earlier
  // run with the SAME slug is never silently overwritten.
  const patchFile = path.join(getCliStateDir(workspaceRoot), 'worktree-patches', `build-${slug}-${Date.now().toString(36)}.patch`);
  const cleanup = removeChildWorktree(shared.isolation, { applyBack: apply, patchFile });
  // No diff + no persisted patch ⇒ the build produced no file changes; a gate-pass
  // here is a clean no-op (NOT a failed apply). `removeChildWorktree` only sets
  // `applied` when there was a patch to apply, so distinguish the cases explicitly.
  const noChanges = (cleanup.changedFiles ?? 0) === 0 && !cleanup.patchPath;
  const merged = apply && (cleanup.applied === true || noChanges);

  let reason: string;
  if (!apply) {
    const why = [!verifyGreen ? 'verify not green' : null, !reviewApproved ? 'review has a blocker' : null].filter(Boolean).join(' + ');
    reason = `merge gated (${why}) — ${cleanup.changedFiles ?? 0} file(s) preserved as a patch (apply with /agents diff or git apply)`;
  } else if (noChanges) {
    reason = 'verify green + review ok → no file changes to merge (clean no-op)';
  } else if (cleanup.applied === true) {
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
