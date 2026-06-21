/**
 * TrackDropdown — a themed replacement for native <select> inside Track.
 *
 * Native selects render an OS-drawn option list we can't theme (so they never
 * match the app) and truncate long labels. This renders the trigger with the
 * shared select chrome and portals the menu to <body> with fixed positioning —
 * so it adopts the app's frosted popover, shows full labels, and never clips
 * inside scrolling containers (the detail drawer, columns, forms).
 */
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../icons.js';

export interface DropdownOption { value: string; label: string }

interface Rect { left: number; top: number; bottom: number; width: number }

export function TrackDropdown({
  value, options, onChange, placeholder, disabled, title, className,
}: {
  value: string;
  options: DropdownOption[];
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  title?: string;
  className?: string;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<Rect | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const current = options.find((o) => o.value === value);

  const openMenu = (): void => {
    if (disabled) return;
    const el = triggerRef.current;
    if (el) { const r = el.getBoundingClientRect(); setRect({ left: r.left, top: r.top, bottom: r.bottom, width: r.width }); }
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      const t = e.target as HTMLElement;
      if (!triggerRef.current?.contains(t) && !t.closest?.('.track-dd-menu')) setOpen(false);
    };
    const close = (): void => setOpen(false);
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => { document.removeEventListener('mousedown', onDoc); window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [open]);

  // Flip the menu upward when there isn't room below the trigger.
  const estH = Math.min(280, options.length * 32 + 10);
  const flipUp = rect ? (window.innerHeight - rect.bottom) < estH && rect.top > (window.innerHeight - rect.bottom) : false;

  return (
    <div className={`track-dd${disabled ? ' disabled' : ''}${className ? ` ${className}` : ''}`} title={title}>
      <button type="button" ref={triggerRef} className="track-dd-trigger" disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}>
        <span className={current ? 'track-dd-val' : 'track-dd-ph'}>{current?.label ?? placeholder ?? 'Select…'}</span>
        <Icon name="chev-down" size={11} />
      </button>
      {open && rect ? createPortal(
        <div className="track-dd-menu" style={{
          position: 'fixed', left: rect.left, width: Math.max(rect.width, 170), maxHeight: 280,
          ...(flipUp ? { bottom: window.innerHeight - rect.top + 5 } : { top: rect.bottom + 5 }),
        }}>
          {options.map((o) => (
            <button type="button" key={o.value} className={`track-dd-item${o.value === value ? ' active' : ''}`}
              onClick={() => { onChange(o.value); setOpen(false); }}>
              <span className="track-dd-check">{o.value === value ? '✓' : ''}</span>
              <span className="track-dd-label">{o.label}</span>
            </button>
          ))}
        </div>, document.body) : null}
    </div>
  );
}
