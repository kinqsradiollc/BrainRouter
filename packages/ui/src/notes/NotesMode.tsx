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
 * keystroke or a drag MEANS comes from the sibling pure helpers, and everything it DOES is
 * a call into core through the host: a page here has no opinion about where a
 * split's tail goes.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon.js';
import { NotesSidebar } from './NotesSidebar.js';
import { PageHeader } from './PageHeaderView.js';
import { QuickFind } from './QuickFindDialog.js';
import { BlockRow } from './BlockRow.js';
import { DatabaseBlock } from './DatabaseBlock.js';
import type { DatabaseHostOps } from './databaseOps.js';
import {
  conflictBanner, emptyMessage, indentFor, rendersOwnSurface, repairNote,
  type NoteBlockView, type NoteConflictExpectedView, type NoteSendTarget, type NoteTreeRepairView,
} from './notesView.js';
import { bodyRows } from './blockVisibility.js';
import { caretForColumn } from './blockEditing.js';
import {
  undoHighlightId, undoMenuLabel, undoNotice as undoNoticeLine,
} from './pageUndo.js';
import { CommentThread } from './CommentThreadView.js';
import { TemplatePicker } from './TemplatePicker.js';
import {
  orphanedSectionTitle, orphanedThreadNote, type OrphanedThreadDto,
} from './commentThread.js';
import type { TemplateRowDto } from './templates.js';
import {
  blockDropIntent, extendSelection, selectedBlockIds,
  type BlockAction, type BlockSelection, type PageDropPosition,
} from './blockSelection.js';
import { pageBodyBlocks, type PageMoveIntent } from './pageTree.js';
import { pageHeaderView } from './pageHeader.js';
import type { BlockIntent } from './blockKeymap.js';
import type { SlashCommandDto, SlashPlan } from './slashMenu.js';
import type { MentionCandidate } from './mentionPicker.js';
import type { InputRuleTransformDto } from './blockEditing.js';
import type { FavouriteRow, TrashEntryDto } from './sidebar.js';
import type { QuickFindHit, QuickFindRow } from './quickFind.js';
import type { NotesHostCapabilities } from './capabilities.js';

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
  /** Effects this host genuinely supports. Omitted groups remove their UI. */
  capabilities: NotesHostCapabilities;
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
  /**
   * `todo`'s tick — and, for a `table`, whether the first row is the heading
   * row. One stamped boolean per block, so the table gained a header toggle
   * without a new field, a new merge rule or a migration (see `tableView.ts`).
   */
  toggleChecked: (id: string, checked: boolean) => void;
  deleteBlock: (id: string) => void;

  /* F3 — the blocks the slash menu offered and could not draw. */
  /** A toggle folds its children. The block's own stamped field, so it merges. */
  setCollapsed: (id: string, collapsed: boolean) => void;
  /** A row INSIDE a table — its parent is the table, not the page. */
  addTableRow: (tableId: string, text: string, after?: string) => void;
  /**
   * Seed a table with a heading row and one row to type in.
   *
   * Both ways into a table go through this: `/table`, and the button an empty
   * table offers. A second seeding path would let the two produce tables of
   * different widths, which is the drift F1 is about.
   */
  startTable: (tableId: string) => void;
  /** A column edit, as the one-write-per-row it actually is (B1). */
  writeRows: (writes: readonly { id: string; text: string }[]) => void;
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
  /** B2 — true only after the host has granted this block's edit lease. */
  beginEdit: (id: string) => Promise<boolean>;
  endEdit: (id: string) => void;
  /** Resolve only the exact kept-both pair the person was shown. */
  resolveConflict: (
    id: string,
    field: string,
    keep: 'ours' | 'theirs',
    expected: NoteConflictExpectedView,
  ) => void;
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

  /* F3 — comments. Content, so they sync and merge; C5, so deleting the block
     never deletes them. */
  addComment: (blockId: string, body: string) => void;
  /**
   * A correction, rather than a delete and a repost.
   *
   * Reposting would move the remark to the end of the thread and strand the
   * reply underneath it; an edit merges as prose, so two devices correcting the
   * same comment keep both versions rather than one silently winning.
   */
  editComment: (blockId: string, commentId: string, body: string) => void;
  setCommentResolved: (blockId: string, commentId: string, resolved: boolean) => void;
  removeComment: (blockId: string, commentId: string) => void;
  /** C5 — the threads whose block is in the trash, so they are still findable. */
  orphanedThreads: OrphanedThreadDto[];

  /* F3 — templates. A template is a PAGE (B4), so this is a mark and a copy. */
  setTemplate: (pageId: string, template: boolean) => void;
  listTemplates: () => Promise<TemplateRowDto[]>;
  /** Returns core's sentence about what was copied and which links moved. */
  instantiateTemplate: (templateId: string, parentId: string | null) => Promise<string | null>;

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
  const [focus, setFocus] = useState<
    { blockId: string; caret: number; token: number; x?: number; edge?: 'first' | 'last'; adopt?: boolean } | null
  >(null);
  const focusToken = useRef(0);
  /** F3 — which block's comment thread is open, or null. */
  const [commentsFor, setCommentsFor] = useState<string | null>(null);
  /** F4 — the sentence a refused ⌘Z leaves behind, and the block it is about. */
  const [undoNotice, setUndoNotice] = useState<{ line: string; blockId: string | null } | null>(null);
  // F3 — what an export just did, and what the file left behind. Separate from
  // the undo notice because the two can be true at once and neither should
  // replace the other.
  const [pageNotice, setPageNotice] = useState<string | null>(null);
  /** F4 — what the visible Undo/Redo controls would take back, named. */
  const [undoSteps, setUndoSteps] = useState<{ undo: string | null; redo: string | null }>(
    { undo: null, redo: null },
  );
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ id: string | null; position: PageDropPosition } | null>(null);
  const [commands, setCommands] = useState<SlashCommandDto[]>([]);
  const history = ops.capabilities.history;

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
  // F3 — the fold, the table and the search decided together in
  // `blockVisibility.ts` rather than layered here, because their interactions
  // are the whole difficulty: a fold must not hide a hit, and a hit inside a
  // table has to surface as the table. Nothing here shortens what the store
  // holds — a folded block is still in `blocks`, still searchable, still
  // resolvable.
  const visible = useMemo(() => bodyRows(body, matchIds), [body, matchIds]);
  const banner = conflictBanner(blocks);
  const selectedIds = useMemo(() => selectedBlockIds(visible, selection), [visible, selection]);

  // The handle's "turn into" list is core's catalog, loaded once. A component
  // that built its own would offer a different set from the slash menu one line
  // above it.
  useEffect(() => {
    void ops.searchSlash('').then(setCommands).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const focusBlock = useCallback((
    id: string | null | undefined,
    caret: number,
    extra?: { x?: number; edge?: 'first' | 'last'; adopt?: boolean },
  ) => {
    if (!id) return;
    focusToken.current += 1;
    setFocus({
      blockId: id,
      caret: Math.max(0, caret),
      token: focusToken.current,
      ...(extra?.x === undefined ? {} : { x: extra.x }),
      ...(extra?.edge === undefined ? {} : { edge: extra.edge }),
      ...(extra?.adopt ? { adopt: true } : {}),
    });
  }, []);

  /**
   * F4 — ⌘Z that reached the end of a block's own typing.
   *
   * The answer decides where the caret goes AND that the block must adopt the
   * store's text: a focused block keeps its draft, so an undo that rewrote it
   * would be pushed straight back on the next keystroke.
   */
  const pageHistory = useCallback((direction: 'undo' | 'redo') => {
    if (!history) return;
    void (async () => {
      const answer = direction === 'undo' ? await history.undo() : await history.redo();
      const line = undoNoticeLine(answer);
      setUndoNotice(line ? { line, blockId: undoHighlightId(answer) } : null);
      if (answer?.ok && answer.focusId) focusBlock(answer.focusId, 0, { adopt: true });
      setUndoSteps(await history.state() ?? { undo: null, redo: null });
    })();
  }, [focusBlock, history]);

  // Re-read after every write, because `revision` is what the container bumps
  // when the store answered — including a change another device pushed, which
  // can make a step that WAS undoable no longer safe (F4's guard).
  useEffect(() => {
    if (!history) {
      setUndoSteps({ undo: null, redo: null });
      return;
    }
    let cancelled = false;
    void history.state().then((steps) => {
      if (!cancelled) setUndoSteps(steps ?? { undo: null, redo: null });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, revision, shell.pageId]);

  /** The next block a caret can actually enter — a sub-page row has no editor. */
  const nextEditable = useCallback((fromId: string, direction: -1 | 1): NoteBlockView | null => {
    const index = visible.findIndex((block) => block.id === fromId);
    if (index < 0) return null;
    for (let at = index + direction; at >= 0 && at < visible.length; at += direction) {
      const candidate = visible[at]!;
      // A sub-page row, a divider, a database — and, since Part F, an image, a
      // bookmark, an embed and a table — have no text field, so a caret arriving
      // at one would land nowhere and the arrow would look broken.
      if (candidate.kind !== 'page' && candidate.kind !== 'divider'
        && candidate.kind !== 'database' && !rendersOwnSurface(candidate.kind)) {
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
        // F3 — the caret enters at the X it left at, on the neighbour's first or
        // last VISUAL row. The character column travels as the fallback for a
        // surface with no layout to hit-test: on a wrapped paragraph a column
        // names two different places depending on which row you land in.
        focusBlock(
          neighbour.id,
          caretForColumn(neighbour.text, intent.column, direction < 0 ? 'last' : 'first'),
          { ...(intent.x === undefined ? {} : { x: intent.x }), edge: direction < 0 ? 'last' : 'first' },
        );
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

    // F3 — `/table` arrives as a GRID rather than as an empty container. A table
    // whose first gesture is "add the first row" is technically honest and
    // practically the same disappointment the block used to be: the person
    // picked a table and got a button.
    if (plan.action !== 'create-page' && plan.kind === 'table') {
      ops.setKind(block.id, 'table');
      ops.startTable(block.id);
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
    if (action === 'copy-link') { ops.capabilities.clipboard?.copyBlockLink(block.id); return; }
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
            {/* F4 — undo, offered as well as bound to ⌘Z, and NAMED. Part E's
                undo was invisible and text-only, so people found out it did
                nothing by trying it on the thing they most wanted back. */}
            {history ? (
              <>
                <button
                  className="notes-icon-btn"
                  disabled={undoSteps.undo === null}
                  title={undoMenuLabel(undoSteps.undo, 'undo')}
                  aria-label={undoMenuLabel(undoSteps.undo, 'undo')}
                  onClick={() => pageHistory('undo')}
                >
                  <Icon name="arrow-left" size={12} />
                </button>
                <button
                  className="notes-icon-btn"
                  disabled={undoSteps.redo === null}
                  title={undoMenuLabel(undoSteps.redo, 'redo')}
                  aria-label={undoMenuLabel(undoSteps.redo, 'redo')}
                  onClick={() => pageHistory('redo')}
                >
                  <Icon name="arrow-right" size={12} />
                </button>
              </>
            ) : null}
            {/* F3 — a page saved as a template, and a page started from one.
                Both live here rather than in the block handle: a template is a
                PAGE (B4), so the gesture belongs to the page, not to a line. */}
            <TemplatePicker
              page={page}
              pageId={shell.pageId}
              ops={ops}
              onOpenPage={ops.openPage}
            />
          </div>
          {/* Sync runs on its own (B3/D2). The line reports state as a fact;
              offline is the normal mode that happens to be syncing. */}
          <span className="notes-sync">{syncState}</span>
        </header>

        {banner ? <div className="notes-conflict-banner">{banner}</div> : null}

        {/* F3 — what the export saved AND what it could not carry. The omission
            list is in the file too; showing it here is what stops somebody
            checking their backup a month later and finding out then. */}
        {pageNotice ? (
          <div className="notes-undo-notice" role="status">
            <span>{pageNotice}</span>
            <button onClick={() => setPageNotice(null)}>Dismiss</button>
          </div>
        ) : null}

        {/* F4 — a REFUSED ⌘Z always says so. A guard that silently declines is
            indistinguishable from the "⌘Z did nothing" this whole part exists to
            remove, and the refusal is the one case where undo has to explain
            itself: somebody else's edit is underneath. */}
        {undoNotice ? (
          <div className="notes-undo-notice" role="status">
            <span>{undoNotice.line}</span>
            {undoNotice.blockId ? (
              <button onClick={() => { focusBlock(undoNotice.blockId, 0, { adopt: true }); setUndoNotice(null); }}>
                Show me
              </button>
            ) : null}
            <button onClick={() => setUndoNotice(null)}>Dismiss</button>
          </div>
        ) : null}

        {/* C5 — comments whose block was deleted. They are kept, so the failure
            to guard against is that they are kept where nobody looks. */}
        {ops.orphanedThreads.length > 0 ? (
          <OrphanedComments threads={ops.orphanedThreads} ops={ops} onRestore={ops.restore} />
        ) : null}

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
          <PageHeader
            view={header}
            block={page}
            ops={{
              openPage: ops.openPage,
              setPageTitle: ops.setPageTitle,
              setIcon: ops.setIcon,
              setCover: ops.setCover,
              setFavourite: ops.setFavourite,
              addPage: ops.addPage,
              ...(ops.capabilities.export ? {
                // The host returns the honest summary of what the file omitted.
                exportPage: (blockId, format) => {
                  void ops.capabilities.export!.exportPage(blockId, format).then((line) => setPageNotice(line));
                },
              } : {}),
            }}
          />

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
              focusRequest={focus && focus.blockId === block.id
                ? {
                  caret: focus.caret,
                  token: focus.token,
                  ...(focus.x === undefined ? {} : { x: focus.x }),
                  ...(focus.edge === undefined ? {} : { edge: focus.edge }),
                  ...(focus.adopt ? { adopt: true } : {}),
                }
                : null}
              commentsOpen={commentsFor === block.id}
              onComments={() => setCommentsFor(commentsFor === block.id ? null : block.id)}
              onPageHistory={pageHistory}
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
 * ADR-029 C5 — the comments on blocks that are no longer there.
 *
 * Deleting the target of a link never deletes the link, so these exist whatever
 * the surface does. What the surface decides is whether they are FINDABLE: a
 * thread kept in the data and shown nowhere is the same outcome as having
 * discarded it, which is the thing C5 refuses.
 *
 * It offers the restore beside them, because "why was this deleted" is usually
 * answered by putting the block back and reading it.
 */
function OrphanedComments({ threads, ops, onRestore }: {
  threads: readonly OrphanedThreadDto[];
  ops: NotesOps;
  onRestore: (id: string) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div className="notes-orphan-comments">
      <button className="notes-orphan-head" onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chev-down' : 'chev-right'} size={11} />
        {orphanedSectionTitle(threads)}
      </button>
      {open ? threads.map((thread) => (
        <div key={thread.blockId} className="notes-orphan-thread">
          <p className="notes-orphan-note">{orphanedThreadNote(thread)}</p>
          <CommentThread
            blockId={thread.blockId}
            comments={thread.comments}
            ops={ops}
            readOnly
          />
          <button className="notes-orphan-restore" onClick={() => onRestore(thread.blockId)}>
            Restore the block
          </button>
        </div>
      )) : null}
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
