// Barrel for the exec `guard` concern: dangerous/destructive command
// detection and approval-allowlist sanitisation. Grouped from the flat exec/
// layout during the per-concern sub-structure refactor. Re-exports only.
export * from './dangerousCommand.js';
export * from './destructiveCommandGuard.js';
export * from './approvalGuard.js';
