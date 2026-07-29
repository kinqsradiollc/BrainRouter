/**
 * Curated Core façade for dependency-free review host projections.
 *
 * The protocol package remains the contract owner; application hosts that
 * cannot depend on protocol consume the same surface through Core.
 */
export {
  projectReviewAssuranceDetailView,
  type AssuranceFindingStateView,
  type AssuranceFindingView,
  type AssuranceRunStatusView,
  type ReviewAssuranceDetailView,
  type ReviewSummaryView,
} from '@kinqs/brainrouter-agent-protocol';
