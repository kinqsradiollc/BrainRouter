/**
 * D26-1 — renderer-side appearance contract.
 *
 * The stored value is the user's preference; `data-theme` is always the
 * effective Light, Dark, or High Contrast mode. Keeping those concepts
 * separate lets System react to OS changes without overwriting the preference.
 */

export const APPEARANCE_PREFERENCES = ['system', 'light', 'dark', 'hc'] as const;

export type AppearancePreference = (typeof APPEARANCE_PREFERENCES)[number];
export type ResolvedAppearance = Exclude<AppearancePreference, 'system'>;

export interface DesktopAppearanceState {
  preference: AppearancePreference;
  resolved: ResolvedAppearance;
  dark: boolean;
  highContrast: boolean;
  reducedTransparency: boolean;
}

export const APPEARANCE_STORAGE_KEY = 'br-desktop-theme';

export function normalizeAppearancePreference(value: unknown): AppearancePreference {
  return typeof value === 'string' && APPEARANCE_PREFERENCES.includes(value as AppearancePreference)
    ? value as AppearancePreference
    : 'system';
}

export function resolveAppearance(
  preference: AppearancePreference,
  signals: Pick<DesktopAppearanceState, 'dark' | 'highContrast'>,
): ResolvedAppearance {
  if (signals.highContrast || preference === 'hc') return 'hc';
  if (preference === 'light' || preference === 'dark') return preference;
  return signals.dark ? 'dark' : 'light';
}

export function browserAppearanceState(preference: AppearancePreference): DesktopAppearanceState {
  const dark = globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;
  const highContrast = globalThis.matchMedia?.('(forced-colors: active)').matches
    ?? globalThis.matchMedia?.('(prefers-contrast: more)').matches
    ?? false;
  const reducedTransparency = globalThis.matchMedia?.('(prefers-reduced-transparency: reduce)').matches ?? false;
  return {
    preference,
    resolved: resolveAppearance(preference, { dark, highContrast }),
    dark,
    highContrast,
    reducedTransparency,
  };
}

export function initialAppearancePreference(
  storedValue: unknown,
  hostPreference?: unknown,
): AppearancePreference {
  if (typeof storedValue === 'string' && APPEARANCE_PREFERENCES.includes(storedValue as AppearancePreference)) {
    return storedValue as AppearancePreference;
  }
  return normalizeAppearancePreference(hostPreference);
}

export function applyAppearanceToDocument(
  preference: AppearancePreference,
  state: DesktopAppearanceState,
): void {
  const root = document.documentElement;
  root.dataset.appearance = preference;
  root.dataset.theme = resolveAppearance(preference, state);
  root.dataset.contrast = state.highContrast ? 'more' : 'normal';
  root.dataset.transparency = state.reducedTransparency ? 'reduced' : 'normal';
  root.style.colorScheme = root.dataset.theme === 'light' ? 'light' : 'dark';
}
