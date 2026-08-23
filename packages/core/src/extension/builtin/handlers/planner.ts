// ADR-041 D8 Phase 1 — the planner tools, migrated out of the runtime switch as
// the proof of the registration+dispatch model. Chosen first because their bodies
// read nothing off the Agent (pure `args` + planner store + clock), so they
// register with an empty BuiltinToolHost and defer the "narrow the god-object"
// work. Each handler body is the former `case` body verbatim (`args` → `ctx.args`).
//
// ADR-028 D6 — the planner. User-scoped, so no workspace is threaded.

import {
  todayView as plannerToday,
  findItems as plannerFind,
  addItem as plannerAddItem,
  updateItem as plannerUpdateItem,
  scheduleBlock as plannerScheduleBlock,
} from '../../../planner/index.js';
import type { BuiltinToolHandler } from './registry.js';

/** The migrated planner tools, keyed by tool name. Registered by the handler barrel. */
export const plannerHandlers: Record<string, BuiltinToolHandler> = {
  planner_today: async ({ args }) => {
    const date = typeof args.date === 'string' ? args.date : new Date().toISOString().slice(0, 10);
    const view = plannerToday(undefined, { date, nowMs: Date.now() });
    return JSON.stringify({
      // Bounded and summarised, never the whole list: fifty low-signal
      // lines make the model worse at the five that matter.
      items: view.items.slice(0, 10).map((i) => ({
        id: i.id, title: i.title.value, dueDate: i.dueDate?.value ?? null,
        source: i.source ?? null,
      })),
      more: Math.max(0, view.items.length - 10),
      nextBlock: view.scheduled[0] ?? view.unscheduled[0] ?? null,
      carriedOver: view.stalled.length,
      conflicts: view.conflicts.length,
      staleSources: view.staleSources,
      drift: view.drift.description,
      syncState: view.syncState,
    }, null, 2);
  },

  planner_find: async ({ args }) => {
    const hits = plannerFind(undefined, String(args.query ?? ''));
    return JSON.stringify({
      items: hits.slice(0, 20).map((i) => ({
        id: i.id, title: i.title.value, completed: i.completed?.value === true,
      })),
    }, null, 2);
  },

  planner_add: async ({ args }) => {
    const title = String(args.title ?? '').trim();
    if (!title) throw new Error('A title is required.');
    const item = plannerAddItem(undefined, {
      title,
      ...(typeof args.notes === 'string' ? { notes: args.notes } : {}),
      ...(typeof args.dueDate === 'string' ? { dueDate: args.dueDate } : {}),
    }, Date.now());
    return JSON.stringify({ id: item.id, title: item.title.value });
  },

  planner_schedule: async ({ args }) => {
    const itemId = String(args.itemId ?? '');
    const minutes = Number(args.estimateMinutes);
    if (!itemId) throw new Error('An item id is required.');
    if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('A positive estimate is required.');
    const block = plannerScheduleBlock(undefined, {
      itemId, estimateMinutes: minutes,
      ...(typeof args.scheduledFor === 'string' ? { scheduledFor: args.scheduledFor } : {}),
    }, Date.now());
    return JSON.stringify({ id: block.id, itemId: block.itemId, estimateMinutes: block.estimateMinutes });
  },

  planner_complete: async ({ args }) => {
    // The tool exists, but the JUDGEMENT is the user's. The spec tells the
    // model never to infer this; the runtime cannot enforce intent, so the
    // refusal lives where the model reads it.
    const itemId = String(args.itemId ?? '');
    if (!itemId) throw new Error('An item id is required.');
    const updated = plannerUpdateItem(undefined, itemId, { completed: true }, Date.now());
    if (!updated) throw new Error(`No planner item ${itemId}.`);
    return JSON.stringify({ id: updated.id, completed: true });
  },
};
