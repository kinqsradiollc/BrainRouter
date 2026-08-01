/**
 * D26-1 — owns the Desktop appearance preference and effective theme.
 *
 * The hook migrates the renderer's existing local preference into the native
 * host store, subscribes to operating-system changes through the bounded
 * preload bridge, and keeps browser-dev useful through matchMedia fallbacks.
 */
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import {
  APPEARANCE_STORAGE_KEY,
  applyAppearanceToDocument,
  browserAppearanceState,
  initialAppearancePreference,
  resolveAppearance,
  type AppearancePreference,
  type DesktopAppearanceState,
} from '../../lib/theme/appearance.js';

function hostAppearanceState(): DesktopAppearanceState | null {
  return window.brainrouter.appearance?.getState?.() ?? null;
}

function initialState(preference: AppearancePreference): DesktopAppearanceState {
  const host = hostAppearanceState();
  if (!host) return browserAppearanceState(preference);
  return { ...host, preference, resolved: resolveAppearance(preference, host) };
}

export function bootstrapAppearanceDocument(): void {
  const host = hostAppearanceState();
  const stored = localStorage.getItem(APPEARANCE_STORAGE_KEY);
  const preference = initialAppearancePreference(stored, host?.preference);
  applyAppearanceToDocument(preference, host
    ? { ...host, preference, resolved: resolveAppearance(preference, host) }
    : browserAppearanceState(preference));
}

export function useAppearance(): {
  preference: AppearancePreference;
  resolved: DesktopAppearanceState['resolved'];
  setPreference: (preference: AppearancePreference) => void;
} {
  const host = hostAppearanceState();
  const [preference, setPreferenceState] = useState<AppearancePreference>(() =>
    initialAppearancePreference(localStorage.getItem(APPEARANCE_STORAGE_KEY), host?.preference));
  const [state, setState] = useState<DesktopAppearanceState>(() => initialState(preference));

  const setPreference = useCallback((next: AppearancePreference): void => {
    setPreferenceState(next);
    setState((current) => ({
      ...current,
      preference: next,
      resolved: resolveAppearance(next, current),
    }));
  }, []);

  useLayoutEffect(() => {
    applyAppearanceToDocument(preference, state);
  }, [preference, state]);

  useEffect(() => {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, preference);
    const request = window.brainrouter.appearance?.setPreference?.(preference);
    if (request) {
      void request.then((next) => {
        setState({ ...next, preference, resolved: resolveAppearance(preference, next) });
      }).catch(() => undefined);
    }
  }, [preference]);

  useEffect(() => {
    const off = window.brainrouter.appearance?.onChanged?.((next) => {
      setState((current) => ({
        ...next,
        preference: current.preference,
        resolved: resolveAppearance(current.preference, next),
      }));
    });
    if (off) return off;

    const queries = [
      globalThis.matchMedia?.('(prefers-color-scheme: dark)'),
      globalThis.matchMedia?.('(forced-colors: active)'),
      globalThis.matchMedia?.('(prefers-contrast: more)'),
      globalThis.matchMedia?.('(prefers-reduced-transparency: reduce)'),
    ].filter((query): query is MediaQueryList => Boolean(query));
    const update = (): void => setState(browserAppearanceState(preference));
    for (const query of queries) query.addEventListener('change', update);
    return () => {
      for (const query of queries) query.removeEventListener('change', update);
    };
  }, [preference]);

  return { preference, resolved: state.resolved, setPreference };
}
