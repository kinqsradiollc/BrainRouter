/**
 * ADR-027 D1 (P9-2) — cognitive-debt mechanisms.
 *
 * The novel work in this ADR, and the part with the least prior art. It exists
 * because an agent that is right most of the time produces a human who stops
 * checking — and the evidence in §1 is that consistency breeds complacency,
 * that self-assessed oversight is uncorrelated with actual oversight, and that
 * notification acceptance decays roughly 30% per additional item.
 *
 * Two mechanisms here, both from D1, both counter-intuitive enough to be worth
 * stating plainly:
 *
 *   - DECISION GRANULARITY, NOT ACTION GRANULARITY. Batch related actions into
 *     one coherent decision. Ten decisions a session, not a hundred prompts.
 *     Asking more often does NOT produce more oversight; past a threshold it
 *     produces less, because each prompt is worth less attention than the last.
 *
 *   - GATE ON IRREVERSIBILITY, NOT ON EVENT TYPE. A permission model that
 *     prompts for shell commands but not for equivalent state changes made
 *     through an editor is not a safety model, it is a superstition about
 *     mechanism. What matters is whether the change can be taken back.
 *
 * D1 also rejects, explicitly: a "what you have not reviewed" feed, per-action
 * dialogs as the primary surface, and explanation panels presented as an
 * oversight guarantee. None are implemented here, and that is deliberate.
 */

/** A single thing the agent wants to do. */
export interface ProposedAction {
  id: string;
  description: string;
  /** Reversible by another action, or not. THE gating input. */
  reversible: boolean;
  /** Leaves the machine — network, message, publish. Never speculative. */
  outward?: boolean;
  /**
   * Coherence key. Actions sharing one belong to the same unit of work and are
   * presented together. Usually a subsystem, file, or feature.
   */
  unit?: string;
}

export interface Decision {
  /** Actions batched into one thing to decide about. */
  actions: readonly ProposedAction[];
  /** True when anything inside is irreversible or outward-facing. */
  consequential: boolean;
  /** Coherence key, when the batch shares one. */
  unit?: string;
}

export interface GatingOptions {
  /**
   * Decisions to aim for across a session. D1 says roughly ten, not a hundred:
   * past a threshold each additional prompt is worth less attention than the
   * last, so asking more often produces LESS oversight.
   */
  targetDecisions?: number;
}

/**
 * Group actions into decisions.
 *
 * Reversible work in the same unit batches freely — that is what makes ten
 * decisions possible rather than a hundred. Consequential actions do NOT batch
 * with reversible ones, because burying an irreversible step inside a batch of
 * safe edits is how a human approves it without seeing it, which is worse than
 * not asking at all: it manufactures a record of consent that did not happen.
 */
export function groupIntoDecisions(
  actions: readonly ProposedAction[],
  options: GatingOptions = {},
): readonly Decision[] {
  const target = Math.max(1, options.targetDecisions ?? 10);
  const decisions: Decision[] = [];

  // Consequential actions are each their own decision, in order.
  // Reversible actions batch by unit.
  const reversibleByUnit = new Map<string, ProposedAction[]>();
  const consequential: ProposedAction[] = [];

  for (const action of actions) {
    if (!action.reversible || action.outward === true) { consequential.push(action); continue; }
    const key = action.unit ?? '';
    const bucket = reversibleByUnit.get(key);
    if (bucket) bucket.push(action);
    else reversibleByUnit.set(key, [action]);
  }

  for (const [unit, batch] of reversibleByUnit) {
    decisions.push({ actions: batch, consequential: false, ...(unit ? { unit } : {}) });
  }
  for (const action of consequential) {
    decisions.push({
      actions: [action],
      consequential: true,
      ...(action.unit ? { unit: action.unit } : {}),
    });
  }

  // If reversible batching still exceeds the target, merge the smallest units
  // together. Consequential decisions are NEVER merged away to hit a number —
  // the budget is a guide for routine work, not a licence to hide risk.
  const reversible = decisions.filter((d) => !d.consequential);
  const risky = decisions.filter((d) => d.consequential);
  while (reversible.length > 1 && reversible.length + risky.length > target) {
    reversible.sort((a, b) => a.actions.length - b.actions.length);
    const first = reversible.shift()!;
    const second = reversible.shift()!;
    reversible.push({ actions: [...first.actions, ...second.actions], consequential: false });
  }
  return [...reversible, ...risky];
}

/**
 * Confirmation presentations, cycled so consecutive high-stakes prompts differ.
 *
 * D1: "Identical dialogs are optimized for habituation; varied ones measurably
 * resist it." A user who has clicked the same button forty times is not reading
 * the forty-first — the muscle memory fires before the sentence is parsed.
 */
export const CONFIRMATION_STYLES = [
  /** Plain statement of consequence, confirm button. */
  'statement',
  /** Consequence phrased as a question the user answers. */
  'question',
  /** The specific irreversible item must be named back. */
  'restate',
  /** An explicit checklist of what will and will not be undoable. */
  'checklist',
] as const;

export type ConfirmationStyle = (typeof CONFIRMATION_STYLES)[number];

/**
 * Pick a presentation that differs from the previous one.
 *
 * Deterministic on `seenCount` rather than random: a session must be
 * reproducible for support and testing, and randomness would make "which dialog
 * did they see?" unanswerable after the fact.
 */
export function confirmationStyleFor(seenCount: number): ConfirmationStyle {
  const index = Math.abs(Math.floor(seenCount)) % CONFIRMATION_STYLES.length;
  return CONFIRMATION_STYLES[index]!;
}

export interface OversightBalance {
  decisionsTaken: number;
  /** Consequential decisions the human actually confirmed. */
  confirmed: number;
  /** Actions carried out inside batched decisions without individual review. */
  batchedActions: number;
}

/**
 * Report oversight as a BALANCE, never as a nag.
 *
 * D1 is explicit that this must not become a "what you have not reviewed" feed.
 * The phrasing here is descriptive and non-judgemental on purpose: a number the
 * user is scolded with gets dismissed, and a dismissed number measures nothing.
 * Returns null when there is nothing meaningful to say.
 */
export function describeOversight(balance: OversightBalance): string | null {
  if (balance.decisionsTaken === 0) return null;
  const parts = [`${balance.decisionsTaken} decision(s) this session`];
  if (balance.confirmed > 0) parts.push(`${balance.confirmed} irreversible, confirmed by you`);
  if (balance.batchedActions > 0) parts.push(`${balance.batchedActions} reversible change(s) batched`);
  return parts.join(' · ');
}
