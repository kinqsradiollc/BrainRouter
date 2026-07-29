/**
 * Pure workspace-manifest policy facade.
 *
 * A25-5d2: exposes compatibility translation, profile-default construction,
 * safe normalization, and bounded serialization without filesystem access.
 */
export * from './policy/compatibility.js';
export * from './policy/normalization.js';
export * from './policy/profileDefaults.js';
