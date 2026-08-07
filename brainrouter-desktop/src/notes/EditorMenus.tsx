/**
 * ADR-029 E1/E4 — the two surfaces that appear while you are typing.
 *
 * One menu component, two data sources: `/` fills it from core's slash catalog
 * and `@` fills it from the workspace. They are the same object on screen — a
 * short list under the caret, arrow keys, Enter — and building two of them is
 * how the keys end up behaving differently in each.
 *
 * Markup only. What opens a menu, what it contains, what picking does and how
 * the highlight wraps are decided in `lib/notes/slashMenu` and
 * `lib/notes/mentionPicker`; nothing here filters or ranks anything.
 */
import React from 'react';
import { Icon } from '../icons.js';
import { MARK_DELIMITERS, type InlineMark } from '@kinqs/brainrouter-core/notes/editing';

export interface CommandRow {
  id: string;
  label: string;
  /** The line under the label — what it is FOR, or which mode owns it. */
  hint?: string;
  /** The markdown that reaches the same thing without the menu (E1). */
  marker?: string;
  /** The catalog command or workspace candidate this row stands for. */
  value: unknown;
}

export function CommandMenu({ rows, index, empty, onPick, onHover }: {
  rows: readonly CommandRow[];
  index: number;
  empty: string;
  onPick: (row: CommandRow) => void;
  onHover: (index: number) => void;
}): React.ReactElement {
  return (
    <div className="notes-cmd" role="listbox">
      {rows.length === 0 ? <div className="notes-cmd-empty">{empty}</div> : null}
      {rows.map((row, at) => (
        <button
          key={row.id}
          type="button"
          role="option"
          aria-selected={at === index}
          className={`notes-cmd-row${at === index ? ' active' : ''}`}
          // The editor keeps the caret: a click that blurred it first would
          // close the menu before the pick landed.
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => onHover(at)}
          onClick={() => onPick(row)}
        >
          <span className="notes-cmd-label">{row.label}</span>
          {row.hint ? <span className="notes-cmd-hint">{row.hint}</span> : null}
          {/* E1 — the menu teaches the keyboard route to the same block, so the
              second time nobody opens the menu. */}
          {row.marker ? <span className="notes-cmd-marker">{row.marker.trim()}</span> : null}
        </button>
      ))}
    </div>
  );
}

/**
 * E4's floating toolbar, over a selection.
 *
 * It offers exactly what the shortcuts do, and says so: a person who used the
 * toolbar once should be able to stop using it. The delimiter beside each
 * button comes from core's table rather than being spelled here, so the label
 * cannot claim a syntax the parser does not read.
 */
const TOOLBAR: readonly { mark: InlineMark; label: string; keys: string }[] = [
  { mark: 'bold', label: 'B', keys: '⌘B' },
  { mark: 'italic', label: 'I', keys: '⌘I' },
  { mark: 'strike', label: 'S', keys: '⌘⇧S' },
  { mark: 'code', label: '‹›', keys: '⌘E' },
];

export function InlineToolbar({ left, top, onToggle, onLink }: {
  left: number;
  top: number;
  onToggle: (mark: InlineMark) => void;
  onLink: () => void;
}): React.ReactElement {
  return (
    <div className="notes-toolbar" style={{ left, top }} onMouseDown={(event) => event.preventDefault()}>
      {TOOLBAR.map((entry) => (
        <button
          key={entry.mark}
          type="button"
          className={`notes-toolbar-btn is-${entry.mark}`}
          title={`${entry.keys}  ${MARK_DELIMITERS[entry.mark]}text${MARK_DELIMITERS[entry.mark]}`}
          onClick={() => onToggle(entry.mark)}
        >
          {entry.label}
        </button>
      ))}
      <button type="button" className="notes-toolbar-btn" title="⌘K — link to anything in the workspace" onClick={onLink}>
        <Icon name="link" size={11} />
      </button>
    </div>
  );
}
