/**
 * DESK-5w (#4 lag) — the turn's elapsed-seconds ticker, isolated into its own
 * component with its own 1s interval. Previously a top-level `nowTick` state
 * re-rendered the ENTIRE App every second; now only this tiny node updates.
 */
import React, { useEffect, useReducer, useRef } from 'react';

export function WorkElapsed({ startedAt }: { startedAt: number }): React.ReactElement {
  const [, force] = useReducer((n: number) => n + 1, 0);
  // Captured once at mount as a safe fallback base.
  const mountedAt = useRef(Date.now());
  useEffect(() => {
    const t = setInterval(force, 1000);
    return () => clearInterval(t);
  }, []);
  // Guard the base: a missing (0 / undefined) or seconds-epoch `startedAt` would
  // otherwise render Date.now()/1000 ≈ 1.78e9 "seconds" (the "1781944796s" bug
  // on a bootstrapping session, before submit() writes turnStart). A real ms
  // epoch is ≥ 1e12; anything else falls back to this component's own mount
  // time, so the ticker always shows a sane elapsed.
  const base = Number.isFinite(startedAt) && startedAt >= 1e12 ? startedAt : mountedAt.current;
  return <span>{Math.max(0, Math.floor((Date.now() - base) / 1000))}s</span>;
}
