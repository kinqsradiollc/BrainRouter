// ============================
// Scheduler — N-turn trigger evaluator
// ============================
// Stateless logic only. State is persisted in the DB via SqliteMemoryStore.

/** L2 distillation fires every N new L1 extractions per user (default: 10). */
export const L2_TRIGGER_EVERY_N = parseInt(process.env.BRAINROUTER_L2_TRIGGER_N ?? "10", 10);

/** L3 distillation fires every N new L1 extractions per user (default: 50). */
export const L3_TRIGGER_EVERY_N = parseInt(process.env.BRAINROUTER_L3_TRIGGER_N ?? "50", 10);

/** L2 auto-merge max scenes threshold (default: 20). */
export const L2_MAX_SCENES = parseInt(process.env.BRAINROUTER_L2_MAX_SCENES ?? "20", 10);

import type { SchedulerState } from "@brainrouter/types";

export function shouldRunL2(state: SchedulerState): boolean {
  return state.l1CountSinceLastL2 >= L2_TRIGGER_EVERY_N;
}

export function shouldRunL3(state: SchedulerState): boolean {
  return state.l1CountSinceLastL3 >= L3_TRIGGER_EVERY_N;
}
