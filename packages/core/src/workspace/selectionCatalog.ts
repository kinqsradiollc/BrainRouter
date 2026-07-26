/**
 * Public facade for the safe workspace selection catalog.
 *
 * Catalog assembly, bounded skill metadata reads, and reviewed manifest
 * migration stay separated by concern behind this stable workspace export.
 */
export * from './selectionCatalog/types.js';
export * from './selectionCatalog/catalog.js';
export * from './selectionCatalog/toolEligibility.js';
export * from './selectionCatalog/validation.js';
