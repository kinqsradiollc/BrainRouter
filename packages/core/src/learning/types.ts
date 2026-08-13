/**
 * ADR-032 — the shapes a learned change to behaviour has to carry.
 *
 * §2 states the whole principle in one sentence: a change to how the agent
 * behaves must be **reversible, attributable, and falsifiable**. Every field
 * here exists to serve one of those three, and nothing is optional that one of
 * them needs:
 *
 * - reversible — `id` plus the audit log in `store.ts` make undoing a
 *   first-class operation rather than a database edit (D4);
 * - attributable — `provenance` names the session, the checkpoint that fired,
 *   and the trajectory evidence the candidate was drawn from (D4);
 * - falsifiable — `falsifier` names what would show the item wrong, and
 *   `outcome` records whether the thing it predicted actually happened, which
 *   is what lets D6 retire it later.
 *
 * The one thing this module deliberately does NOT model is a free-form
 * "supplemental prompt note". D1 refuses that: provenance decides weight, and
 * there are exactly two tiers, both visible, neither touching the base prompt.
 */

/**
 * D1 — the two tiers, and the only two.
 *
 * `evidence` is a hypothesis a model drew from a trajectory. It informs.
 * `instruction` is something a person said in session. It commands, because
 * demoting a human correction to a hint is how the same correction gets given
 * four times.
 */
export type LearnedTier = 'evidence' | 'instruction';

/**
 * D1/D7 — where an item came from, which is what decides its tier.
 *
 * The instruction tier is reachable ONLY from `human-correction`, and a
 * document cannot mint one however imperative its phrasing. That rule lives in
 * `gate.ts`; this type is what makes it expressible.
 */
export type LearnedOrigin = 'model-inferred' | 'human-correction';

/**
 * What KIND of thing was learned.
 *
 * `procedure` is §1's first gap — a repeated sequence that should RUN rather
 * than be re-read and re-interpreted every turn, so it promotes to a learned
 * skill (D3).
 *
 * There is deliberately no `delegation` form. §1 listed "a repeated sub-task
 * shape never becomes a reusable role" as a gap and D3 has since WITHDRAWN it:
 * a learned role would need a constrained child-authority port that proves and
 * re-applies a narrower ceiling on every spawn, and no such port is being
 * built. Carrying the form anyway meant the gate refused it unconditionally —
 * a branch nobody could ever reach, and a union member that promised a
 * capability the product does not have.
 */
export type LearnedForm = 'lesson' | 'procedure';

/**
 * D6's ladder, and the reason it is a ladder rather than a boolean.
 *
 * An item climbs (instruction is above evidence) and is demoted back down the
 * same way it came: an instruction that stops paying off becomes evidence
 * before it becomes nothing. `reverted` is the human's undo (D4) and is
 * distinct from `retired` on purpose — "the system stopped believing this" and
 * "a person took it back" are different facts and the audit log should not
 * conflate them.
 */
export type LearnedStatus = 'active' | 'demoted' | 'retired' | 'reverted';

/** D5 — the three moments a checkpoint may fire at. */
export type LearningCheckpointReason = 'turn-end' | 'compaction' | 'session-end';

/**
 * D8 — the partition, which is the same one memory, notes and the planner use.
 *
 * `orgId` is nullable because a personal install genuinely has no org; that is
 * the one-store-per-install case, not a value to be filled in later. What is
 * NOT permitted is reading across a partition, and `store.ts` never takes two.
 */
export interface LearnedTenant {
  readonly orgId?: string | null;
  readonly userId: string;
}

/** D4 — where an item came from, in enough detail to argue with it later. */
export interface LearnedProvenance {
  readonly sessionKey: string;
  readonly capturedAt: string;
  readonly checkpoint: LearningCheckpointReason;
  /**
   * The trajectory lines that support it. D2 rejects a candidate with none —
   * an inference with no evidence is an unsupported hypothesis, and those are
   * exactly what turns the store into noise.
   */
  readonly evidence: readonly string[];
  /**
   * D7 — did something the agent or the person DID corroborate this?
   *
   * A lesson may not derive solely from untrusted content, so this flag is the
   * gate's second input, not decoration. An injection that is merely read
   * affects one turn; one that is learned arrives already trusted in every
   * future session.
   */
  readonly corroboratedByTrustedAction: boolean;
  /**
   * Successful, later actions that the reflector identified as relevant to
   * this particular candidate.  The ids are minted by the runtime and
   * validated before admission; model supplied ids that were not observed are
   * discarded.
   */
  readonly corroboratingActionIds?: readonly string[];
  /** D7 — whether attacker-influenced content was in the window at all. */
  readonly sawUntrustedContent: boolean;
  /** D2 — the reviewer's stated reasoning, so "why is this here" is answerable. */
  readonly gateReasoning: string;
  /**
   * WHERE it was learned — a stable id for the workspace the session ran in.
   *
   * The partition key is `(orgId, userId)` and nothing else, so without this a
   * lesson learned in one repository is delivered, as a system message, in every
   * other repository that person opens. "Prefer `rg` over `grep`" survives that
   * move; "run the migration before the seed" does not — it becomes confident,
   * specific, wrong advice about a codebase it was never about, and its
   * falsifier will never be observed there because nobody runs that migration.
   *
   * Optional because rows written before this existed have no answer, and
   * inventing one would be worse than admitting it: an item with no project is
   * treated as unscoped rather than as belonging to the current one.
   */
  readonly project?: string;
}

/**
 * D6 — what should improve, and whether it did.
 *
 * The reference implementation records an expectation and never checks it;
 * ours does not even record one. Both halves are here because either alone is
 * useless: an expectation nothing measures is a comment, and a retrieval count
 * with nothing predicted cannot tell "used and worked" from "used and wrong".
 */
export interface LearnedOutcome {
  /** What should get better if this item is right. */
  readonly expectation: string;
  /** How many times the item was actually placed in front of the model. */
  retrievals: number;
  /** Sessions where the expectation visibly held. */
  confirmations: number;
  /** Sessions where the falsifier was observed. One is enough to retire it. */
  contradictions: number;
  lastRetrievedAt?: string;
  lastConfirmedAt?: string;
  lastContradictedAt?: string;
}

/**
 * One action the runtime watched succeed, recorded so a procedure can replay
 * the thing that worked rather than a description of it.
 *
 * There is no `arguments` field and that is deliberate. Replaying arguments
 * captured in one session into another would be wrong far more often than
 * right — paths, ids and revisions do not survive the move — and storing them
 * would put whatever those calls touched into a record that outlives the
 * session. What is durable is WHICH tool did the work, in WHAT order.
 */
export interface LearnedProcedureStep {
  /** The runtime's id for the observed action. Ties a step to its evidence. */
  readonly actionId: string;
  readonly toolName: string;
  /** The runtime's own one-line record of the call. Never model prose. */
  readonly summary?: string;
}

/** One learned change to how the agent behaves. */
export interface LearnedItem {
  readonly id: string;
  readonly tenant: LearnedTenant;
  tier: LearnedTier;
  readonly origin: LearnedOrigin;
  readonly form: LearnedForm;
  /** The learned claim itself, as a reusable rule. */
  readonly statement: string;
  /** D2's price of admission — what would show this wrong. */
  readonly falsifier: string;
  outcome: LearnedOutcome;
  readonly provenance: LearnedProvenance;
  status: LearnedStatus;
  /** When the current lifecycle status began. Used to require fresh evidence
   * before a demoted item can be restored. */
  statusChangedAt?: string;
  /** Why it is in its current status. Set on every transition, never guessed. */
  statusReason?: string;
  createdAt: string;
  updatedAt: string;
  /** D3 — the learned skill this procedure was promoted to, when it was one. */
  skillId?: string;
  /** Tool ceiling carried by a promoted learned procedure. This can only
   * subtract from the agent's existing authority. */
  allowedTools?: readonly string[];
  /**
   * D3 — the exact successful actions this procedure may replay.
   *
   * A procedure's `steps` are the MODEL's retelling: prose it re-reads and
   * re-interprets every turn, which is §1's "nothing it learns ever becomes
   * something that runs". This is the other half, and it is deliberately not
   * the same kind of thing. Every entry is a call the RUNTIME watched succeed;
   * the model's only influence is citing which observed action ids belong to
   * the procedure, and a citation matching no observed action is dropped
   * rather than trusted. So the model can narrow this list and can never
   * extend it, reorder it, or invent an entry in it.
   */
  procedureLedger?: readonly LearnedProcedureStep[];
  /**
   * The memory-engine record this fact was ALSO written to.
   *
   * Learned state is not a parallel memory system: the durable fact routes
   * through the memory engine like every other durable fact, and this store
   * holds the lifecycle memory does not model — the tier, the falsifier, the
   * expectation, and the counters that let D6 retire it.
   */
  memoryRecordId?: string;
  /** The durable-memory half of the lifecycle. A pending state is deliberately
   * visible to API/dashboard callers and is retried by later checkpoints. */
  memoryLifecycle?: LearnedMemoryLifecycle;
}

export type LearnedMemoryStatus =
  | 'record-pending'
  | 'active'
  | 'archive-pending'
  | 'archived';

export interface LearnedMemoryLifecycle {
  status: LearnedMemoryStatus;
  updatedAt: string;
  attempts: number;
  lastError?: string;
}

/** One line of the audit trail. D4: a system that can delete needs one. */
export interface LearningLogEntry {
  readonly at: string;
  readonly op:
    | 'admitted'
    | 'reinforced'
    | 'rejected'
    | 'reverted'
    | 'retrieved'
    | 'confirmed'
    | 'contradicted'
    | 'demoted'
    | 'retired'
    | 'skill-written'
    | 'skill-removed'
    | 'memory-linked'
    | 'memory-record-failed'
    | 'memory-archive-pending'
    | 'memory-archived'
    | 'memory-restored'
    | 'memory-archive-failed';
  readonly itemId?: string;
  readonly detail: string;
}

export interface LearningState {
  readonly schemaVersion: 1;
  readonly tenant: LearnedTenant;
  items: Record<string, LearnedItem>;
  log: LearningLogEntry[];
  /**
   * D6's durable logical-session ledger, keyed by a tenant-bound hash of the
   * runtime-owned session key.  Delivery membership is separate from the
   * retrieval counter: retrievals count prompt placements, while outcomes
   * count distinct sessions in which an expectation or falsifier was observed.
   */
  sessions?: Record<string, LearningSessionObservationState>;
  /** Durable fairness state for bounded central reconciliation. Dirty entries
   * rotate instead of letting the first failing rows monopolize every pass;
   * the cursor separately polls linked rows for hosted human reverts. */
  reconciliation?: LearningReconciliationState;
}

export interface LearningSessionObservationState {
  /** Exact item ids that reached the model at least once in this session. */
  deliveredItemIds: string[];
  /** At most one semantic outcome per item and logical session. */
  outcomes: Record<string, LearningObservedSessionOutcome>;
}

export interface LearningObservedSessionOutcome {
  outcome: 'confirmed' | 'contradicted';
  observedAt: string;
  /** Delivery state for the hidden host event channel. Older observations are
   * normalized as already synced so an upgrade cannot double-count aggregates
   * that may have reached central storage before event identities existed. */
  centralSync?: LearningOutcomeCentralSyncState;
}

export interface LearningOutcomeCentralSyncState {
  status: 'pending' | 'synced';
  outcome: 'confirmed' | 'contradicted';
  detail: string;
  updatedAt: string;
}

export interface LearningReconciliationState {
  lifecycleCursor?: string;
  dirtyQueue: string[];
  dirtyRevisions: Record<string, number>;
  nextRevision: number;
  /** Pending semantic outcome deliveries, rotated fairly and removed only
   * after the normalized central observation succeeds. */
  outcomeQueue?: string[];
}
