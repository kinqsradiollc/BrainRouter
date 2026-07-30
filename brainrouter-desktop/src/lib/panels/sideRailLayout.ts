import type { PanelId } from '../../panels/index.js';

// Min matches the left sidebar's floor (~220) so the two panels feel consistent
// when shrunk; a touch wider keeps the panel labels + badges comfortable.
export const SIDE_RAIL_MIN = 240;
export const SIDE_RAIL_MAX = 760;

export function clampSideRailWidth(width: number): number {
  if (!Number.isFinite(width)) return 330;
  return Math.max(SIDE_RAIL_MIN, Math.min(SIDE_RAIL_MAX, Math.floor(width)));
}

/** Comfortable minimum width to open certain panels at — the Browser panel
 *  needs room for its icon rail + URL bar + webview. Panels not listed keep the
 *  current width. */
const OPEN_WIDTH: Partial<Record<PanelId, number>> = { browser: 500 };

/** The side width to use when a panel is opened: at least its comfortable
 *  default (if it has one), but never shrinking the user's current width. */
export function openWidthFor(id: PanelId, currentWidth: number): number {
  const pref = OPEN_WIDTH[id];
  return pref ? Math.max(currentWidth, clampSideRailWidth(pref)) : currentWidth;
}

export function sideRailClassName(closing: boolean, fullscreen: boolean): string {
  return ['views-rail', closing ? 'closing' : '', fullscreen ? 'fullscreen' : ''].filter(Boolean).join(' ');
}

export function sideRailFullscreenTitle(fullscreen: boolean): string {
  return fullscreen ? 'Restore panel width' : 'Enlarge panel';
}

/** A requested Environment surface never vanishes at a narrow effective width:
 * it changes from a layout column to a dismissible drawer. */
export function environmentPanelLayout(
  open: boolean,
  homeMode: boolean,
  hasColumnRoom: boolean,
): { mounted: boolean; drawer: boolean } {
  const mounted = open && !homeMode;
  return { mounted, drawer: mounted && !hasColumnRoom };
}

export function reorderByValue<T>(items: T[], dragged: T, target: T): T[] {
  const from = items.indexOf(dragged);
  const to = items.indexOf(target);
  if (from < 0 || to < 0 || from === to) return items;
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(from < to ? to - 1 : to, 0, item);
  return next;
}
