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
import {
  MAX_EXPECTATION_CHARS,
  MAX_FALSIFIER_CHARS,
  MAX_STATEMENT_CHARS,
  reviewLearningCandidate,
  type LearningCandidate,
} from './gate.js';
import {
  isLearnedSkillId, learnedSkillId, writeLearnedSkill,
} from './learnedSkills.js';
import {
  buildReflectionPrompt, parseReflectionResponse, type ParsedCandidate,
} from './reflection.js';
import { sweepRetirement, type RetirementPolicy } from './retirement.js';
import {
  applyLearnedTransition, attachLearnedMemoryRecord, attachLearnedSkill,
  claimLearningOutcomeSyncBatch, claimLearningReconciliationBatch,
  completeLearningOutcomeSync, completeLearningReconciliation, getLearnedItem,
  hasPendingLearningOutcomeSync,
  learningReconciliationSnapshot, listLearnedItemsDeliveredInSession, logLearningRejection, newLearnedItemId,
  noteLearnedOutcome, pendingLearningOutcomeSyncForSession, readLearningState,
  storeLearnedItem, updateLearnedMemoryLifecycle,
} from './store.js';
import { applyCentralLearnedRevert, synchronizeLearnedItemLifecycle } from './lifecycle.js';
import type {
  LearnedItem, LearnedProcedureStep, LearnedTenant, LearningCheckpointReason,
} from './types.js';
import { redactText } from '../session/transcript/sessionStore.js';
import type { LearningOutcomeSyncEvent } from './store.js';

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
  if (sessionKey) {
    for (const key of budgets.keys()) {
      let matches = key === sessionKey;
      if (!matches && key.startsWith('[')) {
        try {
          const parts = JSON.parse(key) as unknown[];
          matches = parts[2] === sessionKey;
        } catch { /* not a compound key */ }
      }
      if (matches) budgets.delete(key);
    }
  } else budgets.clear();
}

export interface CheckpointAdmission {
  readonly sessionKey: string;
  /**
   * The workspace this session ran in, recorded so a lesson knows WHERE it was
   * learned. Selection uses it to keep repo-specific advice from being
   * delivered, confidently and wrongly, in an unrelated codebase.
   */
  readonly project?: string;
  readonly tenant?: LearnedTenant;
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
  const budget = budgets.get(checkpointKey(input.tenant, input.sessionKey));
  if (!budget) return true;
  if (budget.spent >= MAX_CHECKPOINTS_PER_SESSION) return false;
  if (input.reason === 'session-end') return true;
  return input.nowMs - budget.lastAt >= MIN_CHECKPOINT_INTERVAL_MS;
}

function checkpointKey(tenant: LearnedTenant | undefined, sessionKey: string): string {
  return tenant
    ? JSON.stringify([
      tenant.orgId?.trim() || null,
      tenant.userId.trim() || 'local',
      sessionKey,
    ])
    : sessionKey;
}

function spendBudget(key: string, nowMs: number): void {
  const budget = budgets.get(key) ?? { spent: 0, lastAt: 0 };
  budget.spent += 1;
  budget.lastAt = nowMs;
  budgets.set(key, budget);
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
  /**
   * The workspace this session ran in, recorded so a lesson knows WHERE it was
   * learned. Selection uses it to keep repo-specific advice from being
   * delivered, confidently and wrongly, in an unrelated codebase.
   */
  readonly project?: string;
  readonly reason: LearningCheckpointReason;
  /** The bounded session window. Untrusted — see `reflection.ts`. */
  readonly trajectory: string;
  /** D7 — did this session read attacker-influenced content? */
  readonly sawUntrustedContent: boolean;
  /** D7 — did the agent or the person actually do something we can point at? */
  readonly corroboratedByTrustedAction: boolean;
  /** Successful actions in later model batches than the last untrusted read. */
  readonly eligibleCorroboratingActions?: readonly {
    id: string;
    toolName: string;
    summary?: string;
  }[];
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
  /** Archive a linked central-memory fact after automatic retirement/demotion. */
  readonly archiveMemory?: (item: LearnedItem, reason: string) => Promise<void>;
  readonly restoreMemory?: (item: LearnedItem, reason: string) => Promise<void>;
  /** Mirror the bounded API/dashboard projection after a local outcome or
   * lifecycle change. Hosted in-process adapters can implement this without
   * exposing metadata mutation as a model-callable tool. */
  readonly syncMemory?: (item: LearnedItem) => Promise<void>;
  /** Deliver one runtime-owned session observation through the hidden host
   * channel before aggregate counters or lifecycle state are projected. */
  readonly syncOutcome?: (event: LearningOutcomeSyncEvent) => Promise<void>;
  /** Reconcile explicit central human reverts back into this local ledger. */
  readonly readMemoryLifecycle?: (item: LearnedItem) => Promise<{
    status: LearnedItem['status'] | 'missing';
    reason?: string;
  }>;
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

/** Baseline learned procedures may inspect and report, but not mutate. */
const LEARNED_READ_ONLY_TOOLS = [
  'read_file',
  'grep_search',
  'glob_files',
  'list_dir',
  'extract_result',
  'get_skill',
  'list_skills',
  'search_skills',
  'memory_recall',
  'memory_search',
] as const;

/** Mutation-shaped grants narrow enough to carry forward when the exact tool
 * succeeded and was selected as relevant corroboration. Shell/terminal access
 * is intentionally absent: observing one command cannot safely authorize all
 * future commands. */
const SAFE_OBSERVED_GRANTS = new Set([
  'write_file',
  'edit_file',
  'apply_patch',
  'notebook_edit',
  'ask_user_choice',
]);

function learnedToolCeiling(
  candidate: LearningCandidate,
  input: LearningCheckpointInput,
): string[] {
  const cited = new Set(candidate.corroboratingActionIds ?? []);
  const observed = (input.eligibleCorroboratingActions ?? [])
    .filter((action) => cited.has(action.id) && SAFE_OBSERVED_GRANTS.has(action.toolName))
    .map((action) => action.toolName);
  return [...new Set([...LEARNED_READ_ONLY_TOOLS, ...observed])];
}

/** The most steps one procedure may carry. A trajectory can cite many more. */
const MAX_PROCEDURE_LEDGER_STEPS = 24;

/**
 * D3 — the exact successful actions a procedure may replay.
 *
 * Built from what the RUNTIME observed, never from what the model wrote. The
 * model contributes citations and nothing else, and three properties follow
 * from that which are the entire reason this is separate from `steps`:
 *
 * - a cited id with no matching observed action is DROPPED, so a step cannot be
 *   invented by naming one;
 * - the order is the runtime's observation order, not the citation order, so a
 *   procedure cannot be made to claim things happened in an order they did not;
 * - a step whose tool is outside the ceiling this same evidence produced is
 *   dropped, so the ledger can never widen authority — it is bounded BY the
 *   ceiling rather than sitting beside it.
 */
function procedureLedger(
  candidate: LearningCandidate,
  input: LearningCheckpointInput,
  ceiling: readonly string[],
): LearnedProcedureStep[] {
  const cited = new Set(candidate.corroboratingActionIds ?? []);
  if (cited.size === 0) return [];
  const permitted = new Set(ceiling);
  const seen = new Set<string>();
  const steps: LearnedProcedureStep[] = [];
  for (const action of input.eligibleCorroboratingActions ?? []) {
    if (steps.length >= MAX_PROCEDURE_LEDGER_STEPS) break;
    if (!cited.has(action.id) || seen.has(action.id)) continue;
    if (!permitted.has(action.toolName)) continue;
    seen.add(action.id);
    steps.push(Object.freeze({
      actionId: action.id,
      toolName: action.toolName,
      ...(action.summary ? { summary: action.summary } : {}),
    }));
  }
  return steps;
}

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
  const key = checkpointKey(input.tenant, input.sessionKey);
  const previous = checkpointQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.catch(() => undefined).then(() => turn);
  checkpointQueues.set(key, queued);
  await previous.catch(() => undefined);
  try {
    return await runLearningCheckpointSerialized(input);
  } finally {
    release();
    if (checkpointQueues.get(key) === queued) checkpointQueues.delete(key);
  }
}

const checkpointQueues = new Map<string, Promise<void>>();

const MAX_RECONCILIATION_ITEMS = 4;

function lifecycleMemoryPort(
  input: LearningCheckpointInput,
  item: LearnedItem,
) {
  return input.archiveMemory
    ? {
      archive: ({ reason }: { reason: string }) => input.archiveMemory!(item, reason),
      ...(input.restoreMemory
        ? { restore: ({ reason }: { reason: string }) => input.restoreMemory!(item, reason) }
        : {}),
    }
    : undefined;
}

async function syncCurrentProjection(
  input: LearningCheckpointInput,
  itemId: string,
): Promise<boolean> {
  // Aggregate counters cannot identify which session moved from confirmation
  // to contradiction. Never let that projection race ahead of its normalized
  // event or overwrite confirmations learned by another runtime.
  if (hasPendingLearningOutcomeSync(input.tenant, itemId)) return false;
  const snapshot = learningReconciliationSnapshot(input.tenant, itemId);
  if (!snapshot) return true;
  if (!snapshot.item.memoryRecordId) return snapshot.item.status === 'reverted';
  if (!input.syncMemory) return false;
  try {
    await input.syncMemory(snapshot.item);
  } catch {
    return false;
  }
  const latest = learningReconciliationSnapshot(input.tenant, itemId);
  // The authenticated sync RPC may discover that a human reverted the item
  // between inspection and update. Its adapter applies that decision locally;
  // central state is already authoritative, so clear that newest local dirty
  // revision rather than retrying a write the server must keep refusing.
  if (latest?.item.status === 'reverted' && snapshot.item.status !== 'reverted') {
    return completeLearningReconciliation(input.tenant, itemId, latest.dirtyRevision);
  }
  return completeLearningReconciliation(input.tenant, itemId, snapshot.dirtyRevision);
}

async function syncPendingOutcomeEvent(
  input: LearningCheckpointInput,
  event: LearningOutcomeSyncEvent,
  now: Date,
): Promise<boolean> {
  if (!input.syncOutcome) return false;
  try {
    await input.syncOutcome(event);
    return completeLearningOutcomeSync(input.tenant, event, now);
  } catch {
    return false;
  }
}

/** Retry a bounded, rotating set before lifecycle reconciliation. Pending
 * entries survive crashes because claiming does not remove them. */
async function reconcileLearningOutcomeBatch(
  input: LearningCheckpointInput,
  now: Date,
): Promise<void> {
  if (!input.syncOutcome) return;
  let batch: LearningOutcomeSyncEvent[];
  try {
    batch = claimLearningOutcomeSyncBatch(input.tenant, MAX_RECONCILIATION_ITEMS);
  } catch {
    return;
  }
  for (const event of batch) await syncPendingOutcomeEvent(input, event, now);
}

async function reconcileLearningItem(
  input: LearningCheckpointInput,
  itemId: string,
  now: Date,
): Promise<void> {
  let item = getLearnedItem(input.tenant, itemId);
  if (!item) return;

  if (item.memoryRecordId && item.status !== 'reverted' && input.readMemoryLifecycle) {
    try {
      const remote = await input.readMemoryLifecycle(item);
      if (remote.status === 'reverted') {
        applyCentralLearnedRevert({
          tenant: input.tenant,
          id: item.id,
          reason: remote.reason?.trim() || 'reverted from the hosted learning dashboard',
          now,
        });
        const latest = learningReconciliationSnapshot(input.tenant, item.id);
        if (latest) completeLearningReconciliation(input.tenant, item.id, latest.dirtyRevision);
        return;
      }
    } catch {
      // Keep the row dirty. A later fair pass retries without blocking the turn
      // or letting this record monopolize the bounded reconciliation budget.
    }
  }

  if (!item.memoryRecordId) {
    if (item.status === 'reverted') {
      const latest = learningReconciliationSnapshot(input.tenant, item.id);
      if (latest) completeLearningReconciliation(input.tenant, item.id, latest.dirtyRevision);
      return;
    }
    if (!input.recordToMemory) return;
    try {
      const recordId = await input.recordToMemory(item);
      if (!recordId) throw new Error('central memory returned no record id');
      item = attachLearnedMemoryRecord(input.tenant, item.id, recordId, now) ?? item;
    } catch (error) {
      updateLearnedMemoryLifecycle(input.tenant, item.id, {
        status: 'record-pending',
        error: error instanceof Error ? error.message : String(error),
        incrementAttempts: true,
      }, now);
      return;
    }
  }

  item = getLearnedItem(input.tenant, item.id) ?? item;
  // The semantic event owns contradiction counter movement and retirement in
  // central storage. It must land before any aggregate/lifecycle projection.
  if (hasPendingLearningOutcomeSync(input.tenant, item.id)) return;
  const desiredMemoryStatus = item.status === 'active' ? 'active' : 'archived';
  let lifecycleComplete = item.memoryLifecycle?.status === desiredMemoryStatus;
  if (!lifecycleComplete) {
    const lifecycle = await synchronizeLearnedItemLifecycle({
      tenant: input.tenant,
      item,
      memory: lifecycleMemoryPort(input, item),
      now,
    });
    lifecycleComplete = lifecycle.memory.status === desiredMemoryStatus;
  }
  if (!lifecycleComplete) return;
  if (!learningReconciliationSnapshot(input.tenant, item.id)?.dirtyRevision) return;
  await syncCurrentProjection(input, item.id);
}

async function reconcileLearningBatch(input: LearningCheckpointInput, now: Date): Promise<void> {
  let batch: ReturnType<typeof claimLearningReconciliationBatch>;
  try {
    batch = claimLearningReconciliationBatch(input.tenant, MAX_RECONCILIATION_ITEMS);
  } catch {
    return;
  }
  for (const entry of batch) {
    try {
      await reconcileLearningItem(input, entry.item.id, now);
    } catch { /* local state remains fail-closed and queued for a later pass */ }
  }
}

async function runLearningCheckpointSerialized(
  input: LearningCheckpointInput,
): Promise<LearningCheckpointResult> {
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  // Lifecycle and counter reconciliation is not reflection. It runs before
  // trajectory/cost admission, includes inactive rows, and uses a durable fair
  // queue/cursor so four broken records cannot starve the rest forever.
  await reconcileLearningOutcomeBatch(input, now);
  await reconcileLearningBatch(input, now);

  let inContext: LearnedItem[];
  try {
    inContext = listLearnedItemsDeliveredInSession(input.tenant, input.sessionKey);
  } catch {
    inContext = [];
  }

  // Revocation reconciliation is not reflection: it has no model/cost budget
  // and must still run for an idle client whose trajectory is short or whose
  // session already spent its LLM checkpoints.
  if (input.trajectory.trim().length < MIN_TRAJECTORY_CHARS) {
    return SKIPPED('trajectory too short to have taught anything');
  }
  if (!shouldRunCheckpoint({
    tenant: input.tenant, sessionKey: input.sessionKey, reason: input.reason, nowMs,
  })) {
    return SKIPPED('session checkpoint budget spent');
  }
  spendBudget(checkpointKey(input.tenant, input.sessionKey), nowMs);

  // `buildReflectionPrompt` caps this list at sixteen. Give the parser the
  // identical authority set rather than every item delivered earlier in a
  // long session but omitted from this checkpoint's prompt.
  const reflectionContext = inContext.slice(0, 16);
  let raw: string;
  try {
    const prompt = buildReflectionPrompt({
      trajectory: input.trajectory,
      inContext: reflectionContext,
      eligibleActions: input.eligibleCorroboratingActions,
    });
    raw = await input.llm(prompt);
  } catch (err) {
    return SKIPPED(`reflection call failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const parsed = parseReflectionResponse({
    raw,
    trajectory: input.trajectory,
    sawUntrustedContent: input.sawUntrustedContent,
    corroboratedByTrustedAction: input.corroboratedByTrustedAction,
    eligibleActions: input.eligibleCorroboratingActions,
    // An item that was not delivered in this trajectory cannot have had an
    // outcome in this trajectory. Keep the parser's authority no broader than
    // the exact list shown in its prompt.
    knownItemIds: new Set(reflectionContext.map((item) => item.id)),
  });

  // D6 first: a contradiction observed this session retires its item before a
  // variant of the same claim can be admitted below.
  let outcomes = 0;
  try {
    const changedOutcomes = noteLearnedOutcome(
      input.tenant,
      input.sessionKey,
      parsed.outcomes,
      now,
    );
    outcomes = changedOutcomes.length;
    for (const changed of changedOutcomes) {
      const event = pendingLearningOutcomeSyncForSession(
        input.tenant,
        input.sessionKey,
        changed.id,
      );
      const delivered = event
        ? await syncPendingOutcomeEvent(input, event, now)
        : !hasPendingLearningOutcomeSync(input.tenant, changed.id);
      if (delivered && input.syncMemory) await syncCurrentProjection(input, changed.id);
    }
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
    let capacityRetired: LearnedItem[] = [];
    try {
      const storedResult = storeLearnedItem(input.tenant, item, now);
      stored = storedResult.item;
      capacityRetired = storedResult.capacityRetired;
    } catch {
      continue;
    }

    // Capacity is a lifecycle transition, not a local-only eviction. Route it
    // through the same archive/projection path immediately; failed work stays
    // in the durable dirty queue for a later pre-budget pass.
    for (const retired of capacityRetired) {
      await reconcileLearningItem(input, retired.id, now);
    }

    if (input.recordToMemory && stored.memoryLifecycle?.status !== 'active') {
      try {
        const recordId = await input.recordToMemory(stored);
        if (!recordId) throw new Error('central memory returned no record id');
        stored = attachLearnedMemoryRecord(input.tenant, stored.id, recordId, now) ?? stored;
        await syncCurrentProjection(input, stored.id);
      } catch (error) {
        stored = updateLearnedMemoryLifecycle(input.tenant, stored.id, {
          status: 'record-pending',
          error: error instanceof Error ? error.message : String(error),
          incrementAttempts: true,
        }, now) ?? stored;
      }
    }

    // Promote only after the central pointer is durable (or in a deliberately
    // local-only host). This prevents a runnable skill whose fact cannot later
    // be located and retired.
    if (candidate.form === 'procedure' && stored.id === item.id) {
      const written = promoteToSkill(candidate, stored, input.tenant, input.sessionKey, now);
      if (written) {
        skillsWritten.push(written);
        try {
          stored = attachLearnedSkill(input.tenant, stored.id, written, now) ?? stored;
        } catch { /* a missing link keeps the resolver fail-closed */ }
        await syncCurrentProjection(input, stored.id);
      }
    }
    admitted.push(stored);
  }

  // D6's sweep, on the whole partition, after this session's evidence landed.
  let transitions = 0;
  try {
    const state = readLearningState(input.tenant);
    const pending = sweepRetirement(Object.values(state.items), nowMs, input.retirementPolicy);
    const changed = applyLearnedTransition(input.tenant, pending, now);
    transitions = changed.length;
    for (const changedItem of changed) {
      await reconcileLearningItem(input, changedItem.id, now);
    }
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
  const allowedTools = learnedToolCeiling(candidate, input);
  // Only a procedure replays anything, so only a procedure carries the ledger.
  // A lesson changes what the agent BELIEVES; giving it a list of calls would
  // imply a replay path that does not exist for it.
  const ledger = candidate.form === 'procedure' ? procedureLedger(candidate, input, allowedTools) : [];
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
      corroboratingActionIds: candidate.corroboratingActionIds,
      sawUntrustedContent: candidate.sawUntrustedContent,
      gateReasoning,
      ...(input.project ? { project: input.project } : {}),
    },
    allowedTools,
    ...(ledger.length > 0 ? { procedureLedger: ledger } : {}),
    status: 'active',
    statusChangedAt: at,
    ...(input.recordToMemory
      ? { memoryLifecycle: { status: 'record-pending' as const, updatedAt: at, attempts: 0 } }
      : {}),
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
  const id = learnedSkillId(item.statement, item.id);
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
    allowedTools: item.allowedTools ?? LEARNED_READ_ONLY_TOOLS,
    observedActions: item.procedureLedger ?? [],
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
export interface HumanCorrectionInput {
  tenant: LearnedTenant;
  sessionKey: string;
  /** Workspace this correction was made in — see LearnedProvenance.project. */
  project?: string;
  statement: string;
  falsifier: string;
  expectation: string;
  now?: Date;
  /** Hosts with their own durable store may supply the stable id they minted. */
  itemId?: string;
}

export type HumanCorrectionResult =
  | { admitted: true; item: LearnedItem }
  | { admitted: false; rule: string; reason: string };

/**
 * Validate and build a correction without choosing where it is stored.
 *
 * Device runtimes call `recordHumanCorrection` below. Hosted runtimes use this
 * pure boundary and route the returned item through the central memory engine;
 * they must never instantiate the filesystem ledger in a horizontally scaled
 * process merely to reuse the gate.
 */
export function buildHumanCorrectionItem(input: HumanCorrectionInput): HumanCorrectionResult {
  const now = input.now ?? new Date();
  const safeSessionKey = redactText(input.sessionKey.slice(0, 200));
  const bounded = (value: string, max: number): string =>
    // Keep one character beyond the accepted bound so the gate still rejects
    // oversize corrections rather than silently changing their meaning.
    value.trim().slice(0, max + 1);
  const statement = bounded(input.statement, MAX_STATEMENT_CHARS);
  const falsifier = bounded(input.falsifier, MAX_FALSIFIER_CHARS);
  const expectation = bounded(input.expectation, MAX_EXPECTATION_CHARS);
  if (
    redactText(statement) !== statement
    || redactText(falsifier) !== falsifier
    || redactText(expectation) !== expectation
  ) {
    return {
      admitted: false,
      rule: 'secret-bearing',
      reason: 'Remove credentials or sensitive infrastructure details and rephrase the correction.',
    };
  }
  const candidate: LearningCandidate = {
    form: 'lesson',
    statement,
    falsifier,
    expectation,
    evidence: [`corrected in session ${safeSessionKey}`],
    origin: 'human-correction',
    occurrences: 1,
    sawUntrustedContent: false,
    corroboratedByTrustedAction: true,
    requestedTier: 'instruction',
  };
  const verdict = reviewLearningCandidate(candidate);
  if (!verdict.admitted) {
    return { admitted: false, rule: verdict.rule, reason: verdict.reason };
  }
  const at = now.toISOString();
  const item: LearnedItem = {
    id: input.itemId?.trim() || newLearnedItemId(),
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
      sessionKey: safeSessionKey,
      capturedAt: at,
      checkpoint: 'session-end',
      evidence: [...candidate.evidence],
      corroboratedByTrustedAction: true,
      sawUntrustedContent: false,
      gateReasoning: verdict.reasoning,
      ...(input.project ? { project: input.project } : {}),
    },
    status: 'active',
    createdAt: at,
    updatedAt: at,
  };
  return { admitted: true, item };
}

export function recordHumanCorrection(input: HumanCorrectionInput): HumanCorrectionResult {
  const result = buildHumanCorrectionItem(input);
  if (!result.admitted) {
    const now = input.now ?? new Date();
    logLearningRejection(
      input.tenant,
      `[${result.rule}] correction refused — ${result.reason}`,
      now,
    );
    return result;
  }
  return {
    admitted: true,
    item: storeLearnedItem(input.tenant, result.item, input.now ?? new Date()).item,
  };
}
