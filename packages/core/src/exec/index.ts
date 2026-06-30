// Public entrypoint for the `exec` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/exec` instead of deep `dist/exec/*.js` paths, so the
// subsystem's file layout stays an internal detail. Re-exports the modules the
// CLI and Desktop heads consume.
export * from './dangerousCommand.js';
export * from './execPolicy.js';
export * from './sandbox.js';
export * from './pathPolicy.js';
export * from './permissionRules.js';
export * from './backgroundShell.js';
