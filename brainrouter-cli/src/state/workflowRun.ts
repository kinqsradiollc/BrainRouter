/**
 * PARITY-W1 (0.4.2) — durable workflow run engine.
 *
 * A *workflow* (workflowArtifacts.ts) is a durable folder of artifacts +
 * lifecycle status. A *run* is the live execution ledger layered on top: the
 * ordered steps the agent moves through, each with a status + timestamps, so
 * progress is inspectable (`/workflows` viewer, PARITY-W2), survives a CLI
 * restart, and can be reconciled if the owning process dies.
 *
 *   <workspace>/.brainrouter/workflows/<slug>/run.json
 *
 * Run state is **lazily created**: it appears only when the agent first calls
 * `workflow_progress`. Workflows whose agent never reports progress have no
 * run.json and render exactly as before — so reconciliation never mislabels an
 * untracked workflow as "interrupted". The step template seeded on first
 * report is advisory; `advanceRunStep` appends unknown step ids, so a skill
 * that reports extra steps (e.g. `/review --fix`'s apply phase) is fine.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getWorkflowDir, getWorkflowsRoot } from './workflowArtifacts.js';

export type RunStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
export type RunStatus = 'running' | 'completed' | 'failed' | 'interrupted';

export interface WorkflowRunStep {
  id: string;
  title: string;
  status: RunStepStatus;
  startedAt?: string;
  endedAt?: string;
  note?: string;
}

export interface WorkflowRun {
  slug: string;
  kind: string;
  status: RunStatus;
  sessionKey: string | null;
  /** OS pid that owns the run, for stale reconciliation across restarts. */
  pid: number | null;
  startedAt: string;
  updatedAt: string;
  steps: WorkflowRunStep[];
  currentStepId: string | null;
  /**
   * WF-PERSIST (0.4.8) — phase-aware execution ledger for runtime-driven
   * (PhasePlan) workflows. Additive + optional: step-based runs leave it
   * undefined and behave exactly as before.
   */
  phases?: WorkflowRunPhase[];
  /** WF-RESUME (0.4.8) — the serialized PhasePlan, so an interrupted run can be
   *  re-loaded and resumed from its failed/interrupted phase. Set on creation. */
  planJson?: string;
}

/** Status of one phase in a runtime-driven (PhasePlan) workflow run. */
export type RunPhaseStatus = 'pending' | 'running' | 'completed' | 'partial' | 'failed' | 'interrupted';

export interface WorkflowRunPhase {
  id: string;
  title: string;
  status: RunPhaseStatus;
  /** Child session ids spawned for this phase (drill-down + WF-RESUME cleanup). */
  childIds: string[];
  startedAt?: string;
  endedAt?: string;
  /** Pointer to the phase's aggregated synthesis output (offloaded, not inlined). */
  aggregatedOutputRef?: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Pure model (no I/O — unit-tested directly)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Canonical advisory step scaffold per workflow kind. The agent reports
 * against these ids; unknown ids are appended by `applyStepTransition`, so
 * the template is a starting shape, not a hard contract.
 */
export function stepTemplateForKind(kind: string): Array<{ id: string; title: string }> {
  switch (kind) {
    case 'review':
      return [
        { id: 'triage', title: 'Triage' },
        { id: 'guidelines', title: 'Locate guidelines' },
        { id: 'summary', title: 'Summarize diff' },
        { id: 'review', title: 'Parallel review' },
        { id: 'validate', title: 'Validate findings' },
        { id: 'filter', title: 'Filter to high-signal' },
        { id: 'report', title: 'Write report' },
      ];
    case 'simplify':
      return [
        { id: 'map', title: 'Map complexity' },
        { id: 'rank', title: 'Rank by clarity/risk' },
        { id: 'apply', title: 'Apply + verify' },
      ];
    case 'feature-dev':
      return [
        { id: 'spec', title: 'Spec' },
        { id: 'plan', title: 'Plan' },
        { id: 'implement', title: 'Implement' },
        { id: 'verify', title: 'Verify' },
        { id: 'walkthrough', title: 'Walkthrough' },
      ];
    case 'spec':
      return [
        { id: 'research', title: 'Research' },
        { id: 'draft', title: 'Draft spec' },
        { id: 'finalize', title: 'Finalize' },
      ];
    case 'implement-plan':
      return [
        { id: 'select', title: 'Select next item' },
        { id: 'implement', title: 'Implement' },
        { id: 'verify', title: 'Verify' },
        { id: 'walkthrough', title: 'Append walkthrough' },
      ];
    default:
      return [{ id: 'execute', title: 'Execute' }];
  }
}

/**
 * Overall run status derived from its steps:
 *   - any failed step          → 'failed'
 *   - all steps done/skipped   → 'completed'
 *   - otherwise                → 'running'
 * `interrupted` is a reconciliation-only state (set when the owner died) and
 * is never derived here.
 */
export function computeRunStatus(steps: WorkflowRunStep[]): RunStatus {
  if (steps.some((s) => s.status === 'failed')) return 'failed';
  if (steps.length > 0 && steps.every((s) => s.status === 'done' || s.status === 'skipped')) return 'completed';
  return 'running';
}

/**
 * Pure transition: return a new steps array with `stepId` set to `status`.
 * Unknown step ids are appended (with `title` defaulting to the id) so the
 * template never blocks an agent from reporting an extra phase. Sets
 * startedAt on first `running` and endedAt on any terminal status.
 */
export function applyStepTransition(
  steps: WorkflowRunStep[],
  stepId: string,
  status: RunStepStatus,
  now: string,
  note?: string,
): WorkflowRunStep[] {
  const terminal = status === 'done' || status === 'failed' || status === 'skipped';
  let found = false;
  const next = steps.map((s) => {
    if (s.id !== stepId) return s;
    found = true;
    return {
      ...s,
      status,
      startedAt: s.startedAt ?? (status === 'running' || terminal ? now : s.startedAt),
      endedAt: terminal ? now : s.endedAt,
      note: note ?? s.note,
    };
  });
  if (!found) {
    next.push({
      id: stepId,
      title: stepId,
      status,
      startedAt: status === 'running' || terminal ? now : undefined,
      endedAt: terminal ? now : undefined,
      note,
    });
  }
  return next;
}

/** Pure: single glyph per step status, for the compact `/workflows` viewer (W2). */
export function stepGlyph(status: RunStepStatus): string {
  switch (status) {
    case 'done': return '✓';
    case 'running': return '▶';
    case 'failed': return '✗';
    case 'skipped': return '⊘';
    default: return '·';
  }
}

/** Pure: the step-status glyph strip, e.g. `✓✓▶····`. */
export function formatRunGlyphs(run: WorkflowRun): string {
  return run.steps.map((s) => stepGlyph(s.status)).join('');
}

/** Pure: human-friendly elapsed duration between two ISO timestamps (e.g. `1m 12s`, `3h 5m`). */
export function formatDuration(startIso: string | undefined, endIso: string | undefined): string {
  if (!startIso || !endIso) return '—';
  const ms = Date.parse(endIso) - Date.parse(startIso);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Pure: compact progress summary for the viewer (done/total + current step title). */
export function summarizeRun(run: WorkflowRun): { done: number; total: number; current: string | null } {
  const total = run.steps.length;
  const done = run.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  const running = run.steps.find((s) => s.status === 'running');
  return { done, total, current: running ? running.title : null };
}

/**
 * Pure: slugs of runs that should be reconciled — `running` runs whose owning
 * pid is no longer alive (an in-process run dies with its CLI). Mirrors
 * `staleWorkerIds`. A null pid counts as dead.
 */
export function staleRunSlugs(runs: WorkflowRun[], isAlive: (pid: number | null) => boolean): string[] {
  return runs.filter((r) => r.status === 'running' && !isAlive(r.pid)).map((r) => r.slug);
}

// ──────────────────────────────────────────────────────────────────────────
// WF-PERSIST (0.4.8) — phase-aware run model (pure)
// ──────────────────────────────────────────────────────────────────────────

const PHASE_TERMINAL: ReadonlySet<RunPhaseStatus> = new Set(['completed', 'partial', 'failed', 'interrupted']);

/**
 * Overall run status derived from its phases:
 *   - any pending/running phase → 'running'
 *   - any interrupted phase     → 'interrupted'
 *   - any failed phase          → 'failed'
 *   - otherwise (all terminal, none failed/interrupted; `partial` ok) → 'completed'
 * Empty never auto-completes (mirrors `computeRunStatus`).
 */
export function computePhaseRunStatus(phases: WorkflowRunPhase[]): RunStatus {
  if (phases.length === 0) return 'running';
  if (phases.some((p) => p.status === 'pending' || p.status === 'running')) return 'running';
  if (phases.some((p) => p.status === 'interrupted')) return 'interrupted';
  if (phases.some((p) => p.status === 'failed')) return 'failed';
  return 'completed';
}

/**
 * Pure transition: a new phases array with `phaseId` set to `status`, stamping
 * startedAt on first `running` and endedAt on any terminal status, and merging
 * `childIds` / `aggregatedOutputRef` when provided. Unknown phase ids are
 * appended (title defaults to the id) so a plan that grew is never blocked.
 */
export function applyPhaseTransition(
  phases: WorkflowRunPhase[],
  phaseId: string,
  status: RunPhaseStatus,
  now: string,
  opts: { childIds?: string[]; aggregatedOutputRef?: string; title?: string } = {},
): WorkflowRunPhase[] {
  const terminal = PHASE_TERMINAL.has(status);
  let found = false;
  const next = phases.map((p) => {
    if (p.id !== phaseId) return p;
    found = true;
    return {
      ...p,
      status,
      startedAt: p.startedAt ?? (status === 'running' || terminal ? now : p.startedAt),
      endedAt: terminal ? now : p.endedAt,
      childIds: opts.childIds ?? p.childIds,
      aggregatedOutputRef: opts.aggregatedOutputRef ?? p.aggregatedOutputRef,
    };
  });
  if (!found) {
    next.push({
      id: phaseId,
      title: opts.title ?? phaseId,
      status,
      childIds: opts.childIds ?? [],
      startedAt: status === 'running' || terminal ? now : undefined,
      endedAt: terminal ? now : undefined,
      aggregatedOutputRef: opts.aggregatedOutputRef,
    });
  }
  return next;
}

/** Pure: flip any non-terminal (pending/running) phase to `interrupted` — used
 *  by reconciliation when the owning process died mid-run. */
export function interruptInFlightPhases(phases: WorkflowRunPhase[], now: string): WorkflowRunPhase[] {
  return phases.map((p) =>
    p.status === 'pending' || p.status === 'running'
      ? { ...p, status: 'interrupted' as RunPhaseStatus, endedAt: p.endedAt ?? now }
      : p,
  );
}

/** Pure: single glyph per phase status, for the `/workflows` phase strip (WF-LAUNCH). */
export function phaseRunGlyph(status: RunPhaseStatus): string {
  switch (status) {
    case 'completed': return '✓';
    case 'running': return '▶';
    case 'partial': return '◑';
    case 'failed': return '✗';
    case 'interrupted': return '⚠';
    default: return '·';
  }
}

/** Pure: the phase-status glyph strip, e.g. `✓◑▶·`. */
export function formatPhaseGlyphs(run: WorkflowRun): string {
  return (run.phases ?? []).map((p) => phaseRunGlyph(p.status)).join('');
}

/** Pure: compact phase progress (done/total + current phase title). */
export function summarizePhases(run: WorkflowRun): { done: number; total: number; current: string | null } {
  const phases = run.phases ?? [];
  const total = phases.length;
  const done = phases.filter((p) => p.status === 'completed' || p.status === 'partial').length;
  const running = phases.find((p) => p.status === 'running');
  return { done, total, current: running ? running.title : null };
}

// ──────────────────────────────────────────────────────────────────────────
// File-backed store
// ──────────────────────────────────────────────────────────────────────────

function runPath(workspaceRoot: string, slug: string): string {
  return path.join(getWorkflowDir(workspaceRoot, slug), 'run.json');
}

function readMetaKind(workspaceRoot: string, slug: string): string {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(getWorkflowDir(workspaceRoot, slug), 'meta.json'), 'utf-8'));
    return typeof meta?.kind === 'string' ? meta.kind : 'default';
  } catch {
    return 'default';
  }
}

export function readRun(workspaceRoot: string, slug: string): WorkflowRun | null {
  try {
    return JSON.parse(fs.readFileSync(runPath(workspaceRoot, slug), 'utf-8')) as WorkflowRun;
  } catch {
    return null;
  }
}

function writeRun(workspaceRoot: string, run: WorkflowRun): WorkflowRun {
  fs.writeFileSync(runPath(workspaceRoot, run.slug), JSON.stringify(run, null, 2) + '\n', 'utf-8');
  return run;
}

/**
 * Lazily create the run ledger for a workflow if it doesn't exist yet, seeding
 * the kind's step template (all pending). Idempotent — returns the existing
 * run untouched if one is already on disk.
 */
export function ensureRun(
  workspaceRoot: string,
  slug: string,
  opts: { sessionKey?: string | null; pid?: number | null; now?: string } = {},
): WorkflowRun {
  const existing = readRun(workspaceRoot, slug);
  if (existing) return existing;
  const now = opts.now ?? new Date().toISOString();
  const kind = readMetaKind(workspaceRoot, slug);
  const run: WorkflowRun = {
    slug,
    kind,
    status: 'running',
    sessionKey: opts.sessionKey ?? null,
    pid: opts.pid ?? null,
    startedAt: now,
    updatedAt: now,
    steps: stepTemplateForKind(kind).map((s) => ({ id: s.id, title: s.title, status: 'pending' as RunStepStatus })),
    currentStepId: null,
  };
  return writeRun(workspaceRoot, run);
}

/**
 * Advance one step of a workflow run, lazily creating the run if needed.
 * Recomputes the overall run status from the resulting steps.
 */
export function advanceRunStep(
  workspaceRoot: string,
  slug: string,
  stepId: string,
  status: RunStepStatus,
  opts: { note?: string; sessionKey?: string | null; pid?: number | null; now?: string } = {},
): WorkflowRun {
  const now = opts.now ?? new Date().toISOString();
  const run = ensureRun(workspaceRoot, slug, { sessionKey: opts.sessionKey, pid: opts.pid, now });
  const steps = applyStepTransition(run.steps, stepId, status, now, opts.note);
  const next: WorkflowRun = {
    ...run,
    steps,
    currentStepId: status === 'running' ? stepId : run.currentStepId,
    status: computeRunStatus(steps),
    updatedAt: now,
  };
  return writeRun(workspaceRoot, next);
}

/** Force a run to a terminal status (e.g. on explicit completion/abort). */
export function finishRun(workspaceRoot: string, slug: string, status: RunStatus, now = new Date().toISOString()): WorkflowRun | null {
  const run = readRun(workspaceRoot, slug);
  if (!run) return null;
  return writeRun(workspaceRoot, { ...run, status, updatedAt: now });
}

/**
 * WF-PERSIST — lazily create a **phase-aware** run for a runtime-driven workflow,
 * seeding the given phases (all `pending`). Idempotent: returns the existing run
 * untouched if one is already on disk. The PhasePlan executor (WF-TOOL) calls
 * this once before execution, then `advanceRunPhase` per phase via the engine's
 * `onPhaseStart`/`onPhaseComplete` hooks.
 */
export function ensurePhaseRun(
  workspaceRoot: string,
  slug: string,
  phases: Array<{ id: string; title: string }>,
  opts: { sessionKey?: string | null; pid?: number | null; now?: string; kind?: string; planJson?: string } = {},
): WorkflowRun {
  const existing = readRun(workspaceRoot, slug);
  if (existing) return existing;
  const now = opts.now ?? new Date().toISOString();
  const kind = opts.kind ?? readMetaKind(workspaceRoot, slug);
  const run: WorkflowRun = {
    slug,
    kind,
    status: 'running',
    sessionKey: opts.sessionKey ?? null,
    pid: opts.pid ?? null,
    startedAt: now,
    updatedAt: now,
    steps: [],
    currentStepId: null,
    phases: phases.map((p) => ({ id: p.id, title: p.title, status: 'pending' as RunPhaseStatus, childIds: [] })),
    planJson: opts.planJson,
  };
  return writeRun(workspaceRoot, run);
}

/**
 * WF-PERSIST — advance one phase of a runtime-driven run (lazily creating an
 * empty phase run if needed), merging `childIds`/`aggregatedOutputRef` and
 * recomputing the overall run status from the phases.
 */
export function advanceRunPhase(
  workspaceRoot: string,
  slug: string,
  phaseId: string,
  status: RunPhaseStatus,
  opts: {
    childIds?: string[];
    aggregatedOutputRef?: string;
    title?: string;
    sessionKey?: string | null;
    pid?: number | null;
    now?: string;
  } = {},
): WorkflowRun {
  const now = opts.now ?? new Date().toISOString();
  const run =
    readRun(workspaceRoot, slug) ??
    ensurePhaseRun(workspaceRoot, slug, [], { sessionKey: opts.sessionKey, pid: opts.pid, now });
  const phases = applyPhaseTransition(run.phases ?? [], phaseId, status, now, {
    childIds: opts.childIds,
    aggregatedOutputRef: opts.aggregatedOutputRef,
    title: opts.title,
  });
  return writeRun(workspaceRoot, {
    ...run,
    phases,
    status: computePhaseRunStatus(phases),
    updatedAt: now,
  });
}

export function listRuns(workspaceRoot: string): WorkflowRun[] {
  // Runs live inside workflow dirs; scan the workflows root for run.json files.
  const root = getWorkflowsRoot(workspaceRoot);
  if (!fs.existsSync(root)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => readRun(workspaceRoot, e.name))
    .filter((r): r is WorkflowRun => r !== null)
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}

/**
 * On CLI startup, flip `running` runs left over from a dead process to
 * `interrupted` (their in-process execution is gone). Returns how many were
 * reconciled. Mirrors `reconcileStaleWorkers`.
 */
export function reconcileStaleRuns(workspaceRoot: string, currentPid: number = process.pid): number {
  const slugs = staleRunSlugs(listRuns(workspaceRoot), (pid) => pid === currentPid);
  const now = new Date().toISOString();
  for (const slug of slugs) {
    const run = readRun(workspaceRoot, slug);
    if (run?.phases && run.phases.length > 0) {
      // Phase-aware run: also flip its in-flight phase(s) to interrupted so
      // WF-RESUME knows exactly where execution stopped.
      writeRun(workspaceRoot, {
        ...run,
        status: 'interrupted',
        phases: interruptInFlightPhases(run.phases, now),
        updatedAt: now,
      });
    } else {
      finishRun(workspaceRoot, slug, 'interrupted', now);
    }
  }
  return slugs.length;
}
