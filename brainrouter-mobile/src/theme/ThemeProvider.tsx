/**
 * ThemeProvider — exposes the design tokens to the tree and supports a runtime
 * theme (dark/light) + accent override, mirroring the desktop's runtime accent
 * (`App.tsx` accent override). Read with `useTheme()`.
 */
import React, { createContext, useContext, useMemo, useState, useCallback } from 'react';
import {
  type ThemeName,
  type ThemeTokens,
  themes,
  defaultTheme,
  withAccent,
} from './tokens';

interface ThemeContextValue {
  theme: ThemeTokens;
  themeName: ThemeName;
  setThemeName: (name: ThemeName) => void;
  /** Override the chromatic accent at runtime; pass undefined to reset. */
  setAccent: (accent: string | undefined) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export interface ThemeProviderProps {
  children: React.ReactNode;
  initialTheme?: ThemeName;
  initialAccent?: string;
}

export function ThemeProvider({
  children,
  initialTheme = defaultTheme.name,
  initialAccent,
}: ThemeProviderProps): React.JSX.Element {
  const [themeName, setThemeName] = useState<ThemeName>(initialTheme);
  const [accent, setAccent] = useState<string | undefined>(initialAccent);

  const theme = useMemo<ThemeTokens>(() => {
    const base = themes[themeName];
    return accent ? withAccent(base, accent) : base;
  }, [themeName, accent]);

  const setAccentCb = useCallback((next: string | undefined) => setAccent(next), []);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, themeName, setThemeName, setAccent: setAccentCb }),
    [theme, themeName, setAccentCb],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeTokens {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx.theme;
}

export function useThemeControls(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useThemeControls must be used within a ThemeProvider');
  return ctx;
}
