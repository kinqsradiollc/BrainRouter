/**
 * TRACK (unified workspace · Track mode) — durable per-workspace project store.
 *
 * One project per workspace (the workspace root IS the project identity), with
 * its work items, sprints, boards, modules, labels, saved views, automations
 * and GitHub links. Persisted at `<workspace cli state>/track.json`, exactly
 * like requirementStore / annotationStore. The record shapes live in
 * `@kinqs/brainrouter-types` — this module never redefines them, only
 * reads/writes/merges.
 *
 * The implementation was split into per-concern modules under `./store/`. This
 * file is now a re-export barrel that preserves the original public surface, so
 * every existing importer of `../track/trackStore.js` keeps working unchanged.
 * Shared internals (readTrack/writeTrack, id/date helpers, the permission guard)
 * live in `./store/_internal.js` and stay private — only `LOCAL_MEMBER_ID` is
 * re-exported from there because it is part of the public surface.
 */
export * from './store/types.js';
export * from './store/items.js';
export * from './store/boards.js';
export * from './store/sprints.js';
export * from './store/modules.js';
export * from './store/labels.js';
export * from './store/project.js';
export * from './store/views.js';
export * from './store/automations.js';
export * from './store/githubLinks.js';

// members.ts also exports the internal `assertCan` guard, which was never part
// of trackStore's public surface — re-export the seven public members symbols
// explicitly so the surface stays identical.
export {
  PermissionError,
  addMember,
  updateMemberRole,
  removeMember,
  listMembers,
  memberRole,
  canActor,
} from './store/members.js';

// LOCAL_MEMBER_ID is the one public constant that lives in the shared internals.
export { LOCAL_MEMBER_ID } from './store/_internal.js';
