/**
 * ADR-032 D5 — learning is automatic, bounded, and never blocks a turn.
 *
 * §1's worst gap, stated plainly by the ADR: an agent learns only when it
 * remembers to ask, which is exactly what a struggling agent will not do. The
 * sessions with the most to teach us are the ones least likely to reflect. So
 * there is no tool to call: a checkpoint fires at turn end, at compaction, and
 * at session end, from the runtime.
 *
 * Two constraints hold it in place, and both are enforced HERE rather than
 * trusted to callers:
 *
 * - **after the turn, never inside it.** Callers dispatch this without
 *   awaiting; nothing in this file writes to the turn or its history, so a
 *   person waiting on an answer never waits on reflection.
 * - **bounded per session.** Reflection is an LLM call, and an unbounded one is
 *   a cost leak that scales with how badly a session is going — precisely the
 *   session that fires the most checkpoints.
 *
 * The order inside a checkpoint is deliberate: outcomes are recorded BEFORE
 * candidates are admitted, so a session that contradicted an existing item
 * retires it in the same pass that might otherwise have re-learned a variant of
 * it.
 */
import { reviewLearningCandidate, type LearningCandidate } from './gate.js';
import {
  isLearnedSkillId, learnedSkillId, writeLearnedSkill,
} from './learnedSkills.js';
import {
  buildReflectionPrompt, parseReflectionResponse, type ParsedCandidate,
} from './reflection.js';
import { sweepRetirement, type RetirementPolicy } from './retirement.js';
import {
  applyLearnedTransition, listLearnedItems, logLearningRejection,
  newLearnedItemId, noteLearnedOutcome, readLearningState, storeLearnedItem,
} from './store.js';
import type {
  LearnedItem, LearnedTenant, LearningCheckpointReason,
} from './types.js';

/**
 * Checkpoints one session may spend. Four is a turn-end plus a compaction plus
 * a session-end with one spare — enough that a long session still learns from
 * its middle, few enough that a hundred-turn session costs four calls and not a
 * hundred.
 */
export const MAX_CHECKPOINTS_PER_SESSION = 4;

/** No two checkpoints closer together than this, whatever fired them. */
export const MIN_CHECKPOINT_INTERVAL_MS = 90_000;

/** Below this there is no trajectory to reflect on, only a greeting. */
export const MIN_TRAJECTORY_CHARS = 400;

interface SessionBudget {
  spent: number;
  lastAt: number;
}

/**
 * Per-session budget, in memory.
 *
 * Deliberately NOT persisted: the bound exists to stop one long-running session
 * spending unboundedly, and a process restart is a new session's worth of work
 * anyway. Persisting it would mean a crashed process could never reflect again.
 */
const budgets = new Map<string, SessionBudget>();

/** Sessions tracked at once. A long-lived host must not accumulate keys forever. */
const MAX_TRACKED_SESSIONS = 256;

export function resetLearningBudget(sessionKey?: string): void {
  if (sessionKey) budgets.delete(sessionKey);
  else budgets.clear();
}

export interface CheckpointAdmission {
  readonly sessionKey: string;
  readonly reason: LearningCheckpointReason;
  readonly nowMs: number;
}

/**
 * May this checkpoint run? Exported so the decision is testable without an LLM.
 *
 * A session-end checkpoint ignores the interval — it is the last chance this
 * session has to learn anything, and a session that ends ninety seconds after
 * its previous checkpoint is a short session, not a cheap one. It still spends
 * from the same budget.
 */
export function shouldRunCheckpoint(input: CheckpointAdmission): boolean {
  const budget = budgets.get(input.sessionKey);
  if (!budget) return true;
  if (budget.spent >= MAX_CHECKPOINTS_PER_SESSION) return false;
  if (input.reason === 'session-end') return true;
  return input.nowMs - budget.lastAt >= MIN_CHECKPOINT_INTERVAL_MS;
}

function spendBudget(sessionKey: string, nowMs: number): void {
  const budget = budgets.get(sessionKey) ?? { spent: 0, lastAt: 0 };
  budget.spent += 1;
  budget.lastAt = nowMs;
  budgets.set(sessionKey, budget);
  if (budgets.size > MAX_TRACKED_SESSIONS) {
    // Oldest-first eviction. Losing a budget means at worst one extra call for
    // a session nobody has touched in a while.
    const oldest = [...budgets.entries()].sort((a, b) => a[1].lastAt - b[1].lastAt);
    for (const [key] of oldest.slice(0, budgets.size - MAX_TRACKED_SESSIONS)) budgets.delete(key);
  }
}

export interface LearningCheckpointInput {
  readonly tenant: LearnedTenant;
  readonly sessionKey: string;
  readonly reason: LearningCheckpointReason;
  /** The bounded session window. Untrusted — see `reflection.ts`. */
  readonly trajectory: string;
  /** D7 — did this session read attacker-influenced content? */
  readonly sawUntrustedContent: boolean;
  /** D7 — did the agent or the person actually do something we can point at? */
  readonly corroboratedByTrustedAction: boolean;
  /** The one LLM call. Injected so the checkpoint is testable and host-agnostic. */
  readonly llm: (params: { system: string; user: string }) => Promise<string>;
  /**
   * Route an admitted evidence-tier fact into the memory engine.
   *
   * Learned state is not a parallel memory system: the durable fact belongs in
   * memory like every other durable fact, and this store holds the lifecycle
   * memory does not model. Optional because a host with no brain reachable
   * still gets the behavioural half rather than nothing.
   */
  readonly recordToMemory?: (item: LearnedItem) => Promise<string | undefined>;
  readonly now?: Date;
  readonly retirementPolicy?: RetirementPolicy;
}

export interface LearningCheckpointResult {
  readonly ran: boolean;
  readonly skippedReason?: string;
  readonly admitted: LearnedItem[];
  readonly rejected: Array<{ statement: string; rule: string; reason: string }>;
  readonly outcomes: number;
  readonly transitions: number;
  readonly skillsWritten: string[];
}

const SKIPPED = (reason: string): LearningCheckpointResult => ({
  ran: false,
  skippedReason: reason,
  admitted: [],
  rejected: [],
  outcomes: 0,
  transitions: 0,
  skillsWritten: [],
});

/**
 * Run one checkpoint. Safe to call on every turn end; most calls do nothing.
 *
 * Never throws: a checkpoint that took a turn down with it would make learning
 * a liability, which is the opposite of the point. Every failure path returns a
 * skipped result with a reason a caller can log.
 */
export async function runLearningCheckpoint(
  input: LearningCheckpointInput,
): Promise<LearningCheckpointResult> {
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  if (input.trajectory.trim().length < MIN_TRAJECTORY_CHARS) {
    return SKIPPED('trajectory too short to have taught anything');
  }
  if (!shouldRunCheckpoint({ sessionKey: input.sessionKey, reason: input.reason, nowMs })) {
    return SKIPPED('session checkpoint budget spent');
  }
  spendBudget(input.sessionKey, nowMs);

  let existing: LearnedItem[];
  try {
    existing = listLearnedItems(input.tenant, { includeInactive: false });
  } catch {
    existing = [];
  }

  let raw: string;
  try {
    const prompt = buildReflectionPrompt({
      trajectory: input.trajectory,
      inContext: existing.filter((item) => item.outcome.retrievals > 0),
    });
    raw = await input.llm(prompt);
  } catch (err) {
    return SKIPPED(`reflection call failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const parsed = parseReflectionResponse({
    raw,
    sawUntrustedContent: input.sawUntrustedContent,
    corroboratedByTrustedAction: input.corroboratedByTrustedAction,
    knownItemIds: new Set(existing.map((item) => item.id)),
  });

  // D6 first: a contradiction observed this session retires its item before a
  // variant of the same claim can be admitted below.
  let outcomes = 0;
  try {
    outcomes = noteLearnedOutcome(input.tenant, parsed.outcomes, now).length;
  } catch {
    outcomes = 0;
  }

  const admitted: LearnedItem[] = [];
  const rejected: LearningCheckpointResult['rejected'] = [];
  const skillsWritten: string[] = [];

  for (const candidate of parsed.candidates) {
    const verdict = reviewLearningCandidate(candidate);
    if (!verdict.admitted) {
      rejected.push({ statement: candidate.statement, rule: verdict.rule, reason: verdict.reason });
      try {
        logLearningRejection(
          input.tenant,
          `[${verdict.rule}] ${candidate.statement.slice(0, 200)} — ${verdict.reason}`,
          now,
        );
      } catch { /* the audit line is best effort; the refusal already happened */ }
      continue;
    }

    const item = buildItem(candidate, verdict.tier, verdict.reasoning, input, now);
    let stored: LearnedItem;
    try {
      stored = storeLearnedItem(input.tenant, item, now).item;
    } catch {
      continue;
    }

    // D3 — a procedure that only got stored is still prose. Promote it here or
    // the largest behavioural win in the ADR never actually happens.
    if (
      (candidate.form === 'procedure' || candidate.form === 'delegation')
      && stored.id === item.id
    ) {
      const written = promoteToSkill(candidate, stored, input.tenant, input.sessionKey, now);
      if (written) {
        stored.skillId = written;
        skillsWritten.push(written);
        // Re-store so the skill id is durable; the statement matches, so this
        // reinforces the row it just created rather than adding a second.
        try {
          storeLearnedItem(input.tenant, stored, now);
        } catch { /* the skill file is written; the link is a convenience */ }
      }
    }

    if (input.recordToMemory) {
      try {
        const recordId = await input.recordToMemory(stored);
        if (recordId) stored.memoryRecordId = recordId;
      } catch { /* memory is the durable copy, not the gate */ }
    }
    admitted.push(stored);
  }

  // D6's sweep, on the whole partition, after this session's evidence landed.
  let transitions = 0;
  try {
    const state = readLearningState(input.tenant);
    const pending = sweepRetirement(Object.values(state.items), nowMs, input.retirementPolicy);
    transitions = applyLearnedTransition(input.tenant, pending, now).length;
  } catch {
    transitions = 0;
  }

  return { ran: true, admitted, rejected, outcomes, transitions, skillsWritten };
}

function buildItem(
  candidate: LearningCandidate,
  tier: LearnedItem['tier'],
  gateReasoning: string,
  input: LearningCheckpointInput,
  now: Date,
): LearnedItem {
  const at = now.toISOString();
  return {
    id: newLearnedItemId(),
    tenant: input.tenant,
    tier,
    origin: candidate.origin,
    form: candidate.form,
    statement: candidate.statement,
    falsifier: candidate.falsifier,
    outcome: {
      expectation: candidate.expectation,
      retrievals: 0,
      confirmations: 0,
      contradictions: 0,
    },
    provenance: {
      sessionKey: input.sessionKey,
      capturedAt: at,
      checkpoint: input.reason,
      evidence: [...candidate.evidence],
      corroboratedByTrustedAction: candidate.corroboratedByTrustedAction,
      sawUntrustedContent: candidate.sawUntrustedContent,
      gateReasoning,
    },
    status: 'active',
    createdAt: at,
    updatedAt: at,
  };
}

function promoteToSkill(
  candidate: ParsedCandidate | LearningCandidate,
  item: LearnedItem,
  tenant: LearnedTenant,
  sessionKey: string,
  now: Date,
): string | undefined {
  const steps = 'steps' in candidate && Array.isArray(candidate.steps) ? candidate.steps : [];
  if (steps.length === 0) return undefined;
  const id = learnedSkillId(item.statement);
  if (!isLearnedSkillId(id)) return undefined;
  const written = writeLearnedSkill({
    tenant,
    id,
    description: item.statement,
    steps,
    falsifier: item.falsifier,
    learnedItemId: item.id,
    sessionKey,
    learnedAt: now.toISOString(),
  });
  return written ? id : undefined;
}

/**
 * D1's second tier — a human correction, given in session.
 *
 * Separate entry point on purpose. This is the ONLY way an item reaches the
 * instruction tier: the reflector cannot produce one (it always sets
 * `model-inferred`), and D7 makes that the difference between a person saying
 * "never force-push to a release branch" and a document saying it. The gate
 * still applies — a correction must name what would show it wrong, because a
 * human correction that can never be retired is still a permanent resident.
 */
export function recordHumanCorrection(input: {
  tenant: LearnedTenant;
  sessionKey: string;
  statement: string;
  falsifier: string;
  expectation: string;
  now?: Date;
}): { admitted: true; item: LearnedItem } | { admitted: false; rule: string; reason: string } {
  const now = input.now ?? new Date();
  const candidate: LearningCandidate = {
    form: 'lesson',
    statement: input.statement.trim(),
    falsifier: input.falsifier.trim(),
    expectation: input.expectation.trim(),
    evidence: [`corrected in session ${input.sessionKey}`],
    origin: 'human-correction',
    occurrences: 1,
    sawUntrustedContent: false,
    corroboratedByTrustedAction: true,
    requestedTier: 'instruction',
  };
  const verdict = reviewLearningCandidate(candidate);
  if (!verdict.admitted) {
    logLearningRejection(input.tenant, `[${verdict.rule}] correction refused — ${verdict.reason}`, now);
    return { admitted: false, rule: verdict.rule, reason: verdict.reason };
  }
  const at = now.toISOString();
  const item: LearnedItem = {
    id: newLearnedItemId(),
    tenant: input.tenant,
    tier: verdict.tier,
    origin: 'human-correction',
    form: 'lesson',
    statement: candidate.statement,
    falsifier: candidate.falsifier,
    outcome: {
      expectation: candidate.expectation,
      retrievals: 0,
      confirmations: 0,
      contradictions: 0,
    },
    provenance: {
      sessionKey: input.sessionKey,
      capturedAt: at,
      checkpoint: 'session-end',
      evidence: [...candidate.evidence],
      corroboratedByTrustedAction: true,
      sawUntrustedContent: false,
      gateReasoning: verdict.reasoning,
    },
    status: 'active',
    createdAt: at,
    updatedAt: at,
  };
  return { admitted: true, item: storeLearnedItem(input.tenant, item, now).item };
}
