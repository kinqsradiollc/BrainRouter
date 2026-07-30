/**
 * Compatibility export for the shared bounded workspace-onboarding model
 * adapter. Desktop host callers keep their stable local import while CLI and
 * other Node clients consume the same core implementation.
 */
export {
  completeWorkspaceOnboardingWithModel,
  type WorkspaceOnboardingModelCall,
} from '@kinqs/brainrouter-core/agent';
