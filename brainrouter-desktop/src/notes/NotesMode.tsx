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
 * This component renders and orchestrates the PAGE — which block has the caret,
 * which blocks are selected, what a drag is currently over. Everything a
 * keystroke or a drag MEANS comes from `lib/notes/*`, and everything it DOES is
 * a call into core through the host: a page here has no opinion about where a
 * split's tail goes.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../icons.js';
import { NotesSidebar } from './NotesSidebar.js';
import { PageHeader } from './PageHeader.js';
import { QuickFind } from './QuickFind.js';
import { BlockRow } from './BlockRow.js';
import { DatabaseBlock } from './DatabaseBlock.js';
import type { DatabaseHostOps } from './databaseOps.js';
import {
  conflictBanner, emptyMessage, indentFor, repairNote, visibleBlocks,
  type NoteBlockView, type NoteSendTarget, type NoteTreeRepairView,
} from '../lib/notes/notesView.js';
import { caretForColumn } from '../lib/notes/blockEditing.js';
import {
  blockDropIntent, extendSelection, selectedBlockIds,
  type BlockAction, type BlockSelection, type PageDropPosition,
} from '../lib/notes/blockSelection.js';
import { pageBodyBlocks, type PageMoveIntent } from '../lib/notes/pageTree.js';
import { pageHeaderView } from '../lib/notes/pageHeader.js';
import type { BlockIntent } from '../lib/notes/blockKeymap.js';
import type { SlashCommandDto, SlashPlan } from '../lib/notes/slashMenu.js';
import type { MentionCandidate } from '../lib/notes/mentionPicker.js';
import type { InputRuleTransformDto } from '../lib/notes/blockEditing.js';
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

/**
 * What a gesture that changed the document reports back.
 *
 * `focusId` and `caret` are the whole point: core decides where the caret
 * belongs after a split, a merge or a duplicate, and a surface that guessed
 * would put it somewhere else than the dashboard does for the same keystroke.
 */
export interface BlockOpOutcome {
  ok: boolean;
  focusId?: string | null;
  caret?: number;
  createdId?: string;
}

export interface NotesOps {
  /** Returns the new block, so the caret can go into it. */
  addBlock: (afterId: string | null, kind?: string, level?: number) => Promise<{ id: string } | null>;
  /** E4 — a page at any level: the sidebar's button, a row's `+`, the header's. */
  addPage: (parentId: string | null) => void;
  openPage: (pageId: string | null) => void;
  toggleExpanded: (pageId: string) => void;
  /** Drag to reorder and to reparent — the tree's only write. */
  movePage: (intent: PageMoveIntent) => void;
  /**
   * The same write as `movePage`, under the name the body's drag uses.
   *
   * B4 makes a page a block, so moving a paragraph and moving a page are one
   * operation — but a call site that said `movePage` while dragging a
   * paragraph would read as a bug, and the sidebar's would read as one if it
   * said `moveBlock`.
   */
  moveBlock: (intent: PageMoveIntent) => void;
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
  setKind: (id: string, kind: string, level?: number) => void;
  toggleChecked: (id: string, checked: boolean) => void;
  deleteBlock: (id: string) => void;

  /* E1 — the gestures. Every one is core's, reached through the host. */
  splitBlock: (id: string, caret: number) => Promise<BlockOpOutcome | null>;
  mergeBack: (id: string) => Promise<BlockOpOutcome | null>;
  duplicate: (id: string) => Promise<BlockOpOutcome | null>;
  moveUp: (id: string) => Promise<BlockOpOutcome | null>;
  moveDown: (id: string) => Promise<BlockOpOutcome | null>;
  /** Tab / Shift-Tab. B4's nesting is the same recursion as a sub-page. */
  indent: (id: string) => Promise<BlockOpOutcome | null>;
  outdent: (id: string) => Promise<BlockOpOutcome | null>;

  /** E1 — what `# ` means, decided in core and asked for per marker. */
  inputRule: (request: {
    kind: string; text: string; caret: number; level?: number;
  }) => Promise<InputRuleTransformDto | null>;
  applyRule: (id: string, transform: InputRuleTransformDto) => void;
  /** E1 — core's catalog, ranked in core. Never a second list in a component. */
  searchSlash: (query: string) => Promise<SlashCommandDto[]>;
  /** E5 — what an `@` can address: every mode, not only another page. */
  searchMentions: (query: string) => Promise<MentionCandidate[]>;
  /** A1 — the block's address, on the clipboard. */
  copyLink: (id: string) => void;

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

  /**
   * E3 — databases. Every one of these is a `notes-database-*` handler, so the
   * filter, the sort and the grouping are core's and a row is a page.
   */
  database: DatabaseHostOps;
  /** E3 — `/database` makes one here, in the page being read. */
  addDatabase: (parentId: string | null, after?: string) => void;
}

/** One declaration a file makes, as the picker offers it. */
export interface CodeSymbolPick {
  name: string;
  line: number;
  kind: string;
}

export function NotesMode({
  blocks, repairs, syncState, refLabels, files, symbols, matchIds, backlinkCounts,
  shell, ops, revision,
}: {
  blocks: NoteBlockView[];
  repairs: NoteTreeRepairView[];
  syncState: string;
  /** Bumped after every write, so an open database re-reads its projection. */
  revision: number;
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
  const [selection, setSelection] = useState<BlockSelection | null>(null);
  const [focus, setFocus] = useState<{ blockId: string; caret: number; token: number } | null>(null);
  const focusToken = useRef(0);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ id: string | null; position: PageDropPosition } | null>(null);
  const [commands, setCommands] = useState<SlashCommandDto[]>([]);

  const header = useMemo(() => pageHeaderView(blocks, shell.pageId), [blocks, shell.pageId]);
  const page = shell.pageId === null ? null : blocks.find((b) => b.id === shell.pageId) ?? null;
  // E3 — a database opened as a full page. It is a container like a page (its
  // children are its rows), so it is a destination the shell can be on; what
  // changes is that the database renders its own children instead of the body.
  const fullPageDatabase = page?.kind === 'database' ? page : null;
  // The in-page search filters the PAGE, not the workspace — ⌘K is the one that
  // crosses pages. A filter box that quietly removed lines from other pages
  // would report a page as empty because of a word typed while reading it.
  const body = useMemo(() => pageBodyBlocks(blocks, shell.pageId), [blocks, shell.pageId]);
  const visible = useMemo(() => visibleBlocks(body, matchIds), [body, matchIds]);
  const banner = conflictBanner(blocks);
  const selectedIds = useMemo(() => selectedBlockIds(visible, selection), [visible, selection]);

  // The handle's "turn into" list is core's catalog, loaded once. A component
  // that built its own would offer a different set from the slash menu one line
  // above it.
  useEffect(() => {
    void ops.searchSlash('').then(setCommands).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const focusBlock = useCallback((id: string | null | undefined, caret: number) => {
    if (!id) return;
    focusToken.current += 1;
    setFocus({ blockId: id, caret: Math.max(0, caret), token: focusToken.current });
  }, []);

  /** The next block a caret can actually enter — a sub-page row has no editor. */
  const nextEditable = useCallback((fromId: string, direction: -1 | 1): NoteBlockView | null => {
    const index = visible.findIndex((block) => block.id === fromId);
    if (index < 0) return null;
    for (let at = index + direction; at >= 0 && at < visible.length; at += direction) {
      const candidate = visible[at]!;
      // A sub-page row, a divider and a database have no text field, so a caret
      // arriving at one would land nowhere and the arrow would look broken.
      if (candidate.kind !== 'page' && candidate.kind !== 'divider' && candidate.kind !== 'database') {
        return candidate;
      }
    }
    return null;
  }, [visible]);

  /** Which blocks an action applies to — the selection, or just this one (E4). */
  const actionTargets = useCallback((block: NoteBlockView): string[] => (
    selectedIds.length > 1 && selectedIds.includes(block.id) ? selectedIds : [block.id]
  ), [selectedIds]);

  const runIntent = useCallback(async (
    block: NoteBlockView, intent: BlockIntent, at: { text: string; caret: number },
  ): Promise<void> => {
    switch (intent.kind) {
      case 'split': {
        const outcome = await ops.splitBlock(block.id, at.caret);
        focusBlock(outcome?.focusId ?? block.id, outcome?.caret ?? 0);
        return;
      }
      case 'merge-back': {
        const outcome = await ops.mergeBack(block.id);
        // Core reports where the two halves joined, which is the only offset
        // that is not the start or the end of something.
        focusBlock(outcome?.focusId ?? block.id, outcome?.caret ?? 0);
        return;
      }
      case 'indent':
      case 'outdent': {
        const outcome = intent.kind === 'indent' ? await ops.indent(block.id) : await ops.outdent(block.id);
        // The text did not change, so the caret should not either. Core answers
        // 0 because it has no opinion about a caret it did not move.
        focusBlock(outcome?.focusId ?? block.id, at.caret);
        return;
      }
      case 'move-up':
      case 'move-down': {
        for (const id of actionTargets(block)) {
          // eslint-disable-next-line no-await-in-loop
          await (intent.kind === 'move-up' ? ops.moveUp(id) : ops.moveDown(id));
        }
        focusBlock(block.id, at.caret);
        return;
      }
      case 'duplicate': {
        let last: BlockOpOutcome | null = null;
        for (const id of actionTargets(block)) {
          // eslint-disable-next-line no-await-in-loop
          last = await ops.duplicate(id);
        }
        focusBlock(last?.createdId ?? last?.focusId ?? block.id, 0);
        return;
      }
      case 'caret-up':
      case 'caret-down': {
        const direction = intent.kind === 'caret-up' ? -1 : 1;
        const neighbour = nextEditable(block.id, direction);
        if (!neighbour) return;
        setSelection(null);
        // The column is preserved as closely as the neighbour allows: arriving
        // in the middle of a word two lines down is not "the same column".
        focusBlock(neighbour.id, caretForColumn(neighbour.text, intent.column, direction < 0 ? 'last' : 'first'));
        return;
      }
      case 'select-up':
      case 'select-down':
        setSelection((current) => extendSelection(
          visible, current, block.id, intent.kind === 'select-up' ? -1 : 1,
        ));
        return;
      default:
    }
  }, [actionTargets, focusBlock, nextEditable, ops, visible]);

  const onSlashPlan = useCallback((
    block: NoteBlockView, plan: SlashPlan, at: { text: string; caret: number },
  ): void => {
    // The block's own text is written in every branch: the marker has already
    // been taken out of it locally, and a branch that forgot would leave `/todo`
    // in the document the next time the store answered.
    ops.setText(block.id, at.text);

    // E3 — `/database` goes through `notes-database-create` rather than through
    // `notes-create` with a kind, so the block arrives with the schema and the
    // table view core's own defaults give it. Checked before `set-kind` because
    // that branch would otherwise turn the paragraph into a database block with
    // neither, which reads as a database that failed to load.
    if (plan.action !== 'create-page' && plan.kind === 'database') {
      ops.addDatabase(shell.pageId, block.id);
      // The line the command was typed on is consumed when it held nothing else,
      // which is what `set-kind` does for every other kind. Its rank is already
      // spent: core reads `after` when it creates, not later.
      if (at.text.trim().length === 0) ops.deleteBlock(block.id);
      return;
    }

    if (plan.action === 'set-kind') {
      ops.setKind(block.id, plan.kind, plan.level);
      focusBlock(block.id, at.caret);
      return;
    }
    if (plan.action === 'create-page') {
      // Inside the page being read, not beside the block: a sub-page belongs to
      // the page (B4), and `addPage` opens it because the gesture is "start
      // writing here".
      ops.addPage(shell.pageId);
      return;
    }
    void ops.addBlock(block.id, plan.kind, plan.level).then((created) => focusBlock(created?.id, 0));
  }, [focusBlock, ops, shell.pageId]);

  const onAction = useCallback((block: NoteBlockView, action: BlockAction): void => {
    const ids = actionTargets(block);
    setMenuFor(null);
    if (action === 'copy-link') { ops.copyLink(block.id); return; }
    if (action === 'duplicate') { void runIntent(block, { kind: 'duplicate' }, { text: block.text, caret: 0 }); return; }
    if (action === 'delete') {
      const above = nextEditable(ids[0]!, -1);
      for (const id of ids) ops.deleteBlock(id);
      setSelection(null);
      if (above) focusBlock(above.id, above.text.length);
    }
  }, [actionTargets, focusBlock, nextEditable, ops, runIntent]);

  const onTurnInto = useCallback((block: NoteBlockView, command: SlashCommandDto): void => {
    for (const id of actionTargets(block)) ops.setKind(id, command.kind, command.level);
    setMenuFor(null);
  }, [actionTargets, ops]);

  const onSelectFrom = useCallback((block: NoteBlockView, extend: boolean): void => {
    setSelection((current) => (extend
      ? { anchorId: current?.anchorId ?? block.id, focusId: block.id }
      : { anchorId: block.id, focusId: block.id }));
  }, []);

  const dropOn = useCallback((targetId: string | null, position: PageDropPosition): void => {
    const intent = dragId ? blockDropIntent(blocks, dragId, targetId, position, shell.pageId) : null;
    if (intent) ops.moveBlock(intent);
    setDragId(null);
    setDropHint(null);
  }, [blocks, dragId, ops, shell.pageId]);

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

        <div
          className="notes-body scroll"
          // E4 — one keystroke over several blocks. Captured before the focused
          // block sees it, or Backspace would merge one line while several were
          // selected.
          onKeyDownCapture={(event) => {
            if (selectedIds.length <= 1) return;
            if (event.key !== 'Backspace' && event.key !== 'Delete') return;
            event.preventDefault();
            const first = visible.find((block) => block.id === selectedIds[0]);
            if (first) onAction(first, 'delete');
          }}
          onDragOver={(event) => { if (dragId) { event.preventDefault(); setDropHint({ id: null, position: 'inside' }); } }}
          onDrop={(event) => { if (dragId) { event.preventDefault(); dropOn(null, 'inside'); } }}
        >
          <PageHeader view={header} block={page} ops={ops} />

          {/* E3 — a full-page database. Its children are its ROWS, so the body
              list below would render each of them as a sub-page row beside the
              table showing the same rows. The database renders them once. */}
          {fullPageDatabase ? (
            <DatabaseBlock
              databaseId={fullPageDatabase.id}
              host={ops.database}
              refLabels={refLabels}
              revision={revision}
              full
            />
          ) : null}

          {!fullPageDatabase && visible.length === 0 ? (
            <p className="notes-empty">{query ? 'Nothing on this page matches.' : emptyMessage()}</p>
          ) : null}

          {(fullPageDatabase ? [] : visible).map((block) => (block.kind === 'page' ? (
            <SubPageRow key={block.id} block={block} onOpen={() => ops.openPage(block.id)} />
          ) : block.kind === 'database' ? (
            // E3 — a database is a BLOCK, so it nests wherever a block can and
            // the page around it keeps working: the same component renders it
            // here and as a full page.
            <div key={block.id} className="notes-block" data-kind="database" style={{ paddingLeft: indentFor(block.depth) }}>
              <DatabaseBlock
                databaseId={block.id}
                host={ops.database}
                refLabels={refLabels}
                revision={revision}
              />
            </div>
          ) : (
            <BlockRow
              key={block.id}
              block={block}
              blocks={blocks}
              pageId={shell.pageId}
              refLabels={refLabels}
              ops={ops}
              commands={commands}
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
              selected={selectedIds.length > 1 && selectedIds.includes(block.id)}
              selectedCount={selectedIds.includes(block.id) ? selectedIds.length : 1}
              focusRequest={focus && focus.blockId === block.id ? { caret: focus.caret, token: focus.token } : null}
              onIntent={(target, intent, at) => void runIntent(target, intent, at)}
              onSlashPlan={onSlashPlan}
              onAction={onAction}
              onTurnInto={onTurnInto}
              onSelectFrom={onSelectFrom}
              drag={{
                dragging: dragId === block.id,
                hint: dropHint && dropHint.id === block.id ? dropHint.position : null,
                onStart: (target) => setDragId(target.id),
                onEnd: () => { setDragId(null); setDropHint(null); },
                onOver: (target, position) => setDropHint({ id: target.id, position }),
                onDrop: (target, position) => dropOn(target.id, position),
              }}
            />
          )))}

          {/* A full-page database has no prose body to add a line to — its
              children are rows, and the way to make one is the database's own
              button, which opens the page it created. */}
          {fullPageDatabase ? null : (
            <button
              className="notes-add-line"
              onClick={() => void ops.addBlock(visible[visible.length - 1]?.id ?? null).then((created) => focusBlock(created?.id, 0))}
            >
              <Icon name="plus" size={11} />
              {visible.length > 0 ? ' Add a line' : ' Write the first line'}
            </button>
          )}
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
