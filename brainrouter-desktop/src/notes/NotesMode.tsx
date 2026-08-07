/**
 * ADR-029 Part B + E4 — the Notes mode.
 *
 * A sixth workspace mode beside Chat · Code · Track · Meetings · Planner. Notes
 * are user-scoped and cross-project (D1), so like the planner this is a MODE
 * rather than a panel: panels are bound to one workspace and one session, and
 * putting a cross-workspace surface inside a workspace-scoped container is the
 * scoping error ADR-028 D9 recorded.
 *
 * The unit is a block (B1) and a page is a block with children (B4), so the
 * sidebar tree, the breadcrumbs and a page's body are all one recursion over
 * `parentId` — there is no page table any of them could disagree about.
 *
 * **A page's body is the blocks whose NEAREST PAGE ANCESTOR is this page**, not
 * every block. A sub-page appears as one row rather than as its contents:
 * rendering the subtree inline would put the whole workspace on every page, and
 * there would be no gesture that opens a sub-page because it would already be
 * open.
 *
 * This component renders. Every judgement — what is editable and why, what a
 * placeholder says, what nests where, what a drag means, what an empty section
 * offers — comes from `lib/notes/*`.
 */
import React, { useMemo, useState } from 'react';
import { Icon } from '../icons.js';
import { RefChip } from '../components/workspace/RefChip.js';
import { NotesSidebar } from './NotesSidebar.js';
import { PageHeader } from './PageHeader.js';
import { QuickFind } from './QuickFind.js';
import {
  backlinkNote, canEdit, conflictBanner, conflictLine, emptyMessage, indentFor,
  placeholderFor, readOnlyReason, repairNote, sendTargetsFor,
  visibleBlocks,
  type NoteBlockView, type NoteSendTarget, type NoteTreeRepairView,
} from '../lib/notes/notesView.js';
import { pageBodyBlocks, type PageMoveIntent } from '../lib/notes/pageTree.js';
import { pageHeaderView } from '../lib/notes/pageHeader.js';
import type { FavouriteRow, TrashEntryDto } from '../lib/notes/sidebar.js';
import type { QuickFindHit, QuickFindRow } from '../lib/notes/quickFind.js';

/** Everything the shell around the editor is currently showing. */
export interface NotesShellState {
  /** Which page is open. Null is the top level, which is a real page (B4). */
  pageId: string | null;
  expanded: ReadonlySet<string>;
  favourites: FavouriteRow[];
  trash: TrashEntryDto[];
  quickFindOpen: boolean;
  quickFindQuery: string;
  quickFindHits: QuickFindHit[];
}

export interface NotesOps {
  addBlock: (afterId: string | null, kind?: string) => void;
  /** E4 — a page at any level: the sidebar's button, a row's `+`, the header's. */
  addPage: (parentId: string | null) => void;
  openPage: (pageId: string | null) => void;
  toggleExpanded: (pageId: string) => void;
  /** Drag to reorder and to reparent — the tree's only write. */
  movePage: (intent: PageMoveIntent) => void;
  /** B4/E2 — the title IS the page block's text, so this is one field. */
  setPageTitle: (id: string, title: string) => void;
  setIcon: (id: string, icon: string) => void;
  setCover: (id: string, cover: string) => void;
  setFavourite: (id: string, favourite: boolean) => void;
  /** C5 — a tombstone taken back, with the subtree that went with it. */
  restore: (id: string) => void;
  openQuickFind: () => void;
  closeQuickFind: () => void;
  quickFindQuery: (query: string) => void;
  setText: (id: string, text: string) => void;
  setKind: (id: string, kind: string) => void;
  toggleChecked: (id: string, checked: boolean) => void;
  deleteBlock: (id: string) => void;
  /** Tab / Shift-Tab. B4's nesting is the same recursion as a sub-page. */
  indent: (id: string) => void;
  outdent: (id: string) => void;
  /** B2 — take the lease on focus, drop it on blur. */
  beginEdit: (id: string) => void;
  endEdit: (id: string) => void;
  resolveConflict: (id: string, field: string, keep: 'ours' | 'theirs') => void;
  /** C2 — a line becomes a work item or a planner task, and cites it back. */
  sendTo: (id: string, target: NoteSendTarget) => void;
  /**
   * C2 — Notes → Code: cite a file, or one symbol in it.
   *
   * The symbol is the half that survives an edit rather than only a move: a
   * function keeps its name when someone reorders the file around it, and
   * `#L59` does not.
   */
  linkFile: (id: string, relPath: string, symbol?: string) => void;
  /** The declarations of the file being considered, asked for when it is picked. */
  loadSymbols: (relPath: string) => void;
  /** Follow a reference to whatever it addresses. */
  openRef: (uri: string) => void;
  /** B5 — the ranked search, which lives in core and is asked for by id. */
  search: (query: string) => void;
  /** A2 — what links to this block. Asked for when the menu opens, not before. */
  loadBacklinks: (id: string) => void;
}

/** One declaration a file makes, as the picker offers it. */
export interface CodeSymbolPick {
  name: string;
  line: number;
  kind: string;
}

export function NotesMode({
  blocks, repairs, syncState, refLabels, files, symbols, matchIds, backlinkCounts, shell, ops,
}: {
  blocks: NoteBlockView[];
  repairs: NoteTreeRepairView[];
  syncState: string;
  /** A3 — resolved labels, read now rather than stored on the link. */
  refLabels: Record<string, string>;
  /** Workspace-relative paths offered by the file picker. */
  files: string[];
  /** Declarations by path, absent until that file has been read. */
  symbols: Record<string, CodeSymbolPick[]>;
  /** B5's hits by block id, or null when nothing has been searched for. */
  matchIds: ReadonlySet<string> | null;
  backlinkCounts: Record<string, number>;
  shell: NotesShellState;
  ops: NotesOps;
}): React.ReactElement {
  const [query, setQuery] = useState('');
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [linkFor, setLinkFor] = useState<string | null>(null);
  const header = useMemo(() => pageHeaderView(blocks, shell.pageId), [blocks, shell.pageId]);
  const page = shell.pageId === null ? null : blocks.find((b) => b.id === shell.pageId) ?? null;
  // The in-page search filters the PAGE, not the workspace — ⌘K is the one that
  // crosses pages. A filter box that quietly removed lines from other pages
  // would report a page as empty because of a word typed while reading it.
  const body = useMemo(() => pageBodyBlocks(blocks, shell.pageId), [blocks, shell.pageId]);
  const visible = useMemo(() => visibleBlocks(body, matchIds), [body, matchIds]);
  const banner = conflictBanner(blocks);

  return (
    <div className="notes-mode">
      <NotesSidebar
        blocks={blocks} favourites={shell.favourites} trash={shell.trash}
        pageId={shell.pageId} expanded={shell.expanded} ops={ops}
      />

      <div className="notes-page">
        <header className="notes-head">
          <div className="notes-actions">
            <input className="filter notes-filter" placeholder="Search this page and what it links to"
              value={query} onChange={(e) => { setQuery(e.target.value); ops.search(e.target.value); }} />
          </div>
          {/* Sync runs on its own (B3/D2). The line reports state as a fact;
              offline is the normal mode that happens to be syncing. */}
          <span className="notes-sync">{syncState}</span>
        </header>

        {banner ? <div className="notes-conflict-banner">{banner}</div> : null}

        {repairs.map((repair) => (
          <div key={repair.blockId} className="notes-repair">{repairNote(repair)}</div>
        ))}

        <div className="notes-body scroll">
          <PageHeader view={header} block={page} ops={ops} />

          {visible.length === 0 ? (
            <p className="notes-empty">{query ? 'Nothing on this page matches.' : emptyMessage()}</p>
          ) : null}

          {visible.map((block) => (block.kind === 'page' ? (
            <SubPageRow key={block.id} block={block} onOpen={() => ops.openPage(block.id)} />
          ) : (
            <BlockRow
              key={block.id} block={block} refLabels={refLabels} ops={ops}
              backlinkCount={backlinkCounts[block.id] ?? 0}
              menuOpen={menuFor === block.id}
              onMenu={() => {
                const opening = menuFor !== block.id;
                setMenuFor(opening ? block.id : null);
                if (opening) ops.loadBacklinks(block.id);
              }}
              linkOpen={linkFor === block.id}
              onLink={() => { setLinkFor(linkFor === block.id ? null : block.id); setMenuFor(null); }}
              files={files}
              symbols={symbols}
            />
          )))}

          <button className="notes-add-line" onClick={() => ops.addBlock(null)}>
            <Icon name="plus" size={11} />
            {visible.length > 0 ? ' Add a line' : ' Write the first line'}
          </button>
        </div>
      </div>

      {shell.quickFindOpen ? (
        <QuickFind
          blocks={blocks} hits={shell.quickFindHits} query={shell.quickFindQuery}
          onQuery={ops.quickFindQuery}
          onOpen={(row: QuickFindRow) => { ops.openPage(row.pageId); ops.closeQuickFind(); }}
          onClose={ops.closeQuickFind}
        />
      ) : null}
    </div>
  );
}

/**
 * A sub-page inside a page's body — one row, not its contents (B4).
 *
 * It is a link rather than a text field even though a page block HAS text,
 * because that text is the page's title and it is edited in the page's own
 * header. Two editable copies of one title on one screen is E2's mistake in
 * miniature: the person edits whichever is nearer and the other looks stale.
 */
function SubPageRow({ block, onOpen }: {
  block: NoteBlockView;
  onOpen: () => void;
}): React.ReactElement {
  return (
    <div className="notes-block" data-kind="page" style={{ paddingLeft: indentFor(block.depth) }}>
      <button className="notes-subpage" onClick={onOpen}>
        <span className="notes-subpage-icon">{block.icon ?? <Icon name="note" size={12} />}</span>
        <span className="notes-subpage-title">{block.title ?? block.text}</span>
      </button>
    </div>
  );
}

function BlockRow({
  block, refLabels, ops, backlinkCount, menuOpen, onMenu, linkOpen, onLink, files, symbols,
}: {
  block: NoteBlockView;
  refLabels: Record<string, string>;
  ops: NotesOps;
  /** A2 — how many blocks link HERE, computed from their text, not stored here. */
  backlinkCount: number;
  menuOpen: boolean;
  onMenu: () => void;
  linkOpen: boolean;
  onLink: () => void;
  files: string[];
  symbols: Record<string, CodeSymbolPick[]>;
}): React.ReactElement {
  const locked = readOnlyReason(block);
  const editable = canEdit(block);
  const targets = sendTargetsFor(block);

  return (
    <div className="notes-block" data-kind={block.kind} style={{ paddingLeft: indentFor(block.depth) }}>
      <div className="notes-block-main">
        {block.kind === 'todo' ? (
          <input type="checkbox" checked={block.checked} disabled={!editable}
            aria-label="Done" onChange={(e) => ops.toggleChecked(block.id, e.target.checked)} />
        ) : null}

        {block.kind === 'divider' ? (
          <hr className="notes-divider" />
        ) : (
          <textarea
            className={`notes-text notes-text-${block.kind}`}
            rows={1}
            value={block.text}
            readOnly={!editable}
            placeholder={placeholderFor(block.kind)}
            onFocus={() => ops.beginEdit(block.id)}
            onBlur={() => ops.endEdit(block.id)}
            onChange={(e) => ops.setText(block.id, e.target.value)}
            onKeyDown={(e) => {
              // Enter makes the next line, Tab nests it. The two gestures an
              // outliner is: anything else is a menu, and a menu is not typing.
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ops.addBlock(block.id); }
              if (e.key === 'Tab') { e.preventDefault(); e.shiftKey ? ops.outdent(block.id) : ops.indent(block.id); }
            }}
          />
        )}

        <div className="notes-block-tools">
          <button className="notes-icon-btn" title="Link a file" aria-label="Link a file" onClick={onLink}>
            <Icon name="link" size={12} />
          </button>
          <button className="notes-icon-btn" title="Block actions" aria-label="Block actions" onClick={onMenu}>
            <Icon name="dots" size={12} />
          </button>
        </div>
      </div>

      {/* B2 — read-only WITH an attribution. A silently disabled field reads as
          the app being broken; naming the other device is what makes the block
          being locked information rather than a fault. */}
      {locked ? <div className="notes-locked">{locked}</div> : null}

      {block.refs.length > 0 ? (
        <div className="notes-refs">
          {block.refs.map((uri) => (
            // A3 — the chip shows the target's CURRENT state, including
            // "(deleted 4 Aug)". Snapshotting the label at insert time is what
            // produces documents that are quietly wrong. The chip itself is the
            // shared one, so the planner cannot render the same reference
            // differently.
            <RefChip key={uri} uri={uri} label={refLabels[uri]} onOpen={ops.openRef} />
          ))}
        </div>
      ) : null}

      {block.conflicts.map((conflict) => (
        <div key={conflict.field} className="notes-conflict">
          <span>{conflictLine(conflict)}</span>
          <button onClick={() => ops.resolveConflict(block.id, conflict.field, 'ours')}>Keep mine</button>
          <button onClick={() => ops.resolveConflict(block.id, conflict.field, 'theirs')}>Keep theirs</button>
        </div>
      ))}

      {linkOpen ? (
        <FilePicker
          files={files} symbols={symbols} onLoadSymbols={(p) => ops.loadSymbols(p)}
          onPick={(p, symbol) => { ops.linkFile(block.id, p, symbol); onLink(); }}
        />
      ) : null}

      {menuOpen ? (
        <div className="notes-menu" role="menu">
          {backlinkNote(backlinkCount) ? (
            <div className="notes-backlinks">{backlinkNote(backlinkCount)}</div>
          ) : null}
          {targets.map((target) => (
            <button key={target.id} role="menuitem" onClick={() => { ops.sendTo(block.id, target); onMenu(); }}>
              {target.label}
            </button>
          ))}
          {(['paragraph', 'heading', 'todo', 'bullet', 'quote', 'code', 'divider'] as const).map((kind) => (
            <button key={kind} role="menuitem" disabled={block.kind === kind}
              onClick={() => { ops.setKind(block.id, kind); onMenu(); }}>
              Turn into {kind}
            </button>
          ))}
          <button role="menuitem" className="danger" onClick={() => { ops.deleteBlock(block.id); onMenu(); }}>
            Delete
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * C2's Notes → Code row, in two steps: which file, then which part of it.
 *
 * A path picked from the workspace rather than typed, because a reference to a
 * file that does not exist resolves as a tombstone and the person who typed the
 * typo has no way to tell that apart from a file someone deleted. The SYMBOL is
 * picked for the same reason and from the same evidence: the list is the
 * declarations the resolver itself recognises, so the picker cannot offer a
 * name that resolution will then fail to find.
 */
function FilePicker({ files, symbols, onLoadSymbols, onPick }: {
  files: string[];
  symbols: Record<string, CodeSymbolPick[]>;
  onLoadSymbols: (path: string) => void;
  onPick: (path: string, symbol?: string) => void;
}): React.ReactElement {
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (needle ? files.filter((f) => f.toLowerCase().includes(needle)) : files).slice(0, 8);
  }, [files, query]);

  if (chosen) {
    // Absent means "not read yet"; an empty array means "read, and it declares
    // nothing this recognises". Collapsing the two would make a slow read look
    // like a file with no functions in it.
    const declared = symbols[chosen];
    return (
      <div className="notes-linkpicker">
        <div className="notes-linkpicker-head">
          <button className="notes-linkpicker-back" onClick={() => setChosen(null)}>← Files</button>
          <span className="notes-linkpicker-path" title={chosen}>{chosen}</span>
        </div>
        <button className="notes-linkpicker-item" onClick={() => onPick(chosen)}>Link the whole file</button>
        {(declared ?? []).map((symbol) => (
          <button key={`${symbol.name}:${symbol.line}`} className="notes-linkpicker-item"
            onClick={() => onPick(chosen, symbol.name)}>
            {symbol.name} <small>{symbol.kind} · line {symbol.line}</small>
          </button>
        ))}
        {declared === undefined ? <span className="notes-linkpicker-empty">Reading its declarations…</span> : null}
        {declared?.length === 0
          ? <span className="notes-linkpicker-empty">Nothing declared here to point at.</span>
          : null}
      </div>
    );
  }

  return (
    <div className="notes-linkpicker">
      <input className="filter" autoFocus placeholder="Which file?" value={query}
        onChange={(e) => setQuery(e.target.value)} />
      {matches.map((file) => (
        <button key={file} className="notes-linkpicker-item"
          onClick={() => { setChosen(file); onLoadSymbols(file); }}>{file}</button>
      ))}
      {matches.length === 0 ? <span className="notes-linkpicker-empty">No file matches.</span> : null}
    </div>
  );
}
