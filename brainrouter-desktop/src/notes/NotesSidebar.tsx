/**
 * ADR-029 E4 — the sidebar: favourites, the page tree, and the trash.
 *
 * B4 makes this one recursion over `parentId` rather than a page table, so
 * every row here is a block. The component renders and reports gestures; what a
 * row is called, what nests where, what a drag MEANS and what an empty section
 * says all come from `lib/notes/pageTree` and `lib/notes/sidebar`.
 *
 * **The drag is the part worth reading.** A drop is refused before it is sent
 * rather than repaired afterwards: `parentId` merges last-writer-wins, so the
 * store would accept a page dropped inside its own subtree and the tree builder
 * would then break the cycle by detaching a member — which the person sees as
 * the page they dragged jumping to the top level on its own.
 */
import React, { useMemo, useState } from 'react';
import { Icon } from '../icons.js';
import type { NoteBlockView } from '../lib/notes/notesView.js';
import {
  buildPageTree, dropPositionInRow, pageDropIntent, pageTreeRows,
  type PageDropPosition, type PageMoveIntent, type PageTreeRow,
} from '../lib/notes/pageTree.js';
import { newPageLabel, favouriteActionLabel } from '../lib/notes/pageHeader.js';
import {
  initialOpenSections, restorePromise, SIDEBAR_EMPTY, SIDEBAR_SECTIONS, trashRows,
  type FavouriteRow, type SidebarSection, type TrashEntryDto,
} from '../lib/notes/sidebar.js';

export interface NotesSidebarOps {
  openPage: (pageId: string | null) => void;
  toggleExpanded: (pageId: string) => void;
  addPage: (parentId: string | null) => void;
  movePage: (intent: PageMoveIntent) => void;
  setFavourite: (id: string, favourite: boolean) => void;
  restore: (id: string) => void;
  openQuickFind: () => void;
}

interface DropMark { id: string | null; position: PageDropPosition }

export function NotesSidebar({
  blocks, favourites, trash, pageId, expanded, ops,
}: {
  blocks: NoteBlockView[];
  favourites: FavouriteRow[];
  trash: TrashEntryDto[];
  pageId: string | null;
  expanded: ReadonlySet<string>;
  ops: NotesSidebarOps;
}): React.ReactElement {
  const rows = useMemo(() => pageTreeRows(buildPageTree(blocks), expanded), [blocks, expanded]);
  const bin = useMemo(() => trashRows(trash), [trash]);
  // Opened once from the first answer, then owned by the person: recomputing it
  // per render would slam a section shut the moment they unfavourited a page.
  const [open, setOpen] = useState<Set<SidebarSection>>(() => initialOpenSections(favourites.length));
  const [dragId, setDragId] = useState<string | null>(null);
  const [mark, setMark] = useState<DropMark | null>(null);

  const toggleSection = (id: SidebarSection): void => {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const finishDrag = (targetId: string | null, position: PageDropPosition): void => {
    const intent = dragId === null ? null : pageDropIntent(blocks, dragId, targetId, position);
    setDragId(null);
    setMark(null);
    if (intent) ops.movePage(intent);
  };

  return (
    <aside className="notes-sidebar">
      <div className="notes-sidebar-head">
        <button className="notes-sidebar-find" onClick={ops.openQuickFind}
          title="Find a page or a line (⌘K)">
          <Icon name="search" size={12} /> <span>Quick find</span>
          <kbd className="notes-kbd">⌘K</kbd>
        </button>
      </div>

      {SIDEBAR_SECTIONS.map((section) => (
        <section key={section.id} className="notes-sidebar-section">
          <div className="notes-sidebar-section-head">
            <button className="notes-sidebar-section-btn" onClick={() => toggleSection(section.id)}
              aria-expanded={open.has(section.id)}>
              <Icon name={open.has(section.id) ? 'chev-down' : 'chev-right'} size={10} />
              <span>{section.label}</span>
            </button>
            {section.id === 'pages' ? (
              <button className="notes-sidebar-add" title={newPageLabel(null)}
                aria-label={newPageLabel(null)} onClick={() => ops.addPage(null)}>
                <Icon name="plus" size={11} />
              </button>
            ) : null}
          </div>

          {!open.has(section.id) ? null : section.id === 'favourites' ? (
            favourites.length === 0
              ? <p className="notes-sidebar-empty">{SIDEBAR_EMPTY.favourites}</p>
              : favourites.map((row) => (
                <button key={row.id} className={`notes-tree-label${pageId === row.id ? ' active' : ''}`}
                  onClick={() => ops.openPage(row.id)}>
                  <span className="notes-tree-icon">{row.icon ?? <Icon name="note" size={11} />}</span>
                  <span className="notes-tree-title">{row.title}</span>
                </button>
              ))
          ) : section.id === 'pages' ? (
            <div
              className="notes-tree"
              /* The background is the top level as a drop target, which is the
                 only gesture that can pull a page OUT of its parent when its
                 parent is the row directly above it. */
              onDragOver={(e) => { if (dragId) { e.preventDefault(); setMark({ id: null, position: 'inside' }); } }}
              onDrop={(e) => { e.preventDefault(); finishDrag(null, 'inside'); }}
            >
              {rows.length === 0 ? <p className="notes-sidebar-empty">{SIDEBAR_EMPTY.pages}</p> : null}
              {rows.map((row) => (
                <TreeRow
                  key={row.node.id} row={row} selected={pageId === row.node.id}
                  dragging={dragId === row.node.id}
                  mark={mark && mark.id === row.node.id ? mark.position : null}
                  ops={ops}
                  onDragStart={() => setDragId(row.node.id)}
                  onDragEnd={() => { setDragId(null); setMark(null); }}
                  onDragOver={(position) => { if (dragId) setMark({ id: row.node.id, position }); }}
                  onDrop={(position) => finishDrag(row.node.id, position)}
                />
              ))}
            </div>
          ) : (
            bin.length === 0
              ? <p className="notes-sidebar-empty">{SIDEBAR_EMPTY.trash}</p>
              : bin.map((row) => (
                <div key={row.id} className="notes-trash-row">
                  <span className="notes-trash-line" title={row.line}>{row.line}</span>
                  <button className="notes-trash-restore" title={restorePromise(row)}
                    onClick={() => ops.restore(row.id)}>Restore</button>
                </div>
              ))
          )}
        </section>
      ))}
    </aside>
  );
}

function TreeRow({
  row, selected, dragging, mark, ops, onDragStart, onDragEnd, onDragOver, onDrop,
}: {
  row: PageTreeRow;
  selected: boolean;
  dragging: boolean;
  /** Where a drop would land, while the pointer is over this row. */
  mark: PageDropPosition | null;
  ops: NotesSidebarOps;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: (position: PageDropPosition) => void;
  onDrop: (position: PageDropPosition) => void;
}): React.ReactElement {
  const { node } = row;

  const readPosition = (e: React.DragEvent<HTMLDivElement>): PageDropPosition => {
    const rect = e.currentTarget.getBoundingClientRect();
    return dropPositionInRow(e.clientY - rect.top, rect.height);
  };

  return (
    <div
      className={[
        'notes-tree-row',
        selected ? 'active' : '',
        dragging ? 'dragging' : '',
        mark ? `drop-${mark}` : '',
      ].filter(Boolean).join(' ')}
      style={{ paddingLeft: 6 + row.depth * 12 }}
      draggable
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; onDragStart(); }}
      onDragEnd={onDragEnd}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); onDragOver(readPosition(e)); }}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); onDrop(readPosition(e)); }}
    >
      {/* A leaf keeps the twisty's WIDTH and loses its glyph, so titles at one
          depth line up whether or not they have children. */}
      {row.hasChildren ? (
        <button className="notes-tree-twisty" aria-label={row.expanded ? 'Collapse' : 'Expand'}
          onClick={() => ops.toggleExpanded(node.id)}>
          <Icon name={row.expanded ? 'chev-down' : 'chev-right'} size={10} />
        </button>
      ) : <span className="notes-tree-twisty" />}

      <button className="notes-tree-label" onClick={() => ops.openPage(node.id)}>
        {/* E3 — a database opens as a full page, and its children are its rows.
            Marked with its own glyph so the twisty expanding into a list of
            rows is expected rather than surprising. */}
        <span className="notes-tree-icon">
          {node.icon ?? <Icon name={node.database ? 'panels' : 'note'} size={11} />}
        </span>
        <span className="notes-tree-title">{node.title}</span>
      </button>

      <button className="notes-tree-act" title={favouriteActionLabel(node.favourite)}
        aria-label={favouriteActionLabel(node.favourite)}
        onClick={() => ops.setFavourite(node.id, !node.favourite)}>
        <Icon name="pin" size={11} />
      </button>
      {/* A database's children are ROWS, and a row is made by the database's own
          control — which also opens it. A "new page inside" here would create a
          row with no way back to the table that owns it. */}
      {node.database ? null : (
        <button className="notes-tree-act" title={newPageLabel(node.title)}
          aria-label={newPageLabel(node.title)} onClick={() => ops.addPage(node.id)}>
          <Icon name="plus" size={11} />
        </button>
      )}
    </div>
  );
}
