// ============================
// Scheduler — N-turn trigger evaluator
// ============================
// Stateless logic only. State is persisted in the DB via SqliteMemoryStore.

/** Focus distillation fires every N new Cognitive extractions per user (default: 10). */
export const FOCUS_TRIGGER_EVERY_N = parseInt(process.env.BRAINROUTER_FOCUS_TRIGGER_N ?? "10", 10);

/** Identity distillation fires every N new Cognitive extractions per user (default: 50). */
export const IDENTITY_TRIGGER_EVERY_N = parseInt(process.env.BRAINROUTER_IDENTITY_TRIGGER_N ?? "50", 10);

/** Focus auto-merge max scenes threshold (default: 20). */
export const MAX_FOCUS_SCENES = parseInt(process.env.BRAINROUTER_MAX_FOCUS_SCENES ?? "20", 10);

import type { SchedulerState } from "@brainrouter/types";

export function shouldRunFocusDistill(state: SchedulerState): boolean {
  return state.cognitiveCountSinceLastFocus >= FOCUS_TRIGGER_EVERY_N;
}

export function shouldRunIdentityDistill(state: SchedulerState): boolean {
  return state.cognitiveCountSinceLastIdentity >= IDENTITY_TRIGGER_EVERY_N;
}
