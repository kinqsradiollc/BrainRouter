// Public entrypoint for the `review` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/review` instead of deep `dist/review/*.js` paths,
// keeping the subsystem's file layout internal. Full public surface; the
// internal service layer (service.ts) stays unexported.
export * from './critic.js';
export * from './reviewFindings.js';
export * from './reviewInstructions.js';
export * from './reviewModel.js';
export * from './securityReview.js';
export * from './reviewStore.js';
export * from './reviewSynthesis.js';
// reviewModel and reviewSynthesis both declare an unrelated `ReviewFinding`
// interface (UI review-model vs multi-reviewer synthesis). No consumer imports
// the synthesis one by name, so the public `ReviewFinding` is reviewModel's.
export type { ReviewFinding } from './reviewModel.js';
