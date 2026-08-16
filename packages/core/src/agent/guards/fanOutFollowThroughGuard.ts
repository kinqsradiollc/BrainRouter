import { isUndifferentiatedFanOut } from '../../orchestration/lenses.js';

export interface FanOutFollowThroughGuardInput {
  fanOutHinted: boolean;
  guardFired: number;
  maxGuardFires: number;
  spawnedChildCount: number;
  interactiveTopLevel: boolean;
  internalSession: boolean;
}

export function shouldRunFanOutFollowThroughGuard(input: FanOutFollowThroughGuardInput): boolean {
  if (!input.fanOutHinted) return false;
  if (input.guardFired >= input.maxGuardFires) return false;
  if (input.spawnedChildCount > 0) return false;
  if (!input.interactiveTopLevel) return false;
  if (input.internalSession) return false;
  return true;
}

export interface FanOutDifferentiationGuardInput {
  fanOutHinted: boolean;
  guardFired: number;
  maxGuardFires: number;
  /** Label of each child spawned this turn, in spawn order. */
  childLabels: readonly (string | undefined)[];
  interactiveTopLevel: boolean;
  internalSession: boolean;
}

/**
 * The complement of the follow-through guard: that one catches spawning NOTHING,
 * this one catches spawning several children that all carry the same angle. Both
 * mean the fan-out did not really happen — the second is just harder to see,
 * because the child count looks right.
 *
 * Deliberately requires ≥3 children. Two children sharing a label is a plausible
 * split-by-target (same question, two subsystems); three or more identical briefs
 * is the undifferentiated case this exists to name.
 */
export function shouldRunFanOutDifferentiationGuard(input: FanOutDifferentiationGuardInput): boolean {
  if (!input.fanOutHinted) return false;
  if (input.guardFired >= input.maxGuardFires) return false;
  if (input.childLabels.length < 3) return false;
  if (!input.interactiveTopLevel) return false;
  if (input.internalSession) return false;
  return isUndifferentiatedFanOut(input.childLabels);
}
