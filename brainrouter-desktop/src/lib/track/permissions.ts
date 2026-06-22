/**
 * Renderer-side copy of the Track permission policy from
 * `@kinqs/brainrouter-types` (track.ts). The renderer can't value-import that
 * package — its barrel pulls in `memory.js`, which touches `node:crypto` at
 * module scope and is externalized in the browser — so this small, pure policy
 * is hand-synced here, exactly like `lib/track/query.ts`. Keep `ROLE_RANK` and
 * `CAPABILITY_MIN_RANK` identical to the source of truth.
 */
import type { ProjectRole, ProjectCapability } from '@kinqs/brainrouter-types';

export const ROLE_RANK: Record<ProjectRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

const CAPABILITY_MIN_RANK: Record<ProjectCapability, number> = {
  view: 0,
  'create-item': 1,
  'edit-item': 1,
  'manage-sprints': 1,
  'delete-item': 2,
  'manage-automation': 2,
  'manage-members': 2,
};

/** Pure policy: may a member with `role` perform `capability`? */
export function roleCan(role: ProjectRole, capability: ProjectCapability): boolean {
  return ROLE_RANK[role] >= CAPABILITY_MIN_RANK[capability];
}
