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
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { NotesMode, type NotesOps } from './NotesMode.js';
import type { NoteBlockView, NoteSendTarget, NoteTreeRepairView } from '../lib/notes/notesView.js';
import { bridgeQuery } from '../lib/bridgeQuery.js';

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
  /** B5's hits, or null when nothing has been searched for — see `visibleBlocks`. */
  const [matchIds, setMatchIds] = useState<ReadonlySet<string> | null>(null);
  const [backlinkCounts, setBacklinkCounts] = useState<Record<string, number>>({});
  const searchTimer = useRef<number | undefined>(undefined);
  /** blockId -> the epoch this device believes it holds (B2's fencing token). */
  const held = useRef(new Map<string, number>());

  const refresh = useCallback(async () => {
    try {
      const next = await bridgeQuery<NotesSnapshot>('notes-read', {});
      if (next) setSnapshot(next);
    } catch {
      // A failed read leaves the last good snapshot on screen. Blanking what
      // someone is reading because one refresh failed loses more than it says.
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

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
    addBlock: (afterId, kind) => void mutate('notes-create', {
      ...(afterId ? { after: afterId } : {}), ...(kind ? { kind } : {}),
    }),
    addPage: () => void mutate('notes-create-page', { title: 'Untitled page' }),
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
    linkFile: (id, relPath) => void mutate('workspace-link', {
      from: `brainrouter://notes/block/${id}`,
      to: `brainrouter://code/file/${relPath}`,
    }),
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

  return (
    <NotesMode
      blocks={snapshot.blocks}
      repairs={snapshot.repairs}
      syncState={snapshot.syncState}
      refLabels={refLabels}
      files={files}
      matchIds={matchIds}
      backlinkCounts={backlinkCounts}
      ops={ops}
    />
  );
}
