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
import { NotesMode, type CodeSymbolPick, type NotesOps, type NotesShellState } from './NotesMode.js';
import type { NoteBlockView, NoteSendTarget, NoteTreeRepairView } from '../lib/notes/notesView.js';
import { bridgeQuery } from '../lib/bridgeQuery.js';
import { codeFileUri, codeSymbolUri, noteBlockUri } from '../lib/workspace/crossMode.js';
import { selectedPageOrTop, withAncestorsExpanded } from '../lib/notes/pageTree.js';
import { isQuickFindShortcut, type QuickFindHit } from '../lib/notes/quickFind.js';
import { newPageIntent } from '../lib/notes/pageHeader.js';
import type { FavouriteRow, TrashEntryDto } from '../lib/notes/sidebar.js';

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
    const [favs, bin] = await Promise.all([
      bridgeQuery<{ blocks?: FavouriteRow[] }>('notes-favourites', {}).catch(() => null),
      bridgeQuery<{ entries?: TrashEntryDto[] }>('notes-trash', {}).catch(() => null),
    ]);
    if (favs) setFavourites(favs.blocks ?? []);
    if (bin) setTrash(bin.entries ?? []);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await bridgeQuery<NotesSnapshot>('notes-read', {});
      if (next) setSnapshot(next);
    } catch {
      // A failed read leaves the last good snapshot on screen. Blanking what
      // someone is reading because one refresh failed loses more than it says.
    }
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

  const ops: NotesOps = {
    // A new line belongs to the page being read, or it lands at the top level
    // and the person watches it appear on a page they are not looking at.
    addBlock: (afterId, kind) => void mutate('notes-create', {
      ...(afterId ? { after: afterId } : openPageId ? { parentId: openPageId } : {}),
      ...(kind ? { kind } : {}),
    }),
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
    setKind: (id, kind) => void mutate('notes-update', { id, kind }),
    toggleChecked: (id, checked) => void mutate('notes-update', { id, checked }),
    deleteBlock: (id) => void mutate('notes-delete', { id }),
    indent: (id) => {
      // Nest under the previous sibling — the only target an indent can mean.
      const flat = snapshot.blocks;
      const index = flat.findIndex((b) => b.id === id);
      const previous = [...flat.slice(0, index)].reverse().find((b) => b.depth === flat[index]?.depth);
      if (previous) void mutate('notes-move', { id, parentId: previous.id });
    },
    outdent: (id) => {
      const block = snapshot.blocks.find((b) => b.id === id);
      const parent = snapshot.blocks.find((b) => b.id === block?.parentId);
      void mutate('notes-move', { id, parentId: parent?.parentId ?? null });
    },
    beginEdit: (id) => {
      void bridgeQuery<{ ok?: boolean; lease?: { epoch: number } }>('notes-begin-edit', { id })
        .then((out) => { if (out?.ok && out.lease) held.current.set(id, out.lease.epoch); })
        // A refused lease is not an error to show here: the block already
        // renders read-only with the holder's name from `notes-read`.
        .catch(() => {});
    },
    endEdit: (id) => {
      const epoch = held.current.get(id);
      held.current.delete(id);
      if (epoch !== undefined) void bridgeQuery('notes-end-edit', { id, epoch }).catch(() => {});
    },
    resolveConflict: (id, field, keep) => void mutate('notes-resolve', { id, field, keep }),

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
    />
  );
}
