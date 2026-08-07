/**
 * ADR-029 E4 — quick find, the keyboard-first way to anything.
 *
 * **Nothing here scores anything.** The rows arrive from `notes-search`, which
 * is core's ranked search — prose above link-only, an id like `BR-114` matched
 * as well as the whole URI — and this component preserves the order it is
 * given. A second ranking in the renderer would put the same query in a
 * different order here than in the dashboard, and whoever saw both would be
 * right to conclude one of them is broken.
 *
 * The keyboard model is in `lib/notes/quickFind` for the same reason: "does the
 * selection wrap at the end" is a decision, and a decision that lives in a
 * keydown handler is one nobody can test.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../icons.js';
import type { NoteBlockView } from '../lib/notes/notesView.js';
import {
  moveQuickFindSelection, pageSizeNote, quickFindDefaultRows, quickFindEmptyNote,
  quickFindMatchNote, quickFindRows, type QuickFindHit, type QuickFindRow,
} from '../lib/notes/quickFind.js';

export function QuickFind({
  blocks, hits, query, onQuery, onOpen, onClose,
}: {
  blocks: NoteBlockView[];
  /** What `notes-search` last answered for `query`. */
  hits: QuickFindHit[];
  query: string;
  onQuery: (query: string) => void;
  onOpen: (row: QuickFindRow) => void;
  onClose: () => void;
}): React.ReactElement {
  const rows = useMemo(
    // An empty box offers the pages rather than nothing: ⌘K with nothing typed
    // is how people navigate when they know the page's name and cannot remember
    // a word from inside it.
    () => (query.trim() ? quickFindRows(hits, blocks) : quickFindDefaultRows(blocks)),
    [hits, blocks, query],
  );
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // A new answer means the row under the highlight is a different row, so the
  // highlight goes back to the top rather than staying on an index.
  useEffect(() => { setSelected(0); }, [query, hits]);

  useEffect(() => {
    listRef.current?.querySelector('.notes-qf-row.active')?.scrollIntoView({ block: 'nearest' });
  }, [selected, rows.length]);

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelected((i) => moveQuickFindSelection(rows.length, i, 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelected((i) => moveQuickFindSelection(rows.length, i, -1)); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      const row = rows[selected];
      if (row) onOpen(row);
    }
  };

  return createPortal(
    <div className="notes-qf-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="notes-qf" role="dialog" aria-label="Quick find" onKeyDown={onKeyDown}>
        <div className="notes-qf-input">
          <Icon name="search" size={13} />
          <input autoFocus value={query} placeholder="Find a page, a line, or what links to something"
            aria-label="Quick find" onChange={(e) => onQuery(e.target.value)} />
          <kbd className="notes-kbd">esc</kbd>
        </div>

        <div className="notes-qf-list" ref={listRef}>
          {rows.length === 0 ? (
            <p className="notes-qf-empty">{quickFindEmptyNote(query)}</p>
          ) : rows.map((row, index) => (
            <button
              key={row.blockId}
              className={`notes-qf-row${index === selected ? ' active' : ''}`}
              onMouseEnter={() => setSelected(index)}
              onClick={() => onOpen(row)}
            >
              <Icon name={row.isPage ? 'note' : 'plan'} size={12} />
              <span className="notes-qf-label">{row.label}</span>
              <span className="notes-qf-context">{row.context}</span>
              {/* B5 keeps the two halves apart: a row that matched only a LINK
                  has to say so, or it looks like a result for a word that is
                  not in it. */}
              {quickFindMatchNote(row) ? (
                <span className="notes-qf-note">{quickFindMatchNote(row)}</span>
              ) : null}
              {row.isPage ? (
                <span className="notes-qf-note">{pageSizeNote(blocks, row.pageId)}</span>
              ) : null}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
