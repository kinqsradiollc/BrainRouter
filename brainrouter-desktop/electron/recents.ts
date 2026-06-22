/**
 * Project (workspace) ordering for the sidebar. The recents list is
 * USER-ORDERED and stable.
 *
 * Opening, switching to, viewing, or running activity in a project must NOT move
 * it to the top. Only an explicit user drag/drop reorder changes position.
 *
 *   - addOpened        → ensure membership, keep position
 *   - noteActivity     → ensure membership, keep position
 *   - reorderWorkspace → explicit drag/drop order change
 *
 * main.ts owns the persisted file; this module is pure + unit-tested.
 */
export const RECENTS_CAP = 10;

/** Real activity reasons; activity changes badges/state, not user ordering. */
export type ActivityReason =
  | 'user-message' | 'agent-response' | 'tool-output' | 'background-task'
  | 'review-run' | 'commit' | 'push' | 'create-pr';

/** Ensure `root` is in the list WITHOUT promoting it. New projects land at the
 *  bottom (no activity yet); existing ones keep their place. Capped, but the
 *  just-opened project is never the one dropped. */
export function addOpened(list: string[], root: string, cap = RECENTS_CAP): string[] {
  const unique = [...new Set(list)];
  if (unique.includes(root)) return unique.slice(0, Math.max(cap, unique.length));
  const withNew = [...unique, root];
  if (withNew.length <= cap) return withNew;
  // Over cap: keep the most-recent (cap-1) activity items + the new one at the bottom.
  return [...unique.slice(0, cap - 1), root];
}

/** Ensure activity roots are present without moving existing projects. */
export function noteActivity(list: string[], root: string, cap = RECENTS_CAP): string[] {
  return addOpened(list, root, cap);
}

/** Move `dragged` before `target` for explicit user-controlled project order. */
export function reorderWorkspace(list: string[], dragged: string, target: string, cap = RECENTS_CAP): string[] {
  const unique = [...new Set(list)].slice(0, Math.max(cap, list.length));
  const from = unique.indexOf(dragged);
  const to = unique.indexOf(target);
  if (from < 0 || to < 0 || from === to) return unique.slice(0, cap);
  const next = [...unique];
  const [item] = next.splice(from, 1);
  next.splice(from < to ? to - 1 : to, 0, item);
  return next.slice(0, cap);
}
