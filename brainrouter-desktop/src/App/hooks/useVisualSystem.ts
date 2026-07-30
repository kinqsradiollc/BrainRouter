import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import {
  VISUAL_SYSTEM_STORAGE_KEY,
  applyVisualSystemToDocument,
  visualSystemEnabled,
} from '../../lib/theme/visualSystem.js';

export function bootstrapVisualSystemDocument(): void {
  applyVisualSystemToDocument(
    visualSystemEnabled(localStorage.getItem(VISUAL_SYSTEM_STORAGE_KEY)),
  );
}

export function useVisualSystem(): {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
} {
  const [enabled, setEnabledState] = useState(
    () => visualSystemEnabled(localStorage.getItem(VISUAL_SYSTEM_STORAGE_KEY)),
  );

  const setEnabled = useCallback((next: boolean): void => {
    setEnabledState(next);
  }, []);

  useLayoutEffect(() => {
    applyVisualSystemToDocument(enabled);
  }, [enabled]);

  useEffect(() => {
    localStorage.setItem(VISUAL_SYSTEM_STORAGE_KEY, String(enabled));
  }, [enabled]);

  return { enabled, setEnabled };
}
