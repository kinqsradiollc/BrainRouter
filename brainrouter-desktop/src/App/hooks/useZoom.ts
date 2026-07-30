/**
 * App shell — window zoom factor (⌘+/⌘-/⌘0). Persisted to localStorage and
 * pushed to the Electron BrowserWindow (falls back to CSS `zoom` in the dev
 * browser). Extracted from App.tsx verbatim.
 */
import { useEffect, useState } from 'react';

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 2.5;
export const ZOOM_STEP = 0.1;
export const ZOOM_LEVELS = Object.freeze([
  0.5, 0.6, 0.67, 0.7, 0.8, 0.9,
  1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9,
  2, 2.1, 2.2, 2.3, 2.4, 2.5,
]);
// The native macOS traffic lights do not participate in Electron's web-content
// zoom. Keep the first application control anchored just beyond their logical
// right edge by expressing that edge in inverse-zoomed CSS pixels.
export const MAC_WINDOW_CONTROLS_END = 74;

export function normalizeZoom(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(parsed)) return 1;
  const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, parsed));
  return ZOOM_LEVELS.reduce((closest, level) => (
    Math.abs(level - clamped) <= Math.abs(closest - clamped) ? level : closest
  ));
}

export function stepZoom(value: unknown, direction: 1 | -1): number {
  const normalized = normalizeZoom(value);
  const current = ZOOM_LEVELS.indexOf(normalized);
  const next = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, current + direction));
  return ZOOM_LEVELS[next];
}

export function serializeZoom(value: unknown): string {
  return String(normalizeZoom(value));
}

export function windowControlsInlineEnd(value: unknown): number {
  return Number((MAC_WINDOW_CONTROLS_END / normalizeZoom(value)).toFixed(3));
}

export interface ZoomControls {
  zoomFactor: number;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
}

export function useZoom(): ZoomControls {
  const [zoomFactor, setZoomFactorState] = useState(() => {
    const saved = localStorage.getItem('br-zoom-factor');
    return normalizeZoom(saved ?? 1);
  });

  const zoomIn = () => {
    setZoomFactorState((z) => {
      const next = stepZoom(z, 1);
      localStorage.setItem('br-zoom-factor', serializeZoom(next));
      return next;
    });
  };

  const zoomOut = () => {
    setZoomFactorState((z) => {
      const next = stepZoom(z, -1);
      localStorage.setItem('br-zoom-factor', serializeZoom(next));
      return next;
    });
  };

  const resetZoom = () => {
    setZoomFactorState(1.0);
    localStorage.setItem('br-zoom-factor', '1.0');
  };

  useEffect(() => {
    document.documentElement.style.setProperty(
      '--window-controls-inline-end',
      `${windowControlsInlineEnd(zoomFactor)}px`,
    );
    if (window.brainrouter && typeof window.brainrouter.setZoomFactor === 'function') {
      window.brainrouter.setZoomFactor(zoomFactor);
    } else if (document.body) {
      document.body.style.zoom = zoomFactor.toString();
    }
    // Native child views (the in-app browser) are positioned in un-zoomed window
    // pixels, so a zoom change must recompute their bounds. Nudge layout listeners
    // once the new zoom has been applied, or the page view overflows its panel.
    const id = requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    return () => cancelAnimationFrame(id);
  }, [zoomFactor]);

  return { zoomFactor, zoomIn, zoomOut, resetZoom };
}
