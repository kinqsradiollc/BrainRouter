/**
 * ADR-029 F3 — the two blocks that are prose with a shape around it.
 *
 * A toggle and a callout are not their own editing surfaces: both hold ordinary
 * text, with ordinary marks, an ordinary slash menu and ordinary Backspace
 * behaviour. What they add is a frame and one control. So they are FRAMES around
 * the block editor rather than replacements for it — a second editor inside a
 * callout would be a second place for E1's gestures to be implemented, and the
 * two would drift.
 *
 * They live in one file because they are one idea rendered twice. Splitting them
 * would suggest a callout and a toggle have different relationships to the
 * editor, and they do not.
 */
import React, { useState } from 'react';
import { IconPicker } from './IconPicker.js';
import { calloutIcon } from '../lib/notes/notesView.js';
import { toggleActionLabel } from '../lib/notes/blockVisibility.js';

/**
 * The disclosure triangle.
 *
 * `collapsed` is the block's OWN stamped field, not a set the shell keeps: a
 * fold is a decision about the document, so it is still folded when you come
 * back and on the other device too. What it hides is a display state — see
 * `blockVisibility.ts`, which is where the rule that a fold never hides text
 * from a search is written and tested.
 */
export function ToggleTwisty({ collapsed, childCount, disabled, onToggle }: {
  collapsed: boolean;
  childCount: number;
  disabled: boolean;
  onToggle: () => void;
}): React.ReactElement {
  const label = toggleActionLabel(collapsed, childCount);
  return (
    <button
      className={`notes-twisty${collapsed ? ' is-collapsed' : ''}`}
      // Disabled when the block is held by another device, for the same reason
      // its text is: a fold is a write, and a write under someone else's lease
      // is the one B2 exists to prevent.
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-expanded={!collapsed}
      onClick={onToggle}
    >
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
        <path d="M3 1.5 7 5 3 8.5Z" fill="currentColor" />
      </svg>
    </button>
  );
}

/**
 * A callout: an icon, and a tinted panel around whatever is written in it.
 *
 * The icon is `NoteBlock.icon` — the same stamped field a page's icon uses,
 * because `block.ts` decided it is "the same decision rendered in two places"
 * and two fields would need a rule for which one a callout inside a page uses.
 * It is edited with the page header's own picker for the same reason.
 *
 * The DEFAULT glyph is a rendering fallback and is never written: choosing one
 * later is the first edit to the field, so there is nothing stored for two
 * devices to disagree about until somebody actually picks.
 */
export function CalloutFrame({ icon, readOnly, onIcon, children }: {
  icon: string | null;
  readOnly: boolean;
  onIcon: (glyph: string) => void;
  children: React.ReactNode;
}): React.ReactElement {
  const [picking, setPicking] = useState(false);
  return (
    <div className="notes-callout">
      <button
        className="notes-callout-icon"
        disabled={readOnly}
        title={readOnly ? 'Another device is editing this block' : 'Change the icon'}
        aria-label="Callout icon"
        onClick={() => setPicking(true)}
      >
        {calloutIcon(icon)}
      </button>
      <div className="notes-callout-body">{children}</div>
      {picking ? (
        <IconPicker
          current={icon}
          onPick={(glyph) => { onIcon(glyph); setPicking(false); }}
          // No "remove": a callout with no glyph is a bordered paragraph, and a
          // frame with a gap where the icon goes reads as a load failure.
          onClose={() => setPicking(false)}
        />
      ) : null}
    </div>
  );
}
