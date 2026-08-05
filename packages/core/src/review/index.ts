// Public entrypoint for the `review` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/review` instead of deep `dist/review/*.js` paths,
// keeping the subsystem's file layout internal. Full public surface; the
// internal service layer (service.ts) stays unexported.
export * from './critic.js';
export * from './reviewFindings.js';
export * from './reviewInstructions.js';
export * from './reviewModel.js';
export * from './reviewLens.js';
export * from './securityReview.js';
export * from './codeReviewContract.js';
export * from './pentestReview.js';
export * from './pentestFinding.js';
export * from './sarif.js';
export * from './pentestAgent.js';
export * from './pentestSandbox.js';
export * from './pentestProxy.js';
export * from './pentestProxySession.js';
export * from './reviewStore.js';
export * from './reviewSynthesis.js';
export * from './vulnerabilityIntelligence.js';
export * from './hostProjection.js';
export * from './contracts/index.js';
export * from './domain/index.js';
export * from './ports/index.js';
export * from './services/index.js';
// reviewModel and reviewSynthesis both declare an unrelated `ReviewFinding`
// interface (UI review-model vs multi-reviewer synthesis). No consumer imports
// the synthesis one by name, so the public `ReviewFinding` is reviewModel's.
export type { ReviewFinding } from './reviewModel.js';

// ADR-027 D13 — stacked pull requests.
export {
  validateStack,
  evaluateStackMerge,
  highestMergeableLayer,
  attributeFindingsToLayers,
  adviseStacking,
  describeStack,
  displayRef,
  REVIEWABLE_LAYER_LINES,
  StackError,
  type StackLayer,
  type PullRequestStack,
  type LayerMergeVerdict,
  type LayerBlockReason,
  type StackAdvice,
} from './stackedPr.js';

// ADR-028 H1/H2 — the PR create path. Exported so the decision is reachable
// from the public surface rather than only from inside this folder: a cluster
// that imports only itself is exactly as inert as an orphan, which is how Part
// A shipped five modules nobody could get to.
export {
  routePullRequest,
  describeRoute,
  resolveStackingMode,
  type PrRoute,
  type StackingMode,
} from './prRouter.js';
export { probeStackCapability } from './stackProbe.js';
export {
  proposeStackFromPlan,
  mayProposeStack,
  type PlanPhaseLike,
  type StackProposal,
} from './planToStack.js';


// ADR-028 A3 — gh stack exit-code contract.
export {
  classifyStackExit,
  blocksFurtherMutation,
  KNOWN_STACK_EXIT_CODES,
  type StackOutcome,
  type StackOutcomeKind,
} from './stackExitCodes.js';

// ADR-028 A1 — gh stack capability detection.
export {
  detectStackCapability,
  stackCapabilityFor,
  resetStackCapabilityCache,
  parseVersion,
  meetsMinimum,
  MIN_GH,
  MIN_GIT,
  type StackCapability,
  type CapabilityProbe,
} from './stackCapability.js';

// ADR-028 S2-1 — gh stack runner.
export {
  StackRunner,
  StackUnavailableError,
  StackHaltedError,
  stackActionsAvailable,
  type StackExec,
  type StackRunResult,
  type StackRunnerOptions,
} from './stackRunner.js';
