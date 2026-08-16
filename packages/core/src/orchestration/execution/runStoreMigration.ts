/**
 * ADR-040 A40-6 — migrate the legacy `WorkflowRun` ledger into the durable run
 * store, so a workspace that predates A40-6 still shows its history in `/runs`
 * and Desktop Runs rather than appearing to have never run anything.
 *
 * The legacy ledger lives at `.brainrouter/workflows/<slug>/run.json`; the
 * durable store at `.brainrouter/runs/<runId>/safe.json`. This reads the former
 * and ADDS the latter. It is:
 *
 *   - NON-DESTRUCTIVE. The legacy `run.json` is left exactly where it is; the
 *     `/workflows` viewer still reads it. Deleting it would be a second, riskier
 *     decision that this migration deliberately does not make.
 *   - IDEMPOTENT. A durable record that already exists is skipped, so running
 *     the migration on every open is safe.
 *   - HONEST about what it does not know. A legacy ledger carries no content
 *     hash and no A40-6 resume payload, so `definitionHash` stays null and no
 *     resume state is written — inventing either would let a later resume read
 *     something that was never true.
 *
 * Import direction is one-way (this module -> runStore + legacy readers), so it
 * cannot close an import cycle back into either (golden rule 31).
 */
import fs from 'node:fs';
import { getWorkflowsRoot } from '../../workflow/run/workflowArtifacts.js';
import { readRun, type RunStatus, type WorkflowRun } from '../../workflow/run/workflowRun.js';
import {
  startDurableRun,
  updateDurableRun,
  readDurableRunSafe,
  reconcileInterruptedRuns,
} from './runStore.js';

/**
 * A legacy status maps to a TERMINAL durable status. `running` becomes
 * `interrupted`, not `running`: a legacy ledger is only ever read by NEW code
 * touching an OLD workspace, and by then the process that owned that run is
 * gone. Calling it "running" would strand it exactly the way an unreconciled
 * crash does.
 */
function durableStatusFor(legacy: RunStatus): string {
  switch (legacy) {
    case 'completed': return 'succeeded';
    case 'failed': return 'failed';
    case 'interrupted': return 'interrupted';
    case 'running': return 'interrupted';
    default: return 'interrupted';
  }
}

/**
 * Prefer the A40-2 stable `runId` the legacy record may already carry; otherwise
 * derive a stable, filesystem-safe id from the slug so re-running the migration
 * lands on the same durable record and skips it.
 */
function migrationRunId(run: WorkflowRun): string {
  const raw = run.runId && run.runId.trim() ? run.runId : `legacy-${run.slug}`;
  return raw.replace(/[^A-Za-z0-9._-]/g, '-');
}

export interface LegacyRunMigrationResult {
  /** Durable run ids created from legacy ledgers this call. */
  migrated: readonly string[];
  /** Legacy ledgers whose durable record already existed. */
  skipped: readonly string[];
}

export function migrateLegacyWorkflowRuns(workspaceRoot: string): LegacyRunMigrationResult {
  const migrated: string[] = [];
  const skipped: string[] = [];

  let slugs: string[];
  try {
    slugs = fs.readdirSync(getWorkflowsRoot(workspaceRoot), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return { migrated: Object.freeze([]), skipped: Object.freeze([]) };
  }

  for (const slug of slugs) {
    const legacy = readRun(workspaceRoot, slug);
    if (!legacy) continue;

    const runId = migrationRunId(legacy);
    // The real idempotency guarantee is startDurableRun's exclusive create,
    // which THROWS if the record exists (handled in the catch below and pinned
    // by runStore's own suite). This pre-check is only an optimisation: it turns
    // the common "already migrated" case into a clean skip instead of a
    // thrown-and-caught exception on every subsequent open.
    if (readDurableRunSafe(workspaceRoot, runId)) {
      skipped.push(runId);
      continue;
    }

    let created;
    try {
      created = startDurableRun({
        workspaceRoot,
        runId,
        executionId: legacy.parentExecutionId && legacy.parentExecutionId.trim()
          ? legacy.parentExecutionId
          : runId,
        definitionId: legacy.kind ?? null,
        definitionHash: null,
        startedAt: legacy.startedAt,
        // No resumeState: a legacy ledger has none, and a fabricated one would
        // be a resume point that resumes from nothing real.
      });
    } catch {
      // exclusive-create lost a race, or the id appeared between the read and
      // the write. Either way the durable record now exists; treat as skipped.
      skipped.push(runId);
      continue;
    }

    updateDurableRun(
      workspaceRoot,
      runId,
      { status: durableStatusFor(legacy.status), endedAt: legacy.updatedAt },
      created.revision,
    );
    migrated.push(runId);
  }

  return { migrated: Object.freeze(migrated), skipped: Object.freeze(skipped) };
}

const opened = new Set<string>();

export interface DurableRunsOpenResult {
  migrated: readonly string[];
  reconciled: readonly string[];
}

/**
 * Bring a workspace's durable run store up to date once per process: migrate any
 * legacy ledgers, then reconcile runs a crash left `running`. Cheap on the
 * second call (a guarded no-op), so a read surface like `/runs` can call it
 * unconditionally before listing.
 *
 * This is also what WIRES the migration and the crash-reconciliation: without a
 * caller they are orphans the E1 sweep flags. `/runs` (CLI and Desktop) is that
 * caller.
 */
export function openDurableRuns(workspaceRoot: string): DurableRunsOpenResult {
  if (opened.has(workspaceRoot)) {
    return { migrated: Object.freeze([]), reconciled: Object.freeze([]) };
  }
  opened.add(workspaceRoot);
  const migration = migrateLegacyWorkflowRuns(workspaceRoot);
  const reconciled = reconcileInterruptedRuns(workspaceRoot);
  return { migrated: migration.migrated, reconciled };
}

/** Test seam: forget the once-per-process guard so a fresh workspace re-opens. */
export function _resetDurableRunsOpenCache(): void {
  opened.clear();
}
