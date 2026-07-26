// Public entrypoint for the `orchestration` subsystem (Refactor P1). Consumers
// import `@kinqs/brainrouter-core/orchestration` instead of deep
// `dist/orchestration/*.js` paths, so the subsystem's file layout stays an
// internal detail. Re-exports the modules the CLI and Desktop heads consume.
export * from './session/orchestrator.js';
export * from './tools.js';
export * from './roles/roles.js';
export * from './delegation/parentContext.js';
export * from './delegation/taskPacket.js';
export * from './delegation/delegationPolicy.js';
export * from './delegation/autoChain.js';
export * from './agents/agentRegistry.js';
export * from './profiles/orchestrationProfileCatalog.js';
export * from './profiles/orchestrationProfileDefinitionFile.js';
export * from './roles/outputContracts.js';
// `AccessMode` ('read' | 'write' | 'shell') is declared identically in both
// roles.ts and agentRegistry.ts; an explicit re-export disambiguates the two
// star exports (TS2308) and is structurally identical to either source.
export type { AccessMode } from './roles/roles.js';
