/**
 * ADR-038 — curated, browser-safe Planner presentation entrypoint.
 */
export * from './types.js';
export * from './viewModel.js';
export * from './fixture.js';
export * from './PlannerCalendar.js';
export * from './PlannerSurface.js';

/**
 * Core's planner presentation rules, re-exported so both hosts reach ONE copy.
 *
 * `packages/ui/src/notes/index.ts` has done this for notes since ADR-038, which
 * is why notes escaped the drift the planner suffered. Same door, same reason.
 */
export {
  ATTEMPTS_BEFORE_SURFACING,
  describeSyncState,
  stuckOperations,
} from '@kinqs/brainrouter-core/planner/presentation';
