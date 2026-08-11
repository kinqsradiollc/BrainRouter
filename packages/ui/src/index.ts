/**
 * ADR-038 — the deliberately small root of BrainRouter's shared UI package.
 * Consumers use the curated planner and notes subpaths so importing one surface
 * never drags the other into its browser bundle.
 */
export const BRAINROUTER_UI_PACKAGE = '@kinqs/brainrouter-ui';
