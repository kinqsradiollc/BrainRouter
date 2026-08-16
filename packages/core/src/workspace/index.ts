// Public entrypoint for the `workspace` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/workspace` instead of deep `dist/workspace/*.js` paths,
// keeping the subsystem's file layout internal. Full public surface; the
// internal service layer (service.ts) stays unexported.
export * from './workspace.js';
export * from './workspaceTrust.js';
export * from './manifest.js';
export * from './manifestClaim.js';
export * from './onboardingTransaction.js';
export * from './capabilities.js';
// ADR-031 D5 — the design artifact a workspace's frontend capability follows.
export * from './designArtifact.js';
export * from './profileSuggest.js';
export * from './fileWrite.js';
export * from './repositoryScan.js';
export * from './onboardingProposal.js';
export * from './onboardingProposalPrompt.js';
export * from './assistedOnboarding.js';
export * from './workspaceContentSafety.js';
export * from './reviewedOnboarding.js';
export * from './domainPersonas.js';
export * from './personaDefinitionFile.js';
export * from './personaRegistry.js';
export * from './profilePlugins.js';
export * from './activeTurnOrchestration.js';
export * from './profileRecommendations.js';
export * from './orchestrationPlanIdentity.js';
export * from './profileOrchestrationDefaults.js';
export * from './onboardingPreview.js';
export * from './onboardingSources.js';
export * from './skillSelection.js';
export * from './skillToolAdapter.js';
export * from './requiredSkillActivation.js';
export * from './planningSchemas/index.js';
export * from './toolProfiles.js';
export * from './selectionCatalog.js';
export * from './memoryCapture.js';
export * from './compatibilityDiagnostics.js';
