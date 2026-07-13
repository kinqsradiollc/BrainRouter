/**
 * App shell — window zoom factor (⌘+/⌘-/⌘0). Persisted to localStorage and
 * pushed to the Electron BrowserWindow (falls back to CSS `zoom` in the dev
 * browser). Extracted from App.tsx verbatim.
 */
import { useEffect, useState } from 'react';

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 2.5;
export const ZOOM_STEP = 0.1;
// The native macOS traffic lights do not participate in Electron's web-content
// zoom. Keep the first application control anchored just beyond their logical
// right edge by expressing that edge in inverse-zoomed CSS pixels.
export const MAC_WINDOW_CONTROLS_END = 74;

export function normalizeZoom(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(parsed * 10) / 10));
}

export function stepZoom(value: unknown, direction: 1 | -1): number {
  return normalizeZoom(normalizeZoom(value) + direction * ZOOM_STEP);
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
      localStorage.setItem('br-zoom-factor', next.toFixed(1));
      return next;
    });
  };

  const zoomOut = () => {
    setZoomFactorState((z) => {
      const next = stepZoom(z, -1);
      localStorage.setItem('br-zoom-factor', next.toFixed(1));
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
  }, [zoomFactor]);

  return { zoomFactor, zoomIn, zoomOut, resetZoom };
}
