// Public entrypoint for the `workflow` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/workflow` instead of deep `dist/workflow/*.js` paths,
// keeping the subsystem's file layout internal. Full public surface; the
// internal service layer (service.ts) stays unexported.
export * from './graph.js';
export * from './graphEngine.js';
export * from './graphStore.js';
export * from './workflowArtifacts.js';
export * from './workflowRun.js';
export * from './workflowTemplates.js';
export * from './workflowTool.js';
