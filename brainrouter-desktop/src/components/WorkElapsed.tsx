/**
 * DESK-5w (#4 lag) — the turn's elapsed-seconds ticker, isolated into its own
 * component with its own 1s interval. Previously a top-level `nowTick` state
 * re-rendered the ENTIRE App every second; now only this tiny node updates.
 */
import React, { useEffect, useReducer } from 'react';

export function WorkElapsed({ startedAt }: { startedAt: number }): React.ReactElement {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const t = setInterval(force, 1000);
    return () => clearInterval(t);
  }, []);
  return <span>{Math.max(0, Math.floor((Date.now() - startedAt) / 1000))}s</span>;
}
