// Public entrypoint for the `exec` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/exec` instead of deep `dist/exec/*.js` paths, so the
// subsystem's file layout stays an internal detail. Re-exports the modules the
// CLI and Desktop heads consume.
//
// Files are grouped by concern into `policy/`, `guard/`, and `runtime/`
// subfolders; the public surface below is preserved verbatim.
export * from './guard/dangerousCommand.js';
export * from './policy/execPolicy.js';
export * from './runtime/sandbox.js';
export * from './policy/pathPolicy.js';
export * from './policy/permissionRules.js';
export * from './runtime/backgroundShell.js';
