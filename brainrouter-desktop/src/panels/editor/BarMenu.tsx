/**
 * BarMenu — a compact action menu styled as a toolbar .btn with a caret. Click to
 * drop a portaled popover of actions (so it never clips inside the editor's
 * scrolling chrome). Used to fold the Editor Markdown bar's Export and Selection-AI
 * actions into single tidy controls instead of a row of buttons.
 */
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface BarMenuItem { label: string; onSelect: () => void; disabled?: boolean; hint?: string }

export function BarMenu({ label, items, disabled, title, icon }: {
  label: string;
  items: BarMenuItem[];
  disabled?: boolean;
  title?: string;
  icon?: React.ReactNode;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<{ left: number; right: number; top: number; bottom: number } | null>(null);
  const ref = useRef<HTMLButtonElement>(null);

  const openMenu = (): void => {
    if (disabled) return;
    const el = ref.current;
    if (el) { const r = el.getBoundingClientRect(); setRect({ left: r.left, right: r.right, top: r.top, bottom: r.bottom }); }
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      const t = e.target as HTMLElement;
      if (!ref.current?.contains(t) && !t.closest?.('.bar-menu-pop')) setOpen(false);
    };
    const close = (): void => setOpen(false);
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => { document.removeEventListener('mousedown', onDoc); window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [open]);

  return (
    <div className="bar-menu" title={title}>
      <button type="button" ref={ref} className={`btn bar-menu-trigger${open ? ' on' : ''}`} disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}>
        {icon}{label}<span className="bar-menu-caret">▾</span>
      </button>
      {open && rect ? createPortal(
        <div className="bar-menu-pop" style={{
          position: 'fixed',
          top: rect.bottom + 4,
          minWidth: 184,
          // Right-align to the trigger when it sits in the right portion of the
          // window (Export lives at the bar's right edge), else left-align — so the
          // menu never clips off-screen.
          ...(rect.left > window.innerWidth * 0.6
            ? { right: Math.max(8, window.innerWidth - rect.right) }
            : { left: rect.left }),
        }}>
          {items.map((it) => (
            <button type="button" key={it.label} className="bar-menu-item" disabled={it.disabled}
              onClick={() => { setOpen(false); it.onSelect(); }}>
              <span className="bar-menu-item-label">{it.label}</span>
              {it.hint ? <span className="bar-menu-item-hint">{it.hint}</span> : null}
            </button>
          ))}
        </div>, document.body) : null}
    </div>
  );
}
