// Public entrypoint for the `orchestration` subsystem (Refactor P1). Consumers
// import `@kinqs/brainrouter-core/orchestration` instead of deep
// `dist/orchestration/*.js` paths, so the subsystem's file layout stays an
// internal detail. Re-exports the modules the CLI and Desktop heads consume.
export * from './orchestrator.js';
export * from './tools.js';
export * from './roles.js';
export * from './parentContext.js';
export * from './delegationPolicy.js';
export * from './autoChain.js';
export * from './agentRegistry.js';
export * from './outputContracts.js';
// `AccessMode` ('read' | 'write' | 'shell') is declared identically in both
// roles.ts and agentRegistry.ts; an explicit re-export disambiguates the two
// star exports (TS2308) and is structurally identical to either source.
export type { AccessMode } from './roles.js';
