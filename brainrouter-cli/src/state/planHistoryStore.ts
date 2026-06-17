/**
 * PLAN APPROVAL & HISTORY (0.4.15, §7) — durable, per-session record of plan
 * review decisions. Each time a plan is approved or changes are requested we
 * append a decision that SNAPSHOTS the plan at that moment, so the decision
 * list doubles as the plan's version history; `diffSnapshots` derives the
 * change between any two snapshots.
 *
 * Persisted at `<workspace>/.brainrouter/cli/sessions/<encodedKey>/planHistory.json`
 * (session-scoped, like taskStore's tasks.json). Pure functions of
 * (workspaceRoot, sessionKey, …) so they are trivially testable without a REPL.
 * BrainRouter memory stays the source of truth for reusable decisions — the
 * caller captures a memory note and links its id back via `linkPlanDecision`.
 */
import { randomUUID } from 'node:crypto';
import { getSessionStateFile, readJsonFile, writeJsonFile } from './cliState.js';
import type { PlanItem } from './taskStore.js';

export type PlanVerdict = 'approved' | 'changes-requested';

export interface PlanDecision {
  id: string;
  sessionKey: string;
  workspaceRoot: string;
  verdict: PlanVerdict;
  /** Requested-change feedback (returned to the session); empty for an approval. */
  feedback?: string;
  /** The plan as it stood when the decision was made — the version snapshot. */
  planSnapshot: PlanItem[];
  /** The plan's explanation at decision time, when present. */
  explanation?: string;
  /** Requirement this plan is anchored to, when known. */
  requirementId?: string;
  /** Cognitive memory record ids captured for this decision. */
  linkedMemoryIds: string[];
  createdAt: string;
}

interface PlanHistory {
  decisions: PlanDecision[];
}

function historyFile(workspaceRoot: string, sessionKey: string): string {
  return getSessionStateFile(workspaceRoot, sessionKey, 'planHistory.json');
}

// A FRESH default literal per read — never a shared constant, since callers
// build new arrays off `.decisions` and a shared default would accumulate
// state across calls (readJsonFile returns the default by reference when the
// file is missing).
function readHistory(workspaceRoot: string, sessionKey: string): PlanHistory {
  return readJsonFile<PlanHistory>(historyFile(workspaceRoot, sessionKey), { decisions: [] });
}

/** Every plan decision for a session, oldest-first (append order). */
export function readPlanHistory(workspaceRoot: string, sessionKey: string): PlanDecision[] {
  return readHistory(workspaceRoot, sessionKey).decisions;
}

export interface RecordPlanDecisionInput {
  verdict: PlanVerdict;
  planSnapshot: PlanItem[];
  feedback?: string;
  explanation?: string;
  requirementId?: string;
}

/**
 * Append a plan decision (snapshotting the supplied plan). Returns the stored
 * decision. Generates a `pdec_<8hex>` id and stamps createdAt.
 */
export function recordPlanDecision(
  workspaceRoot: string,
  sessionKey: string,
  input: RecordPlanDecisionInput,
): PlanDecision {
  const all = readHistory(workspaceRoot, sessionKey);
  const decision: PlanDecision = {
    id: `pdec_${randomUUID().slice(0, 8)}`,
    sessionKey,
    workspaceRoot,
    verdict: input.verdict,
    planSnapshot: input.planSnapshot.map((i) => ({ ...i })),
    linkedMemoryIds: [],
    createdAt: new Date().toISOString(),
  };
  const feedback = input.feedback?.trim();
  if (feedback) decision.feedback = feedback;
  const explanation = input.explanation?.trim();
  if (explanation) decision.explanation = explanation;
  if (input.requirementId) decision.requirementId = input.requirementId;
  writeJsonFile(historyFile(workspaceRoot, sessionKey), { decisions: [...all.decisions, decision] });
  return decision;
}

/** Push a memory id into a decision's `linkedMemoryIds` (de-duplicated). */
export function linkPlanDecision(
  workspaceRoot: string,
  sessionKey: string,
  decisionId: string,
  memoryId: string,
): PlanDecision | undefined {
  const all = readHistory(workspaceRoot, sessionKey);
  const d = all.decisions.find((x) => x.id === decisionId);
  if (!d) return undefined;
  if (memoryId && !d.linkedMemoryIds.includes(memoryId)) {
    d.linkedMemoryIds = [...d.linkedMemoryIds, memoryId];
    writeJsonFile(historyFile(workspaceRoot, sessionKey), all);
  }
  return d;
}

export interface PlanSnapshotDiff {
  added: string[];
  removed: string[];
  /** Steps whose status changed: step → [from, to]. */
  changed: Array<{ step: string; from: string; to: string }>;
}

/**
 * Pure diff between two plan snapshots, keyed by step text: which steps were
 * added/removed, and which kept the same step but changed status. Drives the
 * "plan version diffs persist" requirement.
 */
export function diffSnapshots(before: PlanItem[], after: PlanItem[]): PlanSnapshotDiff {
  const beforeByStep = new Map(before.map((i) => [i.step, i.status]));
  const afterByStep = new Map(after.map((i) => [i.step, i.status]));
  const added = after.filter((i) => !beforeByStep.has(i.step)).map((i) => i.step);
  const removed = before.filter((i) => !afterByStep.has(i.step)).map((i) => i.step);
  const changed: PlanSnapshotDiff['changed'] = [];
  for (const [step, from] of beforeByStep) {
    const to = afterByStep.get(step);
    if (to !== undefined && to !== from) changed.push({ step, from, to });
  }
  return { added, removed, changed };
}
