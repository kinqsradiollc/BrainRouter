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
import React, { useCallback, useEffect, useState } from 'react';
import { PlannerMode, type PlannerOps } from './PlannerMode.js';
import type { PlannerItemView, PlannerBlockView } from '../lib/planner/plannerView.js';
import { bridgeQuery } from '../lib/bridgeQuery.js';
import { createAndCite, plannerItemUri } from '../lib/workspace/crossMode.js';

interface PlannerSnapshot {
  items: PlannerItemView[];
  blocks: PlannerBlockView[];
  syncState: string;
  staleSources: string[];
  driftNote: string | null;
}

/**
 * How often the planner reconciles with the server.
 *
 * Thirty seconds: fast enough that a change made on your phone is on screen
 * before you wonder where it went, slow enough that an idle planner is not a
 * heartbeat. The focus listener covers the case this interval would be too slow
 * for — coming back to the machine after an hour elsewhere.
 */
const SYNC_INTERVAL_MS = 30_000;

const EMPTY: PlannerSnapshot = {
  items: [], blocks: [], syncState: 'Everything is synced.', staleSources: [], driftNote: null,
};

export function PlannerModeContainer({
  onOpenNotes,
}: {
  /** Leaving for the Notes mode is the shell's to do, not this container's. */
  onOpenNotes?: () => void;
} = {}): React.ReactElement {
  const [snapshot, setSnapshot] = useState<PlannerSnapshot>(EMPTY);
  const today = new Date().toISOString().slice(0, 10);

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
    const tick = async (): Promise<void> => {
      if (cancelled || document.hidden) return;
      try {
        await bridgeQuery('planner-sync', {});
        if (!cancelled) await refresh();
      } catch {
        // Offline is the normal mode that happens to be syncing (D2). The
        // state line already says how many changes are waiting.
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
      void bridgeQuery('planner-sync', {}).catch(() => {});
    }
  }, [refresh]);

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
    openBlock: (blockId) => void mutate('planner-open-block', { blockId }),

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
  };

  return (
    <PlannerMode
      items={snapshot.items}
      blocks={snapshot.blocks}
      today={today}
      syncState={snapshot.syncState}
      staleSources={snapshot.staleSources}
      driftNote={snapshot.driftNote}
      ops={ops}
    />
  );
}
