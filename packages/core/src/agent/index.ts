// Public entrypoint for the `agent` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/agent` instead of deep `dist/agent/*.js` paths, so the
// subsystem's file layout stays an internal detail. Re-exports the modules the
// CLI and Desktop heads consume; the remaining agent files are internal wiring.
export * from './agent.js';
export * from './workspaceFs.js';
export * from './verificationGate.js';
export * from './prompter.js';
export * from './computerUse.js';
export * from './applyPatch.js';
