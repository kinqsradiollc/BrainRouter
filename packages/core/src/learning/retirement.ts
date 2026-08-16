/**
 * ADR-032 D6 — measure whether it helped, and retire what did not.
 *
 * This is the decision that makes the difference between a ratchet and a
 * drift, and §6 says plainly that it is the step worth building: remembering,
 * gating and promoting are table stakes, but a store that only grows becomes
 * noise, and noise is indistinguishable from having learned nothing.
 *
 * §5 Q2 called the first cut a guess. It is written down here as rules with
 * numbers instead, so it can be argued with and changed in one place:
 *
 * | observation | outcome |
 * |---|---|
 * | the falsifier was OBSERVED | retire now — D2 made every item name this exact event |
 * | retrieved, and the expectation held | stays, and a demoted item climbs back |
 * | retrieved repeatedly, never confirmed | demote — it is being paid for and returning nothing |
 * | never retrieved, past the window | demote, then retire on the next sweep |
 *
 * Demotion walks BACK DOWN the ladder the item climbed: an instruction that
 * stops paying off becomes evidence before it becomes nothing. That is the
 * asymmetry the whole ADR is built on — getting better is cheap, getting worse
 * is expensive, and the way back is defined.
 *
 * Pure: takes items and a clock, returns transitions. `store.ts` writes them.
 */
import type { LearnedItem, LearnedStatus, LearnedTier } from './types.js';

export interface RetirementPolicy {
  /** How long an item may sit unretrieved before it stops earning its slot. */
  readonly unusedWindowMs: number;
  /** Retrievals with no confirmation before we call it dead weight. */
  readonly retrievalsWithoutPayoff: number;
  /** Contradictions that end it. One, because D2 made the falsifier explicit. */
  readonly contradictionsToRetire: number;
}

export const DEFAULT_RETIREMENT_POLICY: RetirementPolicy = {
  // Thirty days is roughly a project phase: long enough that a seasonal lesson
  // ("the release checklist") survives a quiet fortnight, short enough that a
  // lesson about a tool we stopped using does not outlive the tool by a quarter.
  unusedWindowMs: 30 * 24 * 60 * 60 * 1000,
  retrievalsWithoutPayoff: 5,
  contradictionsToRetire: 1,
};

export interface LearnedTransition {
  readonly id: string;
  readonly tier?: LearnedTier;
  readonly status: LearnedStatus;
  readonly reason: string;
}

/** One step down the ladder. `null` means the item is already at the bottom. */
function demote(item: LearnedItem): { tier: LearnedTier; status: LearnedStatus } | null {
  if (item.tier === 'instruction') return { tier: 'evidence', status: 'active' };
  if (item.status === 'active') return { tier: 'evidence', status: 'demoted' };
  return null;
}

function ageMs(item: LearnedItem, nowMs: number): number {
  const from = Date.parse(item.outcome.lastRetrievedAt ?? item.createdAt);
  return Number.isFinite(from) ? nowMs - from : 0;
}

/**
 * What should happen to one item right now, or `null` for "nothing".
 *
 * Returning null rather than a no-op transition matters: `store.ts` writes an
 * audit line per transition, and a sweep that logged "no change" for every item
 * on every turn would bury the lines that mean something.
 */
export function evaluateRetirement(
  item: LearnedItem,
  nowMs: number,
  policy: RetirementPolicy = DEFAULT_RETIREMENT_POLICY,
): LearnedTransition | null {
  // A person's undo and an already-retired item are both final. Re-deciding
  // either would make revert a suggestion.
  if (item.status === 'reverted' || item.status === 'retired') return null;

  if (item.outcome.contradictions >= policy.contradictionsToRetire) {
    return {
      id: item.id,
      status: 'retired',
      reason: `the falsifier was observed ${item.outcome.contradictions}× — "${item.falsifier}"`,
    };
  }

  // Something that keeps paying off climbs back. Without this the ladder only
  // goes one way, and a lesson that was quiet for a month then proved itself
  // twice would still be on its way out.
  if (
    item.status === 'demoted'
    && !!item.outcome.lastConfirmedAt
    && Date.parse(item.outcome.lastConfirmedAt) > Date.parse(item.statusChangedAt ?? item.updatedAt)
    && ageMs(item, nowMs) < policy.unusedWindowMs
  ) {
    return {
      id: item.id,
      status: 'active',
      reason: 'an observed outcome confirmed it after demotion — restored',
    };
  }

  const unused = ageMs(item, nowMs) >= policy.unusedWindowMs;

  if (item.outcome.retrievals === 0 && unused) {
    const next = demote(item);
    return next
      ? {
        id: item.id,
        tier: next.tier,
        status: next.status,
        reason: 'never retrieved inside the window — it is not being used',
      }
      : {
        id: item.id,
        status: 'retired',
        reason: 'never retrieved, and already at the bottom of the ladder',
      };
  }

  if (
    item.outcome.retrievals >= policy.retrievalsWithoutPayoff
    && item.outcome.confirmations === 0
  ) {
    const next = demote(item);
    return next
      ? {
        id: item.id,
        tier: next.tier,
        status: next.status,
        reason: `retrieved ${item.outcome.retrievals}× and never confirmed — "${item.outcome.expectation}" has not happened`,
      }
      : {
        id: item.id,
        status: 'retired',
        reason: `retrieved ${item.outcome.retrievals}× and never confirmed, at the bottom of the ladder`,
      };
  }

  return null;
}

/** The whole partition, swept. Called from the checkpoint, bounded by item count. */
export function sweepRetirement(
  items: readonly LearnedItem[],
  nowMs: number,
  policy: RetirementPolicy = DEFAULT_RETIREMENT_POLICY,
): LearnedTransition[] {
  const transitions: LearnedTransition[] = [];
  for (const item of items) {
    const transition = evaluateRetirement(item, nowMs, policy);
    if (transition) transitions.push(transition);
  }
  return transitions;
}
