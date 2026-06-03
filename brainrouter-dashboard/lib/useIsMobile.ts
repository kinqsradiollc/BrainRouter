import { useEffect, useState } from "react";

/**
 * SSR-safe viewport breakpoint hook.
 *
 * Returns `true` once the client mounts AND the viewport is at/under
 * `breakpoint` (px). It deliberately starts `false` so the server render and
 * the first client render agree (no hydration mismatch) — the real value is
 * applied in a layout effect after mount, then kept live via matchMedia.
 *
 * 768px is the dashboard's phone/tablet-portrait line: below it the sticky
 * sidebar becomes an off-canvas drawer and the top bar collapses.
 */
export function useIsMobile(breakpoint = 768): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const update = () => setIsMobile(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, [breakpoint]);

  return isMobile;
}
