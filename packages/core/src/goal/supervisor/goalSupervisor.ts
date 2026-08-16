/**
 * ADR-040 A40-2 — the Core goal supervisor.
 *
 * Not a fifth turn engine: a Core-owned recorder that both hosts share. When a
 * goal is active, each bounded turn ends with the SAME continuation decision
 * (`decideGoalContinuation`), and the supervisor records the CONTENT-FREE reason
 * between turns — a stable code, never prose — keyed by the goal instance. So the
 * CLI and Desktop show one continuation history, and neither invents its own.
 *
 * It is optional and never a prerequisite for per-turn topology selection (§8.1):
 * nothing here is read by the resolver; it only records what already happened.
 */
import { getSessionStateFile, readJsonFile } from '../../storage/store.js';
import { writeFileAtomic } from '../../util/fs/atomicFile.js';
import type { GoalContinuationDecision } from '../prompt/goalContinuation.js';

/** Bounded, content-free reason codes — the shared vocabulary both hosts record. */
export type GoalContinuationReasonCode =
  | 'progress'          // the turn made tool calls; continue
  | 'corrective-retry'  // prose-only turn; one corrective retry
  | 'prose-halt'        // two prose-only turns; halt continuation
  | 'iteration-budget'  // iteration budget exhausted
  | 'token-budget'      // token budget exhausted
  | 'stopped';          // goal not active / completed / blocked / transitioned

/** Derive the content-free reason code from the shared continuation decision. */
export function goalContinuationReasonCode(decision: GoalContinuationDecision): GoalContinuationReasonCode {
  switch (decision.kind) {
    case 'continue': return decision.corrective ? 'corrective-retry' : 'progress';
    case 'halt-prose': return 'prose-halt';
    case 'usage-limited': return /token/i.test(decision.reason) ? 'token-budget' : 'iteration-budget';
    case 'stop': return 'stopped';
  }
}

export interface GoalContinuationRecord {
  /** The continuation decision kind, as decided by the shared service. */
  kind: GoalContinuationDecision['kind'];
  reasonCode: GoalContinuationReasonCode;
  /** The goal instance this turn ran under (`${sessionKey}:${goal.setAt}`). */
  goalId: string;
  at: string;
}

/** How many recent continuation records the supervisor keeps. Bounded, never a transcript. */
export const GOAL_SUPERVISOR_MAX_RECORDS = 100;

const LEDGER_FILE = 'goal-supervisor.json';

function ledgerPath(workspaceRoot: string, sessionKey: string): string {
  return getSessionStateFile(workspaceRoot, sessionKey, LEDGER_FILE);
}

export function readGoalContinuationLedger(workspaceRoot: string, sessionKey: string): GoalContinuationRecord[] {
  try {
    const raw = readJsonFile<GoalContinuationRecord[] | null>(ledgerPath(workspaceRoot, sessionKey), null);
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

/**
 * Append one continuation record for the current goal instance. Best-effort and
 * bounded: a supervisor write must never break the turn it is describing, and the
 * ledger is capped so it can never grow into a transcript.
 */
export function recordGoalContinuation(
  workspaceRoot: string,
  sessionKey: string,
  input: { goalId: string; decision: GoalContinuationDecision; at: string },
): void {
  try {
    const ledger = readGoalContinuationLedger(workspaceRoot, sessionKey);
    ledger.push({
      kind: input.decision.kind,
      reasonCode: goalContinuationReasonCode(input.decision),
      goalId: input.goalId,
      at: input.at,
    });
    const bounded = ledger.slice(-GOAL_SUPERVISOR_MAX_RECORDS);
    writeFileAtomic(ledgerPath(workspaceRoot, sessionKey), JSON.stringify(bounded));
  } catch {
    /* best-effort — recording the reason never blocks the goal loop */
  }
}

/** The continuation records a goal instance parented, in order — the supervisor view. */
export function goalContinuationHistory(
  workspaceRoot: string,
  sessionKey: string,
  goalId: string,
): readonly GoalContinuationRecord[] {
  return readGoalContinuationLedger(workspaceRoot, sessionKey).filter((r) => r.goalId === goalId);
}
