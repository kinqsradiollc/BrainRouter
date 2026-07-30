/**
 * runtime/verify — project verification: profile detection, running a verify
 * recipe step, and the configurable browser smoke test with its artifacts.
 */
export * from './projectProfile.js';
export * from './verifyRunner.js';
export * from './browserVerify.js';
// `verifyRunner` and `browserVerify` each declare a structurally identical
// `ExecFn`; re-export one explicitly to resolve the star-export ambiguity.
export type { ExecFn } from './verifyRunner.js';
