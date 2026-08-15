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
