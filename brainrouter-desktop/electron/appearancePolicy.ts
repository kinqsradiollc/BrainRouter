/**
 * D26-1 — pure Desktop appearance policy shared by the Electron window
 * composition code and its node:test coverage.
 *
 * The policy deliberately contains no Electron or filesystem imports. Native
 * signals are inputs, so preference migration, effective-theme resolution, and
 * startup-canvas selection stay deterministic and independently testable.
 */

export const APPEARANCE_PREFERENCES = ['system', 'light', 'dark', 'hc'] as const;

export type AppearancePreference = (typeof APPEARANCE_PREFERENCES)[number];
export type ResolvedAppearance = Exclude<AppearancePreference, 'system'>;

export interface NativeAppearanceSignals {
  dark: boolean;
  highContrast: boolean;
  reducedTransparency: boolean;
}

export interface DesktopAppearanceState extends NativeAppearanceSignals {
  preference: AppearancePreference;
  resolved: ResolvedAppearance;
}

export function normalizeAppearancePreference(value: unknown): AppearancePreference {
  return typeof value === 'string' && APPEARANCE_PREFERENCES.includes(value as AppearancePreference)
    ? value as AppearancePreference
    : 'system';
}

export function resolveAppearance(
  preference: AppearancePreference,
  signals: NativeAppearanceSignals,
): ResolvedAppearance {
  if (signals.highContrast || preference === 'hc') return 'hc';
  if (preference === 'light' || preference === 'dark') return preference;
  return signals.dark ? 'dark' : 'light';
}

export function desktopAppearanceState(
  preference: AppearancePreference,
  signals: NativeAppearanceSignals,
): DesktopAppearanceState {
  return {
    preference,
    resolved: resolveAppearance(preference, signals),
    ...signals,
  };
}

export function nativeThemeSource(preference: AppearancePreference): 'system' | 'light' | 'dark' {
  if (preference === 'light') return 'light';
  if (preference === 'dark' || preference === 'hc') return 'dark';
  return 'system';
}

export function appearanceWindowBackground(resolved: ResolvedAppearance): string {
  if (resolved === 'light') return '#f8f7f5';
  if (resolved === 'hc') return '#0a0a0b';
  return '#0c0c0e';
}
