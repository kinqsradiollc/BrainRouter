/**
 * DEV-only query-string flags (e.g. ?panels=diff,files) used to preset the
 * renderer when running under Vite. No-ops in a production build.
 */
import { type PanelId } from '../panels/index.js';
import { VALID_PANEL_IDS } from '../constants.js';

export function devSearchParams(): URLSearchParams | null {
  return import.meta.env.DEV ? new URLSearchParams(window.location.search) : null;
}

export function devFlag(name: string): boolean {
  const value = devSearchParams()?.get(name);
  return value === '1' || value === 'true';
}

export function devPanels(): PanelId[] {
  const raw = devSearchParams()?.get('panels');
  if (!raw) return [];
  return raw.split(',')
    .map((p) => p.trim())
    .filter((p): p is PanelId => VALID_PANEL_IDS.has(p as PanelId) && p !== 'terminal');
}
