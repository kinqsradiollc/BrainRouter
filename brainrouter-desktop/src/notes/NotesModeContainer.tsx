/**
 * ADR-029 Part B — the Notes mode's data container.
 *
 * Keeps host access out of `NotesMode`, which stays markup over the view model.
 * The container owns the two things that genuinely belong here: the store is a
 * user-scoped file the renderer cannot touch, so everything goes through the
 * host; and B2's lease is held across a focus, so the epoch this device
 * believes it holds has to live somewhere between two events.
 *
 * Local-first (B3): every mutation applies and returns. Sync is a background
 * concern that never blocks a keystroke — a notes app that stalls mid-sentence
 * is one people stop writing in.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
// The shared stylesheet rides with this lazy chunk rather than the app entry.
import '@kinqs/brainrouter-ui/notes.css';
import {
  NotesMode,
  blockLinkUri,
  exportNotice,
  isQuickFindShortcut,
  mentionCandidates,
  newPageIntent,
  noteBlockUri,
  selectedPageOrTop,
  withAncestorsExpanded,
  type BlockOpOutcome,
  type BookmarkAnswer,
  type CodeSymbolPick,
  type DatabaseHostOps,
  type DatabaseReadDto,
  type FavouriteRow,
  type InputRuleTransformDto,
  type MentionCandidate,
  type MentionSources,
  type NoteBlockView,
  type NoteExportDto,
  type NoteFileDto,
  type NoteImageDto,
  type NoteSendTarget,
  type NotesHostCapabilities,
  type NotesOps,
  type NotesShellState,
  type NoteTreeRepairView,
  type OrphanedThreadDto,
  type PageUndoDto,
  type PropertyCatalogDto,
  type QuickFindHit,
  type RollupTargetsDto,
  type SaveViewInput,
  type SlashCommandDto,
  type SyncedReadDto,
  type TemplateRowDto,
  type TrashEntryDto,
  type WorkspaceResolutionDto,
} from '@kinqs/brainrouter-ui/notes';
import { bridgeQuery } from '../lib/bridgeQuery.js';
import { codeFileUri, codeSymbolUri } from '../lib/workspace/crossMode.js';
import { createMeetingsOps } from '../components/meetings/meetingsOps.js';
// Part F — the table seed comes from core, so `/table` and an empty table's own
// button produce a table of the same width.
import { defaultTableHeader, emptyTableRow, NEW_TABLE_COLUMNS } from '@kinqs/brainrouter-core/notes/editing';
// F3 — the shell's own download, which already asks the person where their
// files go. A second save path in Notes would be a second answer to that.
import { download } from '../lib/format.js';

interface NotesSnapshot {
  blocks: NoteBlockView[];
  repairs: NoteTreeRepairView[];
  syncState: string;
  pending: number;
  conflictCount: number;
}

/** The same cadence the planner syncs at, and for the same reasons. */
const SYNC_INTERVAL_MS = 30_000;

/**
 * How long the `@` picker's candidates are reused before being read again.
 *
 * The planner, the board and the meetings list are three round trips, and the
 * picker filters as someone types. Reading them per keystroke would put three
 * requests behind every character; reading them once per opening would offer a
 * task created a minute ago as though it did not exist.
 */
const MENTION_SOURCE_TTL_MS = 15_000;

/**
 * Renew at a third of the 30s term, so one missed renewal does not drop the
 * lock out from under someone who is still typing.
 */
const LEASE_RENEW_MS = 10_000;

const EMPTY: NotesSnapshot = {
  blocks: [], repairs: [], syncState: 'Everything is synced.', pending: 0, conflictCount: 0,
};

export function NotesModeContainer({
  onOpenRef,
}: {
  /** Following a reference leaves this mode, which only the shell can do. */
  onOpenRef?: (uri: string) => void;
}): React.ReactElement {
  const [snapshot, setSnapshot] = useState<NotesSnapshot>(EMPTY);
  /**
   * Bumped on every read.
   *
   * A database renders a PROJECTION rather than the blocks — core computes which
   * rows a view shows — so it cannot be re-derived from the snapshot the way a
   * paragraph can. This counter is what tells an open database that something
   * changed and its projection is worth asking for again, including a change
   * another device made that arrived on a sync tick.
   */
  const [revision, setRevision] = useState(0);
  const [refLabels, setRefLabels] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<string[]>([]);
  /** Declarations by path, filled in when a file is picked — never on load. */
  const [symbols, setSymbols] = useState<Record<string, CodeSymbolPick[]>>({});
  /** B5's hits, or null when nothing has been searched for — see `visibleBlocks`. */
  const [matchIds, setMatchIds] = useState<ReadonlySet<string> | null>(null);
  const [backlinkCounts, setBacklinkCounts] = useState<Record<string, number>>({});
  const searchTimer = useRef<number | undefined>(undefined);
  /** blockId -> the epoch this device believes it holds (B2's fencing token). */
  const held = useRef(new Map<string, number>());

  /* ------------------------------------------------------------- the shell */

  const [pageId, setPageId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [favourites, setFavourites] = useState<FavouriteRow[]>([]);
  const [trash, setTrash] = useState<TrashEntryDto[]>([]);
  /** C5 — comment threads whose block is in the trash. */
  const [orphanedThreads, setOrphanedThreads] = useState<OrphanedThreadDto[]>([]);
  const [quickFindOpen, setQuickFindOpen] = useState(false);
  const [quickFindQuery, setQuickFindQuery] = useState('');
  const [quickFindHits, setQuickFindHits] = useState<QuickFindHit[]>([]);
  const quickFindTimer = useRef<number | undefined>(undefined);

  /**
   * Favourites and the trash are core's projections, asked for rather than
   * derived from the flat list.
   *
   * The predicate is trivial either way, but the ORDER is not: core sorts
   * favourites by rank and the trash by when it was deleted, and a renderer
   * that filtered the rendered tree would show both in document order — the
   * trash newest-last, which is the wrong end for the thing people use it for.
   */
  const refreshSections = useCallback(async () => {
    const [favs, bin, orphans] = await Promise.all([
      bridgeQuery<{ blocks?: FavouriteRow[] }>('notes-favourites', {}).catch(() => null),
      bridgeQuery<{ entries?: TrashEntryDto[] }>('notes-trash', {}).catch(() => null),
      // C5 — comments whose block was deleted. Read beside the trash because
      // that is where a person looks for something that was on a page that is
      // gone, and because a thread nobody can find is the same as a thread that
      // was discarded.
      bridgeQuery<{ threads?: OrphanedThreadDto[] }>('notes-comments-orphaned', {}).catch(() => null),
    ]);
    if (favs) setFavourites(favs.blocks ?? []);
    if (bin) setTrash(bin.entries ?? []);
    if (orphans) setOrphanedThreads(orphans.threads ?? []);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await bridgeQuery<NotesSnapshot>('notes-read', {});
      if (next) setSnapshot(next);
    } catch {
      // A failed read leaves the last good snapshot on screen. Blanking what
      // someone is reading because one refresh failed loses more than it says.
    }
    setRevision((current) => current + 1);
    await refreshSections();
  }, [refreshSections]);

  useEffect(() => { void refresh(); }, [refresh]);

  /**
   * The open page, checked against what actually arrived.
   *
   * A selected page can vanish — deleted here, or a tombstone arriving from
   * another device — and a shell that kept the id would render a header for
   * something that is not there. Falling back to the top level shows a surface
   * that is still true.
   */
  const openPageId = useMemo(
    () => selectedPageOrTop(snapshot.blocks, pageId),
    [snapshot.blocks, pageId],
  );

  const openPage = useCallback((next: string | null) => {
    setPageId(next);
    // Opening a page from anywhere — a breadcrumb, a favourite, ⌘K — reveals it
    // in the tree. Otherwise the sidebar shows a collapsed branch beside a page
    // it does not appear to contain.
    setExpanded((current) => withAncestorsExpanded(snapshot.blocks, next, current));
  }, [snapshot.blocks]);

  /** E4 — ⌘K from anywhere in the mode, including while a block has focus. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!isQuickFindShortcut(e)) return;
      e.preventDefault();
      setQuickFindOpen((open) => !open);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    void bridgeQuery<{ files?: string[] }>('list-files', { limit: 3000 })
      .then((r) => setFiles(Array.isArray(r?.files) ? r.files : []))
      .catch(() => {});
  }, []);

  /**
   * A3 — labels are RESOLVED, never stored on the link.
   *
   * Re-read whenever the set of references changes, so completing a task
   * updates every note that cites it and deleting one turns its chip into a
   * dated tombstone rather than leaving a sentence that is quietly wrong.
   */
  const refKey = snapshot.blocks.flatMap((b) => b.refs).sort().join('|');
  useEffect(() => {
    const uris = [...new Set(snapshot.blocks.flatMap((b) => b.refs))];
    if (uris.length === 0) { setRefLabels({}); return; }
    let cancelled = false;
    void Promise.all(uris.map(async (uri) => {
      const res = await bridgeQuery<{ line?: string }>('workspace-describe', { uri }).catch(() => null);
      return [uri, res?.line ?? ''] as const;
    })).then((pairs) => {
      if (cancelled) return;
      setRefLabels(Object.fromEntries(pairs.filter(([, line]) => line)));
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refKey]);

  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      if (cancelled || document.hidden) return;
      try {
        await bridgeQuery('notes-sync', {});
        if (!cancelled) await refresh();
      } catch {
        // Offline is the normal mode that happens to be syncing. The state line
        // already says how many changes are waiting.
      }
    };
    const timer = window.setInterval(() => void tick(), SYNC_INTERVAL_MS);
    const onFocus = (): void => void tick();
    window.addEventListener('focus', onFocus);
    void tick();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  /**
   * Renew every held lease while this mode is open.
   *
   * A lease that is taken on focus and never renewed expires after 30 seconds
   * of typing, at which point the fence demotes the writer to a merge and D4's
   * conflict markers start appearing in the middle of a paragraph someone is
   * still writing — the exact outcome B2 chose locking to prevent.
   */
  useEffect(() => {
    const timer = window.setInterval(() => {
      for (const [id, epoch] of held.current) {
        void bridgeQuery<{ ok?: boolean; lease?: { epoch: number } }>('notes-keep-edit', { id, epoch })
          .then((out) => { if (out?.ok && out.lease) held.current.set(id, out.lease.epoch); })
          .catch(() => {});
      }
    }, LEASE_RENEW_MS);
    return () => window.clearInterval(timer);
  }, []);

  /**
   * Apply a mutation, then re-read.
   *
   * Re-reading rather than patching local state: the store merges (D4), so the
   * result of an edit is not always the edit — a concurrent change can make it
   * conflicted, and a surface that assumed its own write won would hide that.
   */
  const mutate = useCallback(async (action: string, args: Record<string, unknown>) => {
    try {
      await bridgeQuery(action, args);
    } finally {
      await refresh();
      void bridgeQuery('notes-sync', {}).catch(() => {});
    }
  }, [refresh]);

  /**
   * A gesture core owns, performed and then re-read.
   *
   * The OUTCOME is returned rather than swallowed, because core decides where
   * the caret belongs after a split, a merge or a duplicate — and a surface
   * that guessed would put it somewhere else than the dashboard does for the
   * same keystroke, which is E1's parity test failing on the one thing it is
   * actually about.
   */
  const gesture = useCallback(async (
    action: string, args: Record<string, unknown>,
  ): Promise<BlockOpOutcome | null> => {
    let outcome: BlockOpOutcome | null = null;
    try {
      outcome = await bridgeQuery<BlockOpOutcome>(action, args);
    } catch {
      // A refused gesture leaves the document as it was; the refresh below
      // still runs so the surface reflects whatever the store actually holds.
    }
    await refresh();
    void bridgeQuery('notes-sync', {}).catch(() => {});
    return outcome;
  }, [refresh]);

  /** The `@` picker's candidates, read at most this often. */
  const mentionSources = useRef<{ at: number; sources: MentionSources }>({ at: 0, sources: {} });

  const loadMentionSources = useCallback(async (): Promise<MentionSources> => {
    const now = Date.now();
    if (now - mentionSources.current.at < MENTION_SOURCE_TTL_MS) return mentionSources.current.sources;

    // E5 — every mode this process can enumerate, so a mention can address a
    // planner item, a work item or a meeting and not only another page.
    // Meetings live on the server, so they come through the bridge the meetings
    // mode already uses rather than through a second client.
    const [planner, work, meetings, databases] = await Promise.all([
      bridgeQuery<{ items?: Array<{ id: string; title: string; completed?: boolean }> }>('planner-read', {})
        .catch(() => null),
      bridgeQuery<Array<{ id: string; key?: string; title: string }>>('track-items', {}).catch(() => null),
      createMeetingsOps().list().catch(() => [] as Array<{ id: string; title: string }>),
      // E3 — a database is not in the page list, and its title is core's
      // decoded one rather than the block's text, so it is asked for rather
      // than filtered out of the snapshot.
      bridgeQuery<{ databases?: Array<{ id: string; title: string }> }>('notes-database-list', {})
        .catch(() => null),
    ]);

    const sources: MentionSources = {
      pages: snapshot.blocks
        .filter((block) => block.kind === 'page')
        .map((block) => ({ id: block.id, title: (block.title ?? '').trim() || block.text.trim() })),
      databases: (databases?.databases ?? []).map((database) => ({
        id: database.id, title: database.title,
      })),
      planner: (planner?.items ?? []).map((item) => ({
        id: item.id, title: item.title, completed: item.completed === true,
      })),
      workItems: Array.isArray(work) ? work.map((item) => ({ id: item.id, key: item.key, title: item.title })) : [],
      meetings: (meetings ?? []).map((meeting) => ({ id: meeting.id, title: meeting.title })),
    };
    mentionSources.current = { at: now, sources };
    return sources;
  }, [snapshot.blocks]);

  /**
   * The handful of callbacks that change on every snapshot, reached through a
   * ref.
   *
   * `database` below has to be REFERENTIALLY STABLE: an open database re-reads
   * its projection whenever the object identity changes, so rebuilding it each
   * render would put a round trip behind every keystroke on the page — and a
   * read that lands in state would rebuild it again.
   */
  const live = useRef({ openPage, loadMentionSources, onOpenRef });
  live.current = { openPage, loadMentionSources, onOpenRef };

  /**
   * ADR-029 E3 — the database verbs, every one a `notes-database-*` handler.
   *
   * There is no database store to talk to: each of these reads the same blocks
   * `notes-read` reads and writes through the same `updateBlock`, so a cell edit
   * is refused while another device holds the row's lease and travels the row's
   * own outbox in order. The filtering, sorting and grouping are core's, asked
   * for by `read` rather than computed here.
   */
  const database: DatabaseHostOps = useMemo(() => ({
    read: async (databaseId, viewId) => bridgeQuery<DatabaseReadDto>('notes-database-read', {
      id: databaseId, ...(viewId ? { viewId } : {}),
    }).catch(() => null),
    // E3 — this creates a PAGE. The id comes back so the caller can open it,
    // which is what makes a row a page rather than a record beside one.
    addRow: async (databaseId, after) => {
      const created = await bridgeQuery<{ ok?: boolean; id?: string }>('notes-database-add-row', {
        id: databaseId, ...(after ? { after } : {}),
      }).catch(() => null);
      await refresh();
      void bridgeQuery('notes-sync', {}).catch(() => {});
      return created?.id ?? null;
    },
    setValue: (rowId, propertyId, value) => mutate('notes-database-set-value', { rowId, propertyId, value }),
    removeRow: (rowId) => mutate('notes-database-remove-row', { rowId }),
    addProperty: (databaseId, name, type, config) => mutate('notes-database-add-property', {
      id: databaseId, name, type,
      // F2 — a formula column arrives with its expression and a rollup with its
      // configuration, so it is never briefly a column that says it does not
      // work yet.
      ...(config?.formula === undefined ? {} : { formula: config.formula }),
      ...(config?.rollup === undefined ? {} : { rollup: config.rollup }),
    }),
    updateProperty: (databaseId, propertyId, patch) => mutate('notes-database-update-property', {
      id: databaseId, propertyId, ...patch,
    }),
    removeProperty: (databaseId, propertyId) => mutate('notes-database-remove-property', {
      id: databaseId, propertyId,
    }),
    reorderProperties: (databaseId, order) => mutate('notes-database-reorder-properties', {
      id: databaseId, order: [...order],
    }),
    // Constant for the life of the process — the types this build can evaluate
    // do not change while it runs — so it is read when a picker first needs it
    // and not on every open.
    propertyCatalog: () => bridgeQuery<PropertyCatalogDto>('notes-property-catalog', {}).catch(() => null),
    saveView: (databaseId, input: SaveViewInput) => mutate('notes-database-save-view', {
      id: databaseId,
      ...(input.viewId === undefined ? {} : { viewId: input.viewId }),
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      ...(input.visible === undefined ? {} : { visible: input.visible }),
      // `null` clears and `undefined` leaves alone — core's `saveView` reads
      // them that way, and collapsing the two here would make it impossible to
      // remove a filter or stop grouping.
      ...(input.filter === undefined ? {} : { filter: input.filter }),
      ...(input.sort === undefined ? {} : { sort: input.sort }),
      ...(input.groupBy === undefined ? {} : { groupBy: input.groupBy }),
    }),
    removeView: (databaseId, viewId) => mutate('notes-database-remove-view', { id: databaseId, viewId }),
    // F2 — the columns on the other end of a relation, so a rollup's target
    // picker offers what exists rather than a guess every row reports as
    // unreadable.
    rollupTargets: async (databaseId, relation) => await bridgeQuery<RollupTargetsDto>('notes-rollup-targets', {
      id: databaseId, relation,
    }).catch(() => ({ ok: false })),
    /**
     * F3/D3 — a file into the ONE attachment store the image block uses.
     *
     * The cell then holds `attachment:<id>`, which is the same spelling a
     * picture in a block holds, resolved by the same function. A files column
     * with its own store would be the second store D3 exists to refuse.
     */
    files: {
      attach: async (name, dataBase64) => {
        const stored = await bridgeQuery<{ ok?: boolean; ref?: string; error?: string }>(
          'notes-file-attach', { name, dataBase64 },
        ).catch(() => null);
        if (!stored?.ok || !stored.ref) {
          return { ok: false, error: stored?.error ?? 'That file could not be stored.' };
        }
        return { ok: true, ref: stored.ref };
      },
      describe: async (ids) => {
        const answer = await bridgeQuery<{ files?: NoteFileDto[] }>('notes-file-describe', {
          ids: [...ids],
        }).catch(() => null);
        return answer?.files ?? [];
      },
    },
    openPage: (pageId) => live.current.openPage(pageId),
    openRef: (uri) => live.current.onOpenRef?.(uri),
    // E5 — the same candidates the `@` picker offers, so a relation can address
    // a planner item, a work item or a meeting and not only another page.
    searchRefs: async (query) => mentionCandidates(await live.current.loadMentionSources(), query),
  }), [mutate, refresh]);

  /**
   * D3 — a picture stored once, and the block pointed at it.
   *
   * Both intake gestures (a picked file, a pasted address) come through here, so
   * the reference is written in one place and cannot be spelled two ways. The
   * ERROR is returned rather than thrown because the block is rendering the
   * outcome: a rejected promise would make "why is there no picture" the
   * component's problem to remember, which is how a blank frame gets shipped.
   */
  const storeImage = useCallback(async (
    blockId: string,
    action: string,
    args: Record<string, unknown>,
    fallback: string,
  ): Promise<string | null> => {
    type StoreImageAnswer = { ok?: boolean; ref?: string; error?: string };
    const stored: StoreImageAnswer | null = await bridgeQuery<StoreImageAnswer>(action, args)
      .catch((err: unknown): StoreImageAnswer => ({
        error: err instanceof Error ? err.message : fallback,
      }));
    const ref = typeof stored?.ref === 'string' ? stored.ref : '';
    if (!ref) return (typeof stored?.error === 'string' && stored.error) || fallback;
    await mutate('notes-update', { id: blockId, text: ref });
    return null;
  }, [mutate]);

  /** Native and shell effects the Desktop host can genuinely perform. */
  const capabilities = useMemo<NotesHostCapabilities>(() => ({
    images: {
      attach: (blockId, file) => storeImage(
        blockId, 'notes-image-attach', { name: file.name, dataBase64: file.dataBase64 },
        'That picture could not be stored.',
      ),
      storeRemote: (blockId, url) => storeImage(
        blockId, 'notes-image-fetch', { url }, 'That address could not be fetched.',
      ),
      read: (attachmentId) => bridgeQuery<NoteImageDto>('notes-image-read', { id: attachmentId })
        .catch(() => null),
    },
    bookmarks: {
      preview: (url) => bridgeQuery<BookmarkAnswer>('notes-bookmark-preview', { url })
        .catch(() => null),
      openExternal: async (url) => {
        const opened = await bridgeQuery<{ ok?: boolean; error?: string }>('action:open-external', { url })
          .catch(() => null);
        if (opened?.ok) return null;
        return opened?.error
          ? `This link could not be opened: ${opened.error}.`
          : 'This link could not be opened from here.';
      },
    },
    liveReferences: {
      resolve: (uri) => bridgeQuery<WorkspaceResolutionDto>('workspace-resolve', { uri })
        .catch(() => null),
      readSynced: (blockId) => bridgeQuery<SyncedReadDto>('notes-synced-read', { id: blockId })
        .catch(() => null),
    },
    export: {
      exportPage: async (blockId, format) => {
        const written = await bridgeQuery<NoteExportDto>('notes-export', { id: blockId, format })
          .catch(() => null);
        if (!written?.ok || typeof written.content !== 'string') {
          return written?.error ?? 'That page could not be written out.';
        }
        download(written.filename ?? 'note.md', written.content);
        return exportNotice(written);
      },
    },
    clipboard: {
      copyBlockLink: (id) => {
        void navigator.clipboard?.writeText(blockLinkUri(id)).catch(() => {});
      },
    },
    history: {
      undo: () => bridgeQuery<PageUndoDto>('notes-undo', { pageId: openPageId })
        .then(async (answer) => { await refresh(); return answer; })
        .catch(() => null),
      redo: () => bridgeQuery<PageUndoDto>('notes-redo', { pageId: openPageId })
        .then(async (answer) => { await refresh(); return answer; })
        .catch(() => null),
      state: () => bridgeQuery<{ undo: string | null; redo: string | null }>(
        'notes-undo-state', { pageId: openPageId },
      ).catch(() => null),
    },
  }), [openPageId, refresh, storeImage]);

  const ops: NotesOps = {
    capabilities,
    // A new line belongs to the page being read, or it lands at the top level
    // and the person watches it appear on a page they are not looking at.
    addBlock: async (afterId, kind, level) => {
      const created = await bridgeQuery<{ id?: string }>('notes-create', {
        ...(afterId ? { after: afterId } : openPageId ? { parentId: openPageId } : {}),
        ...(kind ? { kind } : {}),
        ...(level === undefined ? {} : { level }),
      }).catch(() => null);
      await refresh();
      void bridgeQuery('notes-sync', {}).catch(() => {});
      return created?.id ? { id: created.id } : null;
    },
    /**
     * E4 — a page at any level, and inside any page.
     *
     * The new page is OPENED, because the gesture is "start writing here" and
     * a page created into a collapsed branch with the reader left where they
     * were looks like the button did nothing.
     */
    addPage: (parentId) => {
      void (async () => {
        const created = await bridgeQuery<{ id?: string }>('notes-create-page', newPageIntent(parentId))
          .catch(() => null);
        await refresh();
        if (created?.id) openPage(created.id);
      })();
    },
    openPage,
    toggleExpanded: (id) => setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    }),
    movePage: (intent) => void mutate('notes-move', { ...intent }),
    // B4 — a page IS a block, so the sidebar's drag and the page body's drag
    // are one write. Two names, because a call site that said `movePage` while
    // dragging a paragraph would read as a bug.
    moveBlock: (intent) => void mutate('notes-move', { ...intent }),
    // B4/E2 — the title IS the page block's text. One field, one write.
    setPageTitle: (id, title) => void mutate('notes-update', { id, text: title }),
    setIcon: (id, icon) => void mutate('notes-update', { id, icon }),
    setCover: (id, cover) => void mutate('notes-update', { id, cover }),
    setFavourite: (id, favourite) => void mutate('notes-update', { id, favourite }),
    restore: (id) => void mutate('notes-restore', { id }),
    openQuickFind: () => setQuickFindOpen(true),
    closeQuickFind: () => setQuickFindOpen(false),
    /**
     * ⌘K searches everything, through the SAME ranked search the in-page filter
     * uses — core's `searchNotes`, asked for by query. Debounced for the same
     * reason: a request per character arrives out of order often enough that
     * the list settles on the results for a prefix already typed past.
     */
    quickFindQuery: (query) => {
      setQuickFindQuery(query);
      window.clearTimeout(quickFindTimer.current);
      if (!query.trim()) { setQuickFindHits([]); return; }
      quickFindTimer.current = window.setTimeout(() => {
        void bridgeQuery<{ hits?: QuickFindHit[] }>('notes-search', { query })
          .then((res) => setQuickFindHits(res?.hits ?? []))
          .catch(() => {});
      }, 150);
    },
    setText: (id, text) => void mutate('notes-update', { id, text }),
    setKind: (id, kind, level) => void mutate('notes-update', {
      id, kind, ...(level === undefined ? {} : { level }),
    }),
    toggleChecked: (id, checked) => void mutate('notes-update', { id, checked }),
    deleteBlock: (id) => void mutate('notes-delete', { id }),

    /* ------------------------------------------------- ADR-029 Part F blocks */

    // A fold is the block's own stamped field, so it is an ordinary update and
    // it merges — the same write on every device rather than a set the shell
    // keeps and loses on reload.
    setCollapsed: (id, collapsed) => void mutate('notes-update', { id, collapsed }),

    addTableRow: (tableId, text, after) => void mutate('notes-create', {
      parentId: tableId, kind: 'table-row', text, ...(after ? { after } : {}),
    }),

    /**
     * The heading row and the first data row, seeded in one gesture.
     *
     * Guarded against a table that already has rows, because both callers can
     * reach it: `/table` seeds on creation, and an empty table's own button
     * seeds a table converted from a paragraph. Seeding twice would leave two
     * heading rows and no way to tell which one the toggle means.
     */
    startTable: (tableId) => {
      const already = snapshot.blocks.some((b) => b.parentId === tableId && b.kind === 'table-row');
      if (already) return;
      void (async () => {
        const header = await bridgeQuery<{ id?: string }>('notes-create', {
          parentId: tableId, kind: 'table-row', text: defaultTableHeader(NEW_TABLE_COLUMNS),
        }).catch(() => null);
        await bridgeQuery('notes-create', {
          parentId: tableId, kind: 'table-row', text: emptyTableRow(NEW_TABLE_COLUMNS),
          ...(header?.id ? { after: header.id } : {}),
        }).catch(() => {});
        // The header FLAG last, so a refresh between the two writes never shows
        // a table claiming a heading row it does not yet have.
        await bridgeQuery('notes-update', { id: tableId, checked: true }).catch(() => {});
        await refresh();
        void bridgeQuery('notes-sync', {}).catch(() => {});
      })();
    },

    /**
     * A column edit — one write per row, in order.
     *
     * Sequential rather than parallel: each write is a read-modify-write of the
     * user-scoped store file, and firing them together would let the last one
     * land on a copy read before the others were written.
     */
    writeRows: (writes) => {
      void (async () => {
        for (const write of writes) {
          // eslint-disable-next-line no-await-in-loop
          await bridgeQuery('notes-update', { id: write.id, text: write.text }).catch(() => {});
        }
        await refresh();
        void bridgeQuery('notes-sync', {}).catch(() => {});
      })();
    },

    /**
     * E1 — the gestures, every one of them core's.
     *
     * These used to be re-derived here: `indent` looked for the previous
     * sibling in the flat list and moved the block under it. That is the
     * judgement `indentBlock` already makes — and makes differently, because it
     * walks the REPAIRED tree and refuses inside a table row. Two answers to
     * "what does Tab do" is exactly the drift ADR-029 is organised against, so
     * the renderer asks and core decides.
     */
    splitBlock: (id, caret) => gesture('notes-split', { id, caret }),
    mergeBack: (id) => gesture('notes-merge-back', { id }),
    duplicate: (id) => gesture('notes-duplicate', { id }),
    moveUp: (id) => gesture('notes-move-up', { id }),
    moveDown: (id) => gesture('notes-move-down', { id }),
    indent: (id) => gesture('notes-indent', { id }),
    outdent: (id) => gesture('notes-outdent', { id }),

    /**
     * E1 — what `# ` means, answered by core's rule set.
     *
     * Asked per marker rather than per keystroke: the rules only fire on the
     * space (or the newline) that completes one, so that is the only moment
     * worth a round trip.
     */
    inputRule: async (request) => {
      const answer = await bridgeQuery<{ transform?: InputRuleTransformDto | null }>(
        'notes-input-rule', { ...request },
      ).catch(() => null);
      return answer?.transform ?? null;
    },
    // The rule changed the block's KIND as well as its text, and both halves go
    // in one write so a refresh can never show the marker consumed by a
    // paragraph that is still a paragraph.
    applyRule: (id, transform) => void mutate('notes-update', {
      id,
      text: transform.text,
      kind: transform.kind,
      ...(transform.level === undefined ? {} : { level: transform.level }),
      ...(transform.checked === undefined ? {} : { checked: transform.checked }),
      ...(transform.language === undefined ? {} : { language: transform.language }),
    }),
    searchSlash: async (query) => {
      const answer = await bridgeQuery<{ commands?: SlashCommandDto[] }>('notes-slash-menu', {
        query, limit: 12,
      }).catch(() => null);
      return answer?.commands ?? [];
    },
    searchMentions: async (query): Promise<MentionCandidate[]> => {
      const sources = await loadMentionSources();
      // Ranked by the shared Notes mention picker, not here: the same few characters
      // are typed at this menu and at the slash menu, and a second ranking
      // would make one of them behave differently for no reason a person could
      // see.
      return mentionCandidates(sources, query);
    },
    beginEdit: async (id) => {
      const out = await bridgeQuery<{
        ok?: boolean;
        lease?: { blockId?: string; epoch?: number };
      }>('notes-begin-edit', { id }).catch(() => null);
      if (!out?.ok || out.lease?.blockId !== id
        || !Number.isSafeInteger(out.lease.epoch) || Number(out.lease.epoch) < 1) return false;
      held.current.set(id, Number(out.lease.epoch));
      return true;
    },
    endEdit: (id) => {
      const epoch = held.current.get(id);
      held.current.delete(id);
      if (epoch !== undefined) void bridgeQuery('notes-end-edit', { id, epoch }).catch(() => {});
    },
    resolveConflict: (id, field, keep, expected) => void mutate('notes-resolve', {
      id, field, keep, expected,
    }),

    /**
     * ADR-029 C2 — the line becomes a record in another mode, and the note
     * cites it. Both halves, in that order: Q2 makes `create` synchronous
     * precisely so the caller can write the reference into its own content,
     * because an async create that failed after the note was saved would leave
     * a note claiming a task that does not exist.
     */
    sendTo: (id, target: NoteSendTarget) => {
      const block = snapshot.blocks.find((b) => b.id === id);
      if (!block) return;
      void (async () => {
        const created = await bridgeQuery<{ uri?: string; error?: string }>('workspace-create', {
          mode: target.mode, kind: target.kind, title: block.text.trim(),
          from: `brainrouter://notes/block/${block.id}`,
        }).catch(() => null);
        if (created?.uri) {
          await bridgeQuery('workspace-link', {
            from: `brainrouter://notes/block/${block.id}`, to: created.uri,
          }).catch(() => {});
        }
        await refresh();
      })();
    },
    /**
     * C2 row 6 — cite the file, or one declaration inside it.
     *
     * A symbol reference is the one that survives an EDIT rather than only a
     * move: `#L59` means a different line the moment someone adds an import,
     * while a function keeps its name while the file is rewritten around it.
     */
    linkFile: (id, relPath, symbol) => void mutate('workspace-link', {
      from: noteBlockUri(id),
      to: symbol ? codeSymbolUri(relPath, symbol) : codeFileUri(relPath),
    }),
    loadSymbols: (relPath) => {
      void bridgeQuery<{ symbols?: CodeSymbolPick[] }>('code-symbols', { path: relPath })
        .then((res) => setSymbols((current) => ({ ...current, [relPath]: res?.symbols ?? [] })))
        // An empty list is the honest answer when the file could not be read:
        // the picker still offers the whole file, which always resolves.
        .catch(() => setSymbols((current) => ({ ...current, [relPath]: [] })));
    },
    openRef: (uri) => onOpenRef?.(uri),

    /**
     * B5 — the ranked search runs in core, over the host's copy of the store.
     *
     * Debounced rather than per-keystroke: the search is a round trip, and a
     * request per character arrives out of order often enough that the list
     * settles on the results for a prefix the person has already finished
     * typing past.
     */
    search: (query) => {
      window.clearTimeout(searchTimer.current);
      if (!query.trim()) { setMatchIds(null); return; }
      searchTimer.current = window.setTimeout(() => {
        void bridgeQuery<{ hits?: Array<{ blockId: string }> }>('notes-search', { query })
          .then((res) => setMatchIds(new Set((res?.hits ?? []).map((h) => h.blockId))))
          .catch(() => {});
      }, 150);
    },

    /** A2 — asked for when a block's menu opens, not for every block on read. */
    loadBacklinks: (id) => {
      void bridgeQuery<{ blockIds?: string[] }>('notes-backlinks', { uri: `brainrouter://notes/block/${id}` })
        .then((res) => setBacklinkCounts((current) => ({ ...current, [id]: res?.blockIds?.length ?? 0 })))
        .catch(() => {});
    },

    /* F3 — comments. They sync, so they go through the store like everything
       else; they are NOT on the undo stack, for the reason `writeComment`
       states — ⌘Z must not silently retract a remark addressed to someone. */
    addComment: (blockId, body) => void mutate('notes-comment-add', { id: blockId, body }),
    editComment: (blockId, commentId, body) =>
      void mutate('notes-comment-edit', { id: blockId, commentId, body }),
    setCommentResolved: (blockId, commentId, resolved) =>
      void mutate('notes-comment-resolve', { id: blockId, commentId, resolved }),
    removeComment: (blockId, commentId) =>
      void mutate('notes-comment-remove', { id: blockId, commentId }),
    orphanedThreads,

    /* F3 — templates. A template is a page, so marking is one field write and
       instantiating is core's copy with its reference rewrite. */
    setTemplate: (pageId, template) => void mutate('notes-update', { id: pageId, template }),
    listTemplates: async () => {
      const answer = await bridgeQuery<{ templates?: TemplateRowDto[] }>('notes-templates', {})
        .catch(() => null);
      return answer?.templates ?? [];
    },
    instantiateTemplate: async (templateId, parentId) => {
      const made = await bridgeQuery<{ ok?: boolean; pageId?: string; line?: string }>(
        'notes-template-instantiate', { id: templateId, parentId },
      ).catch(() => null);
      await refresh();
      void bridgeQuery('notes-sync', {}).catch(() => {});
      if (made?.ok && made.pageId) openPage(made.pageId);
      return made?.line ?? null;
    },

    database,
    /**
     * E3 — `/database` and the page header's button.
     *
     * Through `notes-database-create` rather than `notes-create` with a kind, so
     * the block arrives with the schema and the table view core gives a new
     * database. It is NOT opened: a database made inside a page belongs in the
     * page's flow, and navigating away would lose the sentence it was made under.
     */
    addDatabase: (parentId, after) => void mutate('notes-database-create', {
      title: '',
      parentId,
      ...(after ? { after } : {}),
    }),
  };

  const shell: NotesShellState = {
    pageId: openPageId,
    expanded,
    favourites,
    trash,
    quickFindOpen,
    quickFindQuery,
    quickFindHits,
  };

  return (
    <NotesMode
      blocks={snapshot.blocks}
      repairs={snapshot.repairs}
      syncState={snapshot.syncState}
      refLabels={refLabels}
      files={files}
      symbols={symbols}
      matchIds={matchIds}
      backlinkCounts={backlinkCounts}
      shell={shell}
      ops={ops}
      revision={revision}
    />
  );
}
