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
import fs from 'node:fs';
import path from 'node:path';
import { removeChildWorktree, applyPatchFile, type ChildWorktreeIsolation } from '../worktree/worktreeIsolation.js';
import { getStateDir } from '../storage/store.js';
import { parsePatchFiles, planSynthesisMerge, type WorktreeChangeSet } from './mergeGate.js';
import { normalizePhasePlan, type PhasePlan } from './phasePlan.js';
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

/**
 * BUILD-LOOP P5 (0.4.12) — the repair plan re-run when a build's Verify is red:
 * Implement → Verify → Review in the SAME shared worktree (the worker still has its
 * prior edits), with the verifier's failure fed to the worker. Static shape, so it
 * always validates. Pure.
 */
export function buildRepairPlan(verifyFailure: string, attempt: number): PhasePlan {
  const { plan } = normalizePhasePlan({
    title: `build-repair-${attempt}`,
    phases: [
      {
        id: 'implement',
        title: 'Repair',
        agents: [{
          role: 'worker',
          access: 'write',
          prompt: `The verifier reported a FAILURE on attempt ${attempt}:\n\n${verifyFailure}\n\nYou are in the worktree with your earlier changes intact. Diagnose and FIX the cause so the build + tests pass. Keep edits minimal and scoped. Report what you changed.`,
        }],
      },
      {
        id: 'verify',
        title: 'Verify',
        agents: [{
          role: 'verifier',
          access: 'shell',
          prompt: `What was just changed:\n\n{{input}}\n\nRe-run the project's build + the smallest useful test/typecheck set. Report a clear PASS/FAIL with evidence (commands, exit codes, trimmed failing output).`,
        }],
        inputFrom: ['implement'],
        dependsOn: ['implement'],
      },
      {
        id: 'review',
        title: 'Review',
        agents: [{
          role: 'reviewer',
          access: 'read',
          prompt: `The changes so far:\n\n{{input}}\n\nReview for correctness, regressions, and missed requirements. Findings-first, severity-ordered (blocker / major / minor / nit).`,
        }],
        inputFrom: ['implement'],
        dependsOn: ['implement'],
      },
    ],
  });
  // The static shape above always normalizes; the non-null assertion documents that.
  return plan!;
}

export interface RepairResult {
  execution: PhasePlanExecution;
  attempts: number;
  /** True when Verify ended green (either initially or after a repair). */
  green: boolean;
}

/**
 * BUILD-LOOP P5 — bounded loop-until-green. While Verify is red and repair budget
 * remains, re-run a repair plan (via `runPlan`, which executes it in the build's
 * shared worktree) and splice its Implement/Verify/Review outputs back over the
 * execution, so the final gate (`finalizeBuildLoop`) sees the latest state. Stops on
 * the first green Verify or when `maxRepairs` is exhausted. `maxRepairs <= 0` is a
 * no-op (the default — disabled). The actual phase execution is injected, so this is
 * unit-testable with a fake runner.
 */
export async function repairUntilGreen(
  initial: PhasePlanExecution,
  maxRepairs: number,
  runPlan: (plan: PhasePlan) => Promise<PhasePlanExecution>,
): Promise<RepairResult> {
  let execution = initial;
  let attempts = 0;
  const isGreen = (exec: PhasePlanExecution): boolean => {
    const verify = exec.phases.find((p) => p.id === 'verify');
    return verify ? verifyLooksGreen(verify.output) : true;
  };
  while (attempts < maxRepairs && !isGreen(execution)) {
    attempts++;
    const verify = execution.phases.find((p) => p.id === 'verify');
    const repair = await runPlan(buildRepairPlan(verify?.output ?? '', attempts));
    const byId = new Map(repair.phases.map((p) => [p.id, p] as const));
    execution = {
      ...execution,
      phases: execution.phases.map((p) => byId.get(p.id) ?? p),
      status: repair.status,
    };
  }
  return { execution, attempts, green: isGreen(execution) };
}

/** A review that flags a `blocker` finding blocks the auto-merge. Neutralizes the
 *  NEGATED/benign mentions a severity-ordered reviewer routinely writes ("no
 *  blockers", "blocker: none", "0 blockers", "no blocking issues") so they don't
 *  falsely hold the merge — only an affirmative blocker counts. */
export function reviewHasBlocker(output: string): boolean {
  const stripped = (output ?? '')
    .toLowerCase()
    .replace(/\b(?:no|zero|0|without|none)\s+blockers?\b/g, ' ')
    .replace(/\bblockers?\s*[:=]?\s*(?:none|n\/a|0|nil|nothing|free)\b/g, ' ')
    .replace(/\bno\s+blocking\b/g, ' ');
  return /\bblocker\b/.test(stripped);
}

/** One held fan-out slice: its child id, the preserved recovery patch, and a label. */
export interface FanOutSlice {
  id: string;
  label?: string;
  /** Absolute path to the slice's held recovery patch (absent ⇒ produced no changes). */
  patchPath?: string;
}

export interface FanOutBuildOutcome {
  mergedSlices: Array<{ id: string; label?: string; files: number }>;
  heldSlices: Array<{ id: string; label?: string; reason: string }>;
  overlaps: Array<{ file: string; ids: string[] }>;
  reviewApproved: boolean;
  reason: string;
}

/**
 * BUILD-LOOP P2.5 — gated merge of a FAN-OUT build's held slice worktrees.
 *
 * Each slice ran in its own worktree and was HELD (preserved as a recovery patch,
 * never auto-merged). Here we run the cross-worktree synthesis gate: a reviewer
 * `blocker` holds everything; otherwise non-overlapping slices merge in order
 * (check-then-apply), and a slice that would touch a file an earlier slice already
 * claimed — or whose patch no longer applies cleanly — is HELD with the conflict
 * named. Nothing half-merged ever lands; held slices stay recoverable via
 * `/agents diff <id>`.
 */
export function finalizeFanOutBuild(
  workspaceRoot: string,
  slices: FanOutSlice[],
  reviewOutput: string,
): FanOutBuildOutcome {
  const reviewApproved = !reviewHasBlocker(reviewOutput);
  const labelById = new Map(slices.map((s) => [s.id, s.label] as const));
  const patchById = new Map<string, string>();
  const changeSets: WorktreeChangeSet[] = [];
  for (const s of slices) {
    if (!s.patchPath || !fs.existsSync(s.patchPath)) continue; // slice produced no changes
    let text = '';
    try { text = fs.readFileSync(s.patchPath, 'utf8'); } catch { continue; }
    patchById.set(s.id, s.patchPath);
    changeSets.push({ id: s.id, files: parsePatchFiles(text), label: s.label });
  }

  const plan = planSynthesisMerge(changeSets, { synthesisBlocker: !reviewApproved });

  const mergedSlices: FanOutBuildOutcome['mergedSlices'] = [];
  const heldSlices: FanOutBuildOutcome['heldSlices'] = plan.hold.map((h) => ({ id: h.id, label: labelById.get(h.id), reason: h.reason }));
  for (const id of plan.merge) {
    const patchPath = patchById.get(id);
    const files = changeSets.find((c) => c.id === id)?.files.length ?? 0;
    const res = patchPath ? applyPatchFile(workspaceRoot, patchPath) : { ok: false, error: 'patch missing' };
    if (res.ok) mergedSlices.push({ id, label: labelById.get(id), files });
    else heldSlices.push({ id, label: labelById.get(id), reason: `patch did not apply cleanly (${res.error ?? 'conflict'}) — preserved as a patch` });
  }

  const reason = !reviewApproved
    ? `synthesis review flagged a blocker — all ${changeSets.length} slice(s) held (apply manually with /agents diff)`
    : `synthesis ok → merged ${mergedSlices.length}/${changeSets.length} slice(s)${heldSlices.length ? `, held ${heldSlices.length} (overlap/conflict — /agents diff)` : ''}`;

  return { mergedSlices, heldSlices, overlaps: plan.overlaps, reviewApproved, reason };
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
  const patchFile = path.join(getStateDir(workspaceRoot), 'worktree-patches', `build-${slug}-${Date.now().toString(36)}.patch`);
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
