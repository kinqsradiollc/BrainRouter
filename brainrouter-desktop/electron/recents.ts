/**
 * Project (workspace) ordering for the sidebar. The recents list is
 * ACTIVITY-ordered, most-recent-activity first — NOT "most recently opened".
 *
 * Opening, switching to, or merely viewing a project must NOT move it to the
 * top (that made the list churn every time you glanced at a project). Only real
 * activity in a workspace promotes it. These pure helpers encode that split:
 *
 *   - addOpened    → ensure membership, keep position (no promotion)
 *   - bumpActivity → move to the top (a turn ran, output arrived, a commit/push)
 *
 * main.ts owns the persisted file; this module is pure + unit-tested.
 */
export const RECENTS_CAP = 10;

/** Real things that promote a workspace to the top of the list. */
export type ActivityReason =
  | 'user-message' | 'agent-response' | 'tool-output' | 'background-task'
  | 'review-run' | 'commit' | 'push' | 'create-pr';

/** Ensure `root` is in the list WITHOUT promoting it. New projects land at the
 *  bottom (no activity yet); existing ones keep their place. Capped, but the
 *  just-opened project is never the one dropped. */
export function addOpened(list: string[], root: string, cap = RECENTS_CAP): string[] {
  if (list.includes(root)) return list.slice(0, Math.max(cap, list.length));
  const withNew = [...list, root];
  if (withNew.length <= cap) return withNew;
  // Over cap: keep the most-recent (cap-1) activity items + the new one at the bottom.
  return [...list.slice(0, cap - 1), root];
}

/** Promote `root` to the top after real activity. Dedupes + caps. */
export function bumpActivity(list: string[], root: string, cap = RECENTS_CAP): string[] {
  return [root, ...list.filter((w) => w !== root)].slice(0, cap);
}
