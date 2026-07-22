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
export * from './profileSuggest.js';
export * from './fileWrite.js';
export * from './repositoryScan.js';
export * from './onboardingProposal.js';
export * from './onboardingProposalPrompt.js';
export * from './assistedOnboarding.js';
export * from './workspaceContentSafety.js';
export * from './reviewedOnboarding.js';
export * from './domainPersonas.js';
export * from './profilePlugins.js';
