/**
 * ADR-040 A40-9/A40-10 — the curated public surface for run views.
 *
 * Hosts get exactly this: read the durable summaries, and turn them into the
 * shared projection. They do NOT get the writer, the reducer's internals, or
 * `readDurableRunResumeState` — resume material is not something a rendering
 * surface has any business holding, and the boundary check is what keeps that
 * true rather than a comment asking nicely.
 */
export {
  listDurableRuns,
  readDurableRunSafe,
  type DurableRunSafeRecord,
  type DurableRunListing,
} from './runStore.js';

export {
  toRunsListRows,
  toRunDetailView,
  runsJson,
  runDetailJson,
  isTerminalRunStatus,
  RUN_TERMINAL_STATUSES,
  toPlanPreview,
  planPreviewLines,
  type RunsListRow,
  type RunDetailView,
  type PlanPreview,
} from './runsView.js';

// A40-6: bringing the store up to date (migrate legacy ledgers, reconcile
// crashed runs) is maintenance, not resume material, so it belongs on the
// curated surface a host may call before it lists.
export {
  openDurableRuns,
  type DurableRunsOpenResult,
} from './runStoreMigration.js';

// A40-9 — retained replay: read a run's durable record + retained event journal
// and project the detail. Hosts get the READER only; `appendRunEvent` (the writer)
// stays internal to the emitters, off this surface.
export {
  readRunDetail,
} from './runJournal.js';

// A40-9 preview/confirm start — resolve the plan an explicit-strategy launch
// WOULD run, as the shared PlanPreview, so the CLI `/runs start` preview and the
// Desktop "Run with strategy" dialog show one validated answer before the user
// confirms. Read-only: it resolves topology, it does not launch anything.
import { resolveActiveTurnOrchestration } from '../../workspace/activeTurnOrchestration.js';
import { toPlanPreview, type PlanPreview } from './runsView.js';

export interface PreviewTurnStrategyInput {
  workspaceRoot: string;
  task: string;
  /** The explicit strategy id to preview; omitted previews the auto-selected plan. */
  strategyId?: string;
  activeCapabilitySkillIds?: readonly string[];
}

export function previewTurnStrategy(input: PreviewTurnStrategyInput): PlanPreview {
  const resolution = resolveActiveTurnOrchestration({
    workspaceRoot: input.workspaceRoot,
    task: input.task,
    ...(input.activeCapabilitySkillIds ? { activeCapabilitySkillIds: input.activeCapabilitySkillIds } : {}),
    ...(input.strategyId ? { explicitStrategyId: input.strategyId } : {}),
  });
  return toPlanPreview(resolution.plan);
}
