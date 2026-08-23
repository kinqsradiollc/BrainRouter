// Public entrypoint for the `agent` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/agent` instead of deep `dist/agent/*.js` paths, so the
// subsystem's file layout stays an internal detail. Re-exports the modules the
// CLI and Desktop heads consume; the remaining agent files are internal wiring.
export * from './agent.js';
export * from './iagent.js';
export * from './fs/workspaceFs.js';
export * from './guards/verificationGate.js';
export * from './support/prompter.js';
export * from './fs/computerUse.js';
export * from './fs/applyPatch.js';
export * from './adapters/index.js';
// ADR-032 D8 — a host that inspects or edits learned state has to resolve the
// same tenant the runtime learns into. Exported from the agent surface rather
// than from `learning/` because the mapping is agent-shaped: it is the identity
// THIS agent carries, not a property of the store.
export { learnedTenantForAgent } from './runtime/learningPhase.js';
