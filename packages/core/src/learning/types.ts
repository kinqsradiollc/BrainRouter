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
 * skill (D3). `delegation` is the third gap: a repeated sub-task SHAPE, stored
 * so the next occurrence is handed to a role instead of re-derived.
 */
export type LearnedForm = 'lesson' | 'procedure' | 'delegation';

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
  /** D7 — whether attacker-influenced content was in the window at all. */
  readonly sawUntrustedContent: boolean;
  /** D2 — the reviewer's stated reasoning, so "why is this here" is answerable. */
  readonly gateReasoning: string;
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
  /** Why it is in its current status. Set on every transition, never guessed. */
  statusReason?: string;
  createdAt: string;
  updatedAt: string;
  /** D3 — the learned skill this procedure was promoted to, when it was one. */
  skillId?: string;
  /**
   * The memory-engine record this fact was ALSO written to.
   *
   * Learned state is not a parallel memory system: the durable fact routes
   * through the memory engine like every other durable fact, and this store
   * holds the lifecycle memory does not model — the tier, the falsifier, the
   * expectation, and the counters that let D6 retire it.
   */
  memoryRecordId?: string;
}

/** One line of the audit trail. D4: a system that can delete needs one. */
export interface LearningLogEntry {
  readonly at: string;
  readonly op:
    | 'admitted'
    | 'rejected'
    | 'reverted'
    | 'retrieved'
    | 'confirmed'
    | 'contradicted'
    | 'demoted'
    | 'retired'
    | 'skill-written'
    | 'skill-removed';
  readonly itemId?: string;
  readonly detail: string;
}

export interface LearningState {
  readonly schemaVersion: 1;
  readonly tenant: LearnedTenant;
  items: Record<string, LearnedItem>;
  log: LearningLogEntry[];
}
