// Public entrypoint for the `review` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/review` instead of deep `dist/review/*.js` paths,
// keeping the subsystem's file layout internal. Full public surface; the
// internal service layer (service.ts) stays unexported.
export * from './critic.js';
export * from './reviewFindings.js';
// ADR-033 — review that finds things and says where: bundles (D2), the ask for
// a file (D3), computed positions (D4), the reflection pass (D5), and the one
// orchestration both front doors are meant to share (D1).
export * from './reviewBundles.js';
export * from './reviewEvidenceRequest.js';
export * from './findingPosition.js';
export * from './reviewReflection.js';
export * from './reviewOrchestration.js';
export * from './localReviewOrchestration.js';
export * from './sourceSafety.js';
export * from './reviewEvidenceBoundary.js';
export * from './reviewInstructions.js';
export * from './reviewModel.js';
export * from './reviewGrounding.js';
export * from './workingTreeReview.js';
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

// ADR-028 H1/H2 — the PR create path: the decision and the argv, in one place.
export {
  routePullRequest,
  resolveStackingMode,
  type PrRoute,
  changeRequestArgv,
  changeRequestTimeoutMs,
  type ChangeRequestArgs,
  type StackingMode,
} from './prRouter.js';

// ADR-028 A1 — is `gh stack` usable here?
export { probeStackCapability, type ProbeRunner } from './stackProbe.js';
export {
  parseVersion,
  meetsMinimum,
  MIN_GH,
  MIN_GIT,
  type StackCapability,
} from './stackCapability.js';
