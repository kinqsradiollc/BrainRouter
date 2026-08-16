/**
 * ADR-029 E4 + F3 — the glyph picker, once.
 *
 * This was inside `PageHeader` while a page was the only thing with an icon.
 * Part F gives a callout one, and `NoteBlock.icon` is deliberately ONE field for
 * both — "the same decision rendered in two places", as `block.ts` puts it — so
 * a second picker beside this one would be two controls writing one field with
 * two different palettes, and the callout someone made on a page would offer
 * glyphs the page's own icon could not have.
 *
 * The popover is PORTALED to `<body>`. Both call sites sit in a scrolling
 * column, and an absolutely-positioned menu inside one is clipped by the first
 * ancestor with `overflow` — the same reason a native `<select>` is unusable
 * anywhere in this app.
 */
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PAGE_ICON_CHOICES } from './pageHeader.js';

/**
 * A field that commits on Enter or on the button, and not on every keystroke.
 *
 * An address typed a character at a time would write "h", "ht", "htt" into the
 * block — each one a stamped edit in the outbox (D2), each one syncing, and
 * every intermediate value a broken image on every other device.
 */
export function TextField({ label, value, placeholder, onSubmit }: {
  label: string;
  value: string;
  placeholder: string;
  onSubmit: (value: string) => void;
}): React.ReactElement {
  const [draft, setDraft] = useState(value);
  return (
    <div className="notes-popover-field">
      <label className="notes-popover-label">{label}</label>
      <div className="notes-popover-row">
        <input className="filter" autoFocus value={draft} placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onSubmit(draft.trim()); }} />
        <button className="notes-popover-ok" onClick={() => onSubmit(draft.trim())}>Set</button>
      </div>
    </div>
  );
}

/** Portaled to `<body>` so a scrolling column cannot clip it. */
export function Popover({ children, onClose }: {
  children: React.ReactNode;
  onClose: () => void;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    // Deferred a tick: the click that OPENED the popover is still propagating,
    // and a listener added synchronously catches it and closes immediately.
    const timer = window.setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    document.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return createPortal(
    <div className="notes-popover-scrim">
      <div className="notes-popover" ref={ref}>{children}</div>
    </div>,
    document.body,
  );
}

/**
 * Pick a glyph, paste one, or take the current one away.
 *
 * `onClear` is optional because the two call sites differ about what "no icon"
 * means: a page with none falls back to a generic document mark, while a callout
 * with none renders the default glyph rather than nothing — a callout is a
 * framed aside and a frame with a gap where the icon goes reads as a load
 * failure.
 */
export function IconPicker({ current, onPick, onClear, onClose }: {
  current: string | null;
  onPick: (glyph: string) => void;
  onClear?: () => void;
  onClose: () => void;
}): React.ReactElement {
  return (
    <Popover onClose={onClose}>
      <div className="notes-icon-grid">
        {PAGE_ICON_CHOICES.map((glyph) => (
          <button key={glyph} className="notes-icon-choice" onClick={() => onPick(glyph)}>{glyph}</button>
        ))}
      </div>
      {/* Any character, not only the palette's — the grid is a shortcut, and a
          picker that refused a glyph someone pasted would be the only place in
          the app where their own text was rejected. */}
      <TextField
        label="Or paste a character" value={current ?? ''} placeholder="🙂"
        onSubmit={(value) => onPick(value)}
      />
      {current && onClear ? (
        <button className="notes-popover-clear" onClick={onClear}>Remove icon</button>
      ) : null}
    </Popover>
  );
}
