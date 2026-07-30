/**
 * Backend compatibility façade for finding lifecycle policy.
 *
 * Core owns the deterministic implementation. Existing backend imports retain
 * this path while consumers migrate to the curated review entrypoint.
 */

export {
  findingFingerprint,
  reconcileFindingLifecycle,
  type LifecycleCurrentFinding,
  type LifecycleFindingInput,
  type LifecycleStatus,
  type LifecycleTransition,
  type LifecycleTransitionType,
  type NormalizedLifecycleFinding,
  type ReconcileFindingLifecycleInput,
} from '@kinqs/brainrouter-core/review';
