export const SIDE_RAIL_MIN = 320;
export const SIDE_RAIL_MAX = 760;

export function clampSideRailWidth(width: number): number {
  if (!Number.isFinite(width)) return 330;
  return Math.max(SIDE_RAIL_MIN, Math.min(SIDE_RAIL_MAX, Math.floor(width)));
}

export function sideRailClassName(closing: boolean, fullscreen: boolean): string {
  return ['views-rail', closing ? 'closing' : '', fullscreen ? 'fullscreen' : ''].filter(Boolean).join(' ');
}

export function sideRailFullscreenTitle(fullscreen: boolean): string {
  return fullscreen ? 'Restore panel width' : 'Enlarge panel';
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
