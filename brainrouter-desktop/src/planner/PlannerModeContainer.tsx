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

interface PlannerSnapshot {
  items: PlannerItemView[];
  blocks: PlannerBlockView[];
  syncState: string;
  staleSources: string[];
  driftNote: string | null;
}

const EMPTY: PlannerSnapshot = {
  items: [], blocks: [], syncState: 'Everything is synced.', staleSources: [], driftNote: null,
};

export function PlannerModeContainer(): React.ReactElement {
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
    sync: () => void mutate('planner-sync', {}),
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
