/**
 * ADR-028 Part F — comprehension.
 *
 * The barrel, so these are reachable from the package's public surface rather
 * than only from inside this folder. H4's reachability check exists because a
 * cluster that imports only itself is exactly as inert as an orphan.
 */
export * from './comprehensionReview.js';
export * from './workRecord.js';
export * from './profileComprehension.js';
