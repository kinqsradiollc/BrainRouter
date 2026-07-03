// Public entrypoint for the `goal` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/goal` instead of deep `dist/goal/*.js` paths, so the
// subsystem's file layout stays an internal detail. The implementation is now
// grouped into per-concern subfolders (model / store / budget / prompt); the
// re-export surface below is unchanged. `goalStore` transitively re-exports the
// model/budget/prompt-format/continuation modules, so this preserves the exact
// symbols that shipped before the split.
export * from './store/goalStore.js';
export * from './prompt/goalKickoff.js';
