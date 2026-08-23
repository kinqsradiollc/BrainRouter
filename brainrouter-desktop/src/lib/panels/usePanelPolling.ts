/**
 * DESK-PERF — active-panel polling for stateful Desktop views.
 *
 * Side panels stay mounted while hidden so their local state survives a tab
 * switch. Polling must therefore follow visibility and never queue a second
 * bridge query while the previous refresh is still resolving.
 */
import React from 'react';

export interface PanelPoller {
  run(): Promise<boolean>;
}

export function createSingleFlightPoller(refresh: () => Promise<void>): PanelPoller {
  let inFlight = false;
  return {
    async run(): Promise<boolean> {
      if (inFlight) return false;
      inFlight = true;
      try {
        await refresh();
        return true;
      } finally {
        inFlight = false;
      }
    },
  };
}

export function usePanelPolling({
  active,
  intervalMs,
  refresh,
}: {
  active: boolean;
  intervalMs: number;
  refresh: () => Promise<void>;
}): void {
  const refreshRef = React.useRef(refresh);
  refreshRef.current = refresh;

  const pollerRef = React.useRef<PanelPoller | null>(null);
  if (pollerRef.current === null) {
    pollerRef.current = createSingleFlightPoller(() => refreshRef.current());
  }

  const pollIfVisible = React.useCallback((): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    void pollerRef.current?.run().catch(() => {
      // Panels surface their own refresh failures without creating unhandled work.
    });
  }, []);

  React.useEffect(() => {
    if (!active) return;
    pollIfVisible();
    const onVisibilityChange = (): void => pollIfVisible();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
    const timer = globalThis.setInterval(pollIfVisible, intervalMs);
    return () => {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
      globalThis.clearInterval(timer);
    };
  }, [active, intervalMs, pollIfVisible]);
}
