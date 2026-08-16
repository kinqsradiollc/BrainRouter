/**
 * ADR-028 Part I — tooling and identity.
 *
 * Exported from the package surface so H4's reachability check can see it: a
 * cluster that imports only itself is exactly as inert as an orphan.
 */
export * from './provisioning.js';
export * from './gitIdentity.js';
