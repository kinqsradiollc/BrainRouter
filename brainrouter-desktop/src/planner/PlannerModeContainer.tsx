/**
 * ADR-028 G6 — the planner mode's data container.
 *
 * Keeps the store access out of `PlannerMode`, which stays pure markup over the
 * view model. The container owns the one thing that genuinely needs to live
 * here: the fact that the planner reads and writes through the HOST rather than
 * directly, because the store is a user-scoped file the renderer cannot touch.
 *
 * Local-first (D2): every mutation applies optimistically and returns. Sync is
 * a background concern that never blocks a keystroke — a planner that stalls is
 * one people stop using mid-thought.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { PlannerMode, type PlannerOps } from './PlannerMode.js';
import type {
  PlannerBlockView,
  PlannerItemView,
  PlannerSyncView,
} from '@kinqs/brainrouter-ui/planner';
import { bridgeQuery } from '../lib/bridgeQuery.js';
import { splitTextByWorkspaceRefs } from '@kinqs/brainrouter-core/workspace/references';
import { createAndCite, plannerItemUri } from '../lib/workspace/crossMode.js';

interface PlannerSnapshot {
  today?: string;
  items: PlannerItemView[];
  blocks: PlannerBlockView[];
  sync: Omit<PlannerSyncView, 'onRetry' | 'onRetryIssue'>;
  staleSources: string[];
  driftNote: string | null;
}

/**
 * How often the planner reconciles with the server.
 *
 * Five seconds matches the active Dashboard adapter and ADR-038's visibility
 * bound. The focus listener still covers returning from another app before the
 * next tick; hidden windows skip polling until they become active again.
 */
const SYNC_INTERVAL_MS = 5_000;

const EMPTY: PlannerSnapshot = {
  items: [],
  blocks: [],
  sync: { label: 'Everything is synced.', pendingCount: 0, issues: [] },
  staleSources: [],
  driftNote: null,
};

export function PlannerModeContainer({
  onOpenNotes,
  onOpenRef,
}: {
  /** Leaving for the Notes mode is the shell's to do, not this container's. */
  onOpenNotes?: () => void;
  /** Following a reference leaves this mode, which only the shell can do. */
  onOpenRef?: (uri: string) => void;
} = {}): React.ReactElement {
  const [snapshot, setSnapshot] = useState<PlannerSnapshot>(EMPTY);
  const [refLabels, setRefLabels] = useState<Record<string, string>>({});
  const [retrying, setRetrying] = useState(false);
  const syncInFlight = useRef<Promise<void> | null>(null);
  const syncAgain = useRef(false);
  const now = new Date();
  const today = snapshot.today ?? [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');

  const refresh = useCallback(async () => {
    try {
      const next = await bridgeQuery<PlannerSnapshot>('planner-read', {});
      if (next) setSnapshot(next);
    } catch {
      // A failed read leaves the last good snapshot on screen. Blanking the
      // view because one refresh failed would lose what the person was looking
      // at for a condition that resolves itself.
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const reconcile = useCallback((): Promise<void> => {
    if (syncInFlight.current) {
      // A mutation that lands during a pull must get its own pass. Coalescing
      // repeated focus/timer requests is safe; dropping the post-mutation pass
      // would leave new work queued until the next interval or app launch.
      syncAgain.current = true;
      return syncInFlight.current;
    }
    const run = (async () => {
      do {
        syncAgain.current = false;
        try {
          await bridgeQuery('planner-sync', {});
          await refresh();
        } catch {
          // Local-only/offline are normal modes. The durable sync detail is the
          // truthful status and the next active trigger will request another pass.
        }
      } while (syncAgain.current);
    })().finally(() => { syncInFlight.current = null; });
    syncInFlight.current = run;
    return run;
  }, [refresh]);

  /**
   * ADR-029 A3 — the labels are RESOLVED, never stored beside the link.
   *
   * Same read the Notes mode does, and deliberately the same verb: a task whose
   * notes cite a file that has since moved shows where it moved to, and one
   * citing a deleted meeting shows a tombstone, rather than either surface
   * inventing its own wording for the same reference.
   */
  const refKey = snapshot.items.map((item) => item.notes ?? '').join('|');
  useEffect(() => {
    // Keyed by the spelling that appears IN the text, because that is the key
    // the chip looks up. Canonicalising here would silently miss any reference
    // whose written form differs from its canonical one.
    const uris = [...new Set(
      snapshot.items.flatMap((item) => splitTextByWorkspaceRefs(item.notes ?? '')
        .flatMap((segment) => (segment.kind === 'ref' ? [segment.uri] : []))),
    )];
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

  /**
   * ADR-028 D2 — sync runs on its own.
   *
   * The manual Sync button is gone. A button asking you to press it is the
   * network on the critical path wearing a different costume: it makes staying
   * in sync YOUR job, and the moment you forget once the planner is quietly
   * wrong — which is worse than being visibly behind.
   *
   * Three triggers, because one is never enough: on an interval, when the
   * window regains focus (you came back from another device), and immediately
   * after any local mutation. Sync is idempotent and the outbox is ordered, so
   * an extra run costs a round trip and nothing else.
   */
  useEffect(() => {
    let cancelled = false;
    const tick = (): void => {
      if (cancelled || document.hidden) return;
      void reconcile();
    };
    const timer = window.setInterval(tick, SYNC_INTERVAL_MS);
    const onFocus = (): void => tick();
    window.addEventListener('focus', onFocus);
    tick();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [reconcile]);

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
      // Push straight away rather than waiting for the interval: an edit you
      // make and then close the laptop on should already be on its way.
      void reconcile();
    }
  }, [reconcile, refresh]);

  const retrySync = useCallback(async (idempotencyKey?: string): Promise<void> => {
    setRetrying(true);
    try {
      if (idempotencyKey) {
        await bridgeQuery('planner-retry-operation', { idempotencyKey });
      } else {
        await bridgeQuery('planner-retry-all', {}).catch(() => {});
      }
      await reconcile();
    } finally {
      await refresh();
      setRetrying(false);
    }
  }, [reconcile, refresh]);

  const ops: PlannerOps = {
    addItem: (title) => void mutate('planner-add', { title }),
    toggleComplete: (id, completed) => void mutate('planner-update', { id, completed }),
    setDueDate: (id, date) => void mutate('planner-update', { id, dueDate: date }),
    deleteItem: (id) => void mutate('planner-delete', { id }),
    scheduleBlock: (itemId, minutes, at) =>
      void mutate('planner-schedule', { itemId, estimateMinutes: minutes, scheduledFor: at }),
    resolveConflict: (id, field, keep) => void mutate('planner-resolve', { id, field, keep }),
    // Clicking an empty calendar slot blocks a default hour there. An hour is
    // the unit people actually think in; anything shorter turns the primary
    // gesture into a form.
    blockTimeAt: (iso) => void mutate('planner-schedule-at', { scheduledFor: iso, estimateMinutes: 60 }),
    rescheduleBlock: (blockId, scheduledFor) =>
      void mutate('planner-reschedule-block', { blockId, scheduledFor }),
    recordActual: (blockId, actualMinutes) =>
      void mutate('planner-record-actual', { blockId, actualMinutes }),

    /**
     * ADR-029 C2 — Planner → Notes: the notes field opens as a real page.
     *
     * The page is created with the item's own words and cites the item back, so
     * the two are the same thought in two places rather than two copies: A3
     * makes the reference live, so completing the task shows on the page.
     */
    openNotesPage: (itemId, title, notes) => {
      void (async () => {
        const page = await createAndCite({
          mode: 'notes', kind: 'block', title, from: plannerItemUri(itemId),
          fields: { kind: 'page' },
        });
        if (!page.ok) return;
        const parentId = page.uri.replace('brainrouter://notes/block/', '');
        // The prose becomes a child block rather than the page's own text,
        // because a page's text is its title and a paragraph in a title is not
        // a page — it is a very long heading.
        if (notes.trim()) {
          await bridgeQuery('notes-create', { parentId, text: notes, kind: 'paragraph' }).catch(() => {});
        }
        onOpenNotes?.();
      })();
    },

    openRef: (uri) => onOpenRef?.(uri),
    openSource: (url) => { void bridgeQuery('action:open-external', { url }); },
  };

  return (
    <PlannerMode
      items={snapshot.items}
      blocks={snapshot.blocks}
      today={today}
      sync={{
        ...snapshot.sync,
        retrying,
        onRetry: () => { void retrySync(); },
        onRetryIssue: (idempotencyKey) => { void retrySync(idempotencyKey); },
      }}
      staleSources={snapshot.staleSources}
      driftNote={snapshot.driftNote}
      refLabels={refLabels}
      ops={ops}
    />
  );
}
