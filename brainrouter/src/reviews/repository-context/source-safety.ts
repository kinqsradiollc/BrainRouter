/**
 * Compatibility entrypoint for server review sources. The policy lives in the
 * shared core so PR, Desktop, and CLI reviews cannot drift at this boundary.
 */
export {
  SENSITIVE_REVIEW_SOURCE_REASON,
  isSensitiveReviewSourcePath,
  redactReviewSourceText,
} from '@kinqs/brainrouter-core/review';
