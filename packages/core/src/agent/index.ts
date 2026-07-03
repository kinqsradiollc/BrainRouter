// Public entrypoint for the `agent` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/agent` instead of deep `dist/agent/*.js` paths, so the
// subsystem's file layout stays an internal detail. Re-exports the modules the
// CLI and Desktop heads consume; the remaining agent files are internal wiring.
export * from './agent.js';
export * from './fs/workspaceFs.js';
export * from './guards/verificationGate.js';
export * from './support/prompter.js';
export * from './fs/computerUse.js';
export * from './fs/applyPatch.js';
