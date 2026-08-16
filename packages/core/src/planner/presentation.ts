/**
 * The planner's pure PRESENTATION rules, on a browser-safe entrypoint.
 *
 * ## Why this exists
 *
 * ADR-038 gave the planner one renderer and left its PROJECTION in both hosts,
 * because `packages/ui` was allowed to reach Core only through
 * `notes/editing` — so every string derived from sync state had no legal shared
 * home and each host wrote its own. They drifted, and the drift was the ADR's
 * own §6 criterion failing: the desktop said "could not be sent — open sync to
 * see why" while the dashboard said "waiting to sync" no matter how many
 * operations were wedged.
 *
 * `./planner` cannot be that home: it re-exports `plannerStore`,
 * `plannerService` and `plannerSync`, which reach storage and the network and
 * have no business in a browser bundle. This is the narrow door — the same shape
 * as `notes/editing`, and for the same reason.
 *
 * ## Invariant
 *
 * Everything reachable from here is PURE: no node builtins, no fetch, no
 * storage. `outbox.ts` imports only `hybridClock.ts`, and both are arithmetic
 * over plain data. Adding an export that breaks that breaks the dashboard's
 * bundle, which is the failure `packages/ui`'s restriction exists to prevent.
 */
export {
  ATTEMPTS_BEFORE_SURFACING,
  describeSyncState,
  stuckOperations,
} from '../sync/outbox.js';
export type { OutboxOperation, OutboxState, SyncWording } from '../sync/outbox.js';

/**
 * Which fields a host may edit on a MIRRORED item — the merge rule, not a copy
 * of it.
 *
 * The shared surface had its own `PLANNER_OWNED_FIELDS` with the same five
 * entries, which is the projection duplication ADR-038's own audit named: two
 * statements of one rule, and the merge is the one that actually decides what
 * survives a refresh. A surface that offered an edit this set does not permit
 * would be offering an edit the next sync silently undoes.
 */
export { PLANNER_OWNED_FIELDS } from './itemMerge.js';
