/**
 * Item 9 (rest) — sidebar session pagination. The project's chat list showed a
 * fixed slice (7 expanded / 3 collapsed) with no way to reach older sessions.
 * These pure helpers grow the visible window a page at a time and collapse back,
 * so the whole history is reachable without dumping hundreds of rows at once.
 */
export const SESSION_BASE = 7;   // first page when expanded
export const SESSION_PAGE = 10;  // grow by this many per "Show more"

/** Next visible count when the show-more/fewer button is clicked: grow by a
 *  page, or collapse back to the base once everything is shown. */
export function toggleVisible(current: number, total: number, page = SESSION_PAGE, base = SESSION_BASE): number {
  if (current >= total) return Math.min(base, total); // all shown → collapse
  return Math.min(total, current + page);             // reveal one more page
}

/** Button label, or '' when there's nothing to toggle (list fits in the base). */
export function moreLabel(total: number, visible: number, base = SESSION_BASE): string {
  if (total <= base) return '';
  if (visible >= total) return 'Show fewer';
  return `Show ${total - visible} more`;
}

/** Whether the show-more/fewer button should render at all. */
export function showToggle(total: number, visible: number, base = SESSION_BASE): boolean {
  return total > base && (visible < total || visible > base);
}
