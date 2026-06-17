/**
 * DESK-5f — animated presence: keeps a surface mounted through its exit
 * animation. `closing` drives a `.closing` class whose keyframes reverse the
 * entry animation; the node unmounts when they finish.
 */
import { useEffect, useState } from 'react';

export function useClosable(open: boolean, ms = 170): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (open) { setMounted(true); setClosing(false); return; }
    setClosing(true);
    const t = setTimeout(() => { setMounted(false); setClosing(false); }, ms);
    return () => clearTimeout(t);
  }, [open, ms]);
  return { mounted: mounted || open, closing };
}
