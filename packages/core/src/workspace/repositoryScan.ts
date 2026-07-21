/**
 * Public surface for bounded assisted-onboarding repository scans.
 *
 * Types and hard limits live in `repositoryScan/types.ts`; traversal policy is
 * isolated in `repositoryScan/policy.ts`; descriptor-safe filesystem access is
 * in `repositoryScan/traversal.ts`; and orchestration lives in
 * `repositoryScan/scan.impl.ts`.
 */
export * from './repositoryScan/index.js';
