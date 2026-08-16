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
  type RunsListRow,
  type RunDetailView,
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
