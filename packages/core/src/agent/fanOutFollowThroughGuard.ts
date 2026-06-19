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
