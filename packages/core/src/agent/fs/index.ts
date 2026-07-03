// Barrel for the agent `fs` concern: workspace filesystem tools, patch
// application, read truncation, and computer-use action validation. Sub-structure
// only — no behavior change; modules keep their original public surface.
export * from './applyPatch.js';
export * from './computerUse.js';
export * from './readTruncation.js';
export * from './workspaceFs.js';
