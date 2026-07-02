/**
 * TRACK (unified workspace) — shared type definitions.
 *
 * Split into cohesive modules under ./track/ (base scalars+unions, entity record
 * shapes, default registries). This file re-exports them so every importer of
 * @kinqs/brainrouter-types Track symbols is unchanged.
 */
export * from './track/base.js';
export * from './track/entities.js';
export * from './track/defaults.js';
