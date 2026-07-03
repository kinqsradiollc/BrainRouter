/**
 * App shell — window zoom factor (⌘+/⌘-/⌘0). Persisted to localStorage and
 * pushed to the Electron BrowserWindow (falls back to CSS `zoom` in the dev
 * browser). Extracted from App.tsx verbatim.
 */
import { useEffect, useState } from 'react';

export interface ZoomControls {
  zoomFactor: number;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
}

export function useZoom(): ZoomControls {
  const [zoomFactor, setZoomFactorState] = useState(() => {
    const saved = localStorage.getItem('br-zoom-factor');
    return saved ? parseFloat(saved) : 1.0;
  });

  const zoomIn = () => {
    setZoomFactorState((z) => {
      const next = Math.min(2.5, z + 0.1);
      localStorage.setItem('br-zoom-factor', next.toFixed(1));
      return next;
    });
  };

  const zoomOut = () => {
    setZoomFactorState((z) => {
      const next = Math.max(0.5, z - 0.1);
      localStorage.setItem('br-zoom-factor', next.toFixed(1));
      return next;
    });
  };

  const resetZoom = () => {
    setZoomFactorState(1.0);
    localStorage.setItem('br-zoom-factor', '1.0');
  };

  useEffect(() => {
    if (window.brainrouter && typeof window.brainrouter.setZoomFactor === 'function') {
      window.brainrouter.setZoomFactor(zoomFactor);
    } else if (document.body) {
      document.body.style.zoom = zoomFactor.toString();
    }
  }, [zoomFactor]);

  return { zoomFactor, zoomIn, zoomOut, resetZoom };
}
