/**
 * ADR-032 — an agent that gets better, and cannot get worse.
 *
 * The public surface of the learning subsystem. Read the modules in this order:
 *
 * - `types.ts`       the shapes, and why each field is not optional
 * - `gate.ts`        D2 — nothing is learned by default; falsifiability is the price
 * - `store.ts`       D4/D8 — the tenant partition, the audit trail, and undo
 * - `learnedSkills.ts` D3 — a procedure that RUNS, outside the shipped library
 * - `retirement.ts`  D6 — what makes this a ratchet rather than a drift
 * - `context.ts`     D1 — the two tiers, as the model sees them
 * - `reflection.ts`  D5/D7 — the one LLM call, and the fence around it
 * - `checkpoint.ts`  D5 — the automatic, bounded runner
 */
export type {
  LearnedForm, LearnedItem, LearnedOrigin, LearnedOutcome, LearnedProvenance,
  LearnedMemoryLifecycle, LearnedMemoryStatus, LearnedStatus, LearnedTenant, LearnedTier, LearningCheckpointReason,
  LearningLogEntry, LearningObservedSessionOutcome, LearningOutcomeCentralSyncState, LearningReconciliationState,
  LearningSessionObservationState, LearningState,
} from './types.js';

export {
  MAX_STATEMENT_CHARS, MIN_FALSIFIER_CHARS, MIN_STATEMENT_CHARS,
  reviewLearningCandidate,
  type GateRule, type GateVerdict, type LearningCandidate,
  type LearningHostCapabilities,
} from './gate.js';

export {
  applyLearnedTransition, attachLearnedMemoryRecord, attachLearnedSkill,
  claimLearningOutcomeSyncBatch, claimLearningReconciliationBatch,
  completeLearningOutcomeSync, completeLearningReconciliation, getLearnedItem,
  hasPendingLearningOutcomeSync,
  learnedFingerprint, learningDir,
  learningStateFile, listLearnedItems, listLearnedItemsDeliveredInSession,
  logLearningRejection, newLearnedItemId,
  learningReconciliationSnapshot, noteLearnedOutcome, noteLearnedRetrieval,
  pendingLearningOutcomeSyncForSession, readLearningLog, readLearningState,
  revertLearnedItem, storeLearnedItem, updateLearnedMemoryLifecycle, writeLearningState,
  MAX_ACTIVE_ITEMS, MAX_LOG_ENTRIES,
  type LearningOutcomeSyncEvent, type LearningReconciliationEntry,
} from './store.js';

export {
  isLearnedSkillId, learnedSkillId, learnedSkillsDir, listLearnedSkills,
  LEARNED_SKILL_PREFIX, removeLearnedSkill, resolveLearnedSkill, writeLearnedSkill,
  type LearnedSkillResult, type LearnedSkillSummary,
} from './learnedSkills.js';

export {
  DEFAULT_RETIREMENT_POLICY, evaluateRetirement, sweepRetirement,
  type LearnedTransition, type RetirementPolicy,
} from './retirement.js';

export {
  buildLearnedContext, selectLearnedForTurn,
  LEARNED_CONTEXT_TAG, MAX_EVIDENCE_IN_CONTEXT, MAX_INSTRUCTIONS_IN_CONTEXT,
} from './context.js';

export {
  buildReflectionPrompt, neutralizeDirectives, parseReflectionResponse,
  MAX_CANDIDATES, MAX_TRAJECTORY_CHARS,
  type OutcomeReport, type ParsedCandidate, type ReflectionResult,
} from './reflection.js';

export {
  buildHumanCorrectionItem, recordHumanCorrection, resetLearningBudget, runLearningCheckpoint,
  shouldRunCheckpoint,
  MAX_CHECKPOINTS_PER_SESSION, MIN_CHECKPOINT_INTERVAL_MS, MIN_TRAJECTORY_CHARS,
  type CheckpointAdmission, type HumanCorrectionInput, type HumanCorrectionResult,
  type LearningCheckpointInput, type LearningCheckpointResult,
} from './checkpoint.js';

export {
  applyCentralLearnedRevert, learnedItemMemoryMetadata,
  revertLearnedItemLifecycle, synchronizeLearnedItemLifecycle,
  type LearnedLifecycleResult, type LearnedMemoryLifecyclePort,
} from './lifecycle.js';

export { learningSessionIdentity } from './sessionIdentity.js';
