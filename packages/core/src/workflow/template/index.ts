// Template concern: template-driven workflow planning (`workflowTemplates`) and
// the workflow tool that drives phase execution (`workflowTool`). Grouped under
// `template/` during the per-concern sub-structure refactor; public surface
// unchanged. The internal service layer (service.ts) stays unexported.
export * from './workflowTemplates.js';
export {
  chunkIntoWaves,
  workflowSlug,
  defaultPhaseRunner,
  runWorkflow,
  resumeWorkflow,
  type OrchestrationDispatch,
  type RunWorkflowDeps,
} from './workflowTool.js';
