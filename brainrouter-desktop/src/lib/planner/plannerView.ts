/**
 * ADR-038 — compatibility barrel for the shared Planner view model.
 * New renderer code imports `@kinqs/brainrouter-ui/planner` directly; this path
 * remains while existing Desktop-only helpers and tests migrate.
 */
export * from '@kinqs/brainrouter-ui/planner';
