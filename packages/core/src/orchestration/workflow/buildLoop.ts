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
import { removeChildWorktree, applyPatchFile, type ChildWorktreeIsolation } from '../../worktree/worktreeIsolation.js';
import { getStateDir } from '../../storage/store.js';
import { getCliKnobs } from '../../config/config.js';
import { emitPrFromPatch, derivePrTitle, derivePrBody } from '../../git/prEmit.js';
import { parsePatchFiles, planSynthesisMerge, type WorktreeChangeSet } from './mergeGate.js';
import { normalizePhasePlan, type PhasePlan } from './phasePlan.js';
import type { PhasePlanExecution } from './phaseOrchestrator.js';
import type { CriticDiagnostic, CriticResult } from '../../review/critic.js';

export interface BuildLoopPrOutcome {
  ok: boolean;
  url?: string;
  number?: number;
  branch?: string;
  error?: string;
  /** Why the PR emit was a no-op (gh/remote/base missing) — caller merged back instead. */
  skipped?: string;
}

export interface BuildLoopMergeOutcome {
  merged: boolean;
  verifyGreen: boolean;
  reviewApproved: boolean;
  changedFiles?: number;
  patchPath?: string;
  applyError?: string;
  /** HONK-H1 — present when `cli.buildLoopEmitPr` delivered the work as a PR. */
  pr?: BuildLoopPrOutcome;
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

/** Pure: the execution's Verify phase verdict (no verify phase ⇒ green),
 *  shared by the repair loop, the critic gate, and the final merge gate. */
export function executionVerifyGreen(execution: PhasePlanExecution): boolean {
  const verify = execution.phases.find((p) => p.id === 'verify');
  return verify ? verifyLooksGreen(verify.output) : true;
}

// ──────────────────────────────────────────────────────────────────────────
// MC-D1 — critic gate + bounded iterative refinement
// ──────────────────────────────────────────────────────────────────────────

/** MC-D1 — the critic gate's recorded outcome (persisted on the run record). */
export interface CriticGateOutcome {
  /** The score of the execution the gate proceeded with (the best seen). */
  score: number;
  threshold: number;
  /** Refinement rounds actually run (0 when the first score passed). */
  iterations: number;
  /** True when the final score met the threshold. */
  accepted: boolean;
  diagnostics: CriticDiagnostic[];
}

/** MC-D1 — pure gate predicate: the critic runs only when explicitly enabled
 *  AND the build already passed the existing verify gate (the critic layers a
 *  graded signal ON TOP of pass/fail — it never overrides a red verify). */
export function shouldRunCriticGate(knobs: { enabled: boolean }, verifyGreen: boolean): boolean {
  return knobs.enabled === true && verifyGreen;
}

/**
 * MC-D1 — one refinement round's plan: Implement→Verify→Review in the SAME
 * shared worktree (mirrors {@link buildRepairPlan}), with the critic's
 * diagnostics fed to the worker as a concrete punch list. Static shape, so it
 * always normalizes. Pure.
 */
export function buildCriticRefinePlan(diagnostics: CriticDiagnostic[], score: number, attempt: number): PhasePlan {
  const punchList = diagnostics.length
    ? diagnostics.map((d) => `- [${d.category}] ${d.detail}`).join('\n')
    : '- (no specific diagnostics — re-check the task requirements end to end)';
  const { plan } = normalizePhasePlan({
    title: `build-refine-${attempt}`,
    phases: [
      {
        id: 'implement',
        title: 'Refine',
        agents: [{
          role: 'worker',
          access: 'write',
          prompt: `A completion critic scored the build ${score.toFixed(2)}/1.00 on refinement round ${attempt} and reported these gaps:\n\n${punchList}\n\nYou are in the worktree with the earlier changes intact. Address each diagnostic concretely (add the missing tests, finish the incomplete pieces, cover the unaddressed requirements). Keep edits minimal and scoped. Report what you changed per diagnostic.`,
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

export interface CriticRefineResult {
  /** The execution the gate proceeds with — the BEST-scored one seen. */
  execution: PhasePlanExecution;
  /** Null when the critic never produced a verdict (fail-open: gate is a no-op). */
  outcome: CriticGateOutcome | null;
}

/**
 * MC-D1 — bounded critique-and-refine. Score the finished execution; while the
 * score is below `threshold` and rounds remain, run a refinement plan built from
 * the diagnostics (via `runPlan`, which executes in the build's shared worktree),
 * splice its Implement/Verify/Review outputs over the execution (mirroring
 * {@link repairUntilGreen}) and re-score. NEVER exceeds `maxIterations` rounds;
 * then proceeds with the best-scored execution seen. Fail-open contract:
 *   - first score unavailable (`score` → null) ⇒ untouched execution, null outcome;
 *   - a mid-loop scoring failure stops the loop, keeping the best so far;
 *   - a refinement that turns Verify red is discarded (the merge gate would
 *     block it) and the loop stops with the best green result.
 * The scorer and runner are injected, so this is unit-testable with fakes.
 */
export async function refineUntilAccepted(
  initial: PhasePlanExecution,
  opts: { threshold: number; maxIterations: number },
  score: (exec: PhasePlanExecution) => Promise<CriticResult | null>,
  runPlan: (plan: PhasePlan) => Promise<PhasePlanExecution>,
): Promise<CriticRefineResult> {
  const first = await score(initial);
  if (!first) return { execution: initial, outcome: null };

  let best: { execution: PhasePlanExecution; result: CriticResult } = { execution: initial, result: first };
  let current = best;
  let iterations = 0;
  const maxIterations = Math.max(0, Math.floor(opts.maxIterations));

  while (current.result.score < opts.threshold && iterations < maxIterations) {
    iterations++;
    const refined = await runPlan(buildCriticRefinePlan(current.result.diagnostics, current.result.score, iterations));
    const byId = new Map(refined.phases.map((p) => [p.id, p] as const));
    const nextExec: PhasePlanExecution = {
      ...current.execution,
      phases: current.execution.phases.map((p) => byId.get(p.id) ?? p),
      status: refined.status,
    };
    if (!executionVerifyGreen(nextExec)) break; // refinement regressed verify — keep the best green result
    const nextResult = await score(nextExec);
    if (!nextResult) { // critic went unavailable mid-loop — proceed with the best so far
      current = { execution: nextExec, result: current.result };
      break;
    }
    current = { execution: nextExec, result: nextResult };
    if (nextResult.score > best.result.score) best = current;
  }

  return {
    execution: best.execution,
    outcome: {
      score: best.result.score,
      threshold: opts.threshold,
      iterations,
      accepted: best.result.score >= opts.threshold,
      diagnostics: best.result.diagnostics,
    },
  };
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
  // HONK-H1 — when opted in, a passing build is delivered as a PR, NOT merged into
  // the user's tree. Capture the patch WITHOUT applying it back (applyBack:false);
  // the PR step below is the delivery. If the PR emit can't proceed we fall back to
  // the normal merge so the work is never lost.
  const emitPr = apply && getCliKnobs().buildLoopEmitPr === true;

  // Unique per-finalize token: names the recovery patch AND makes the PR branch
  // unique, so a re-run never overwrites a patch nor collides with a live branch.
  const runToken = Date.now().toString(36);
  const patchFile = path.join(getStateDir(workspaceRoot), 'worktree-patches', `build-${slug}-${runToken}.patch`);
  const cleanup = removeChildWorktree(shared.isolation, { applyBack: emitPr ? false : apply, patchFile });
  // No diff + no persisted patch ⇒ the build produced no file changes; a gate-pass
  // here is a clean no-op (NOT a failed apply). `removeChildWorktree` only sets
  // `applied` when there was a patch to apply, so distinguish the cases explicitly.
  const noChanges = (cleanup.changedFiles ?? 0) === 0 && !cleanup.patchPath;

  let merged: boolean;
  let pr: BuildLoopPrOutcome | undefined;
  let reason: string;

  if (emitPr && !noChanges && cleanup.patchPath) {
    const res = emitPrFromPatch({
      sourceRoot: shared.isolation.sourceRoot,
      patchPath: cleanup.patchPath,
      slug,
      runToken,
      title: derivePrTitle(slug, phaseOutput('implement')),
      body: derivePrBody({ slug, verifyGreen, changedFiles: cleanup.changedFiles ?? 0, reviewOutput: phaseOutput('review'), attributionSessionUrl: getCliKnobs().attribution.sessionUrl }),
      baseBranch: getCliKnobs().buildLoopPrBaseBranch,
      draft: getCliKnobs().buildLoopPrDraft,
    });
    if (res.ok) {
      pr = { ok: true, url: res.prUrl, number: res.prNumber, branch: res.branch };
      merged = false; // delivered via PR, intentionally NOT merged into the tree
      reason = `verify green + review ok → opened PR ${res.prUrl ?? `(branch ${res.branch})`} with ${cleanup.changedFiles ?? 0} file(s) — your tree is untouched`;
    } else {
      // PR emit declined/failed → fall back to merging into the tree so work survives.
      const fallback = applyPatchFile(workspaceRoot, cleanup.patchPath);
      merged = fallback.ok;
      pr = { ok: false, error: res.error, skipped: res.skipped, branch: res.branch };
      const why = res.skipped ?? res.error ?? 'unknown';
      reason = fallback.ok
        ? `verify green + review ok → PR emit unavailable (${why}); merged ${cleanup.changedFiles ?? 0} file(s) into your tree instead`
        : `verify green + review ok → PR emit failed (${why}) AND fallback merge failed (${fallback.error ?? 'conflict'}) — work preserved as a patch`;
    }
  } else if (emitPr && !noChanges && !cleanup.patchPath) {
    // PR mode chose applyBack:false, but the work patch failed to persist (disk /
    // unwritable state dir) and the worktree is already gone. Report it accurately
    // rather than misclassifying it as a merge conflict.
    merged = false;
    pr = { ok: false, error: 'work patch could not be persisted' };
    reason = `verify green + review ok → could NOT deliver as a PR: the work patch failed to persist (check disk / ${getStateDir(workspaceRoot)}); re-run the build`;
  } else if (!apply) {
    merged = false;
    const why = [!verifyGreen ? 'verify not green' : null, !reviewApproved ? 'review has a blocker' : null].filter(Boolean).join(' + ');
    reason = `merge gated (${why}) — ${cleanup.changedFiles ?? 0} file(s) preserved as a patch (apply with /agents diff or git apply)`;
  } else if (noChanges) {
    merged = true;
    reason = emitPr
      ? 'verify green + review ok → no file changes to deliver (clean no-op)'
      : 'verify green + review ok → no file changes to merge (clean no-op)';
  } else if (cleanup.applied === true) {
    merged = true;
    reason = `verify green + review ok → merged ${cleanup.changedFiles ?? 0} file(s) into your tree`;
  } else {
    merged = false;
    reason = `gate passed but the patch did not apply cleanly (${cleanup.applyError ?? 'conflict'}) — work preserved as a patch`;
  }

  return {
    merged,
    verifyGreen,
    reviewApproved,
    changedFiles: cleanup.changedFiles,
    patchPath: cleanup.patchPath,
    applyError: cleanup.applyError,
    pr,
    reason,
  };
}
