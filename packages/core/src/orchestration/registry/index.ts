// Barrel for the `registry` concern — the orchestration taxonomy: agent
// definitions loaded from packs/user/workspace (`agentRegistry`), the built-in
// role table + prompt assembly (`roles`), and the per-role output contracts
// children must satisfy (`outputContracts`).
export * from './agentRegistry.js';
export * from './roles.js';
export * from './outputContracts.js';
// `AccessMode` ('read' | 'write' | 'shell') is declared identically in both
// roles.ts and agentRegistry.ts; an explicit re-export disambiguates the two
// star exports (TS2308) and is structurally identical to either source.
export type { AccessMode } from './roles.js';
