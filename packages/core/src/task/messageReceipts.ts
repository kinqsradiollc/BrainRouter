/**
 * ADR-028 B1 — message receipts, without claiming what we cannot prove.
 *
 * The constraint that shapes everything here: **"read" is not observable for a
 * model.** We can prove a message entered the turn's context, because we built
 * that context. We cannot prove the model attended to it — attention is not
 * instrumentable from outside, and a token being present in a prompt is not
 * evidence it influenced the output.
 *
 * So there is no `✓✓ Read`. A read receipt would be a claim we cannot
 * substantiate, and a false receipt is worse than no receipt at all, because
 * the receipt is precisely the thing that stops you repeating yourself.
 *
 *   queued        Accepted, not yet in a turn        — ours, the queue holds it
 *   delivered     Entered a model's context          — ours, we built it
 *   acknowledged  Demonstrably consumed              — EVIDENCE REQUIRED
 *   dropped       Never reached a model, never will  — ours, the turn ended
 *
 * This is a delivery lifecycle. Whether the agent then *acted* on a steer is a
 * different question, answered by the steering reconciliation store; the two
 * meet at `acknowledged`, where a reconcile carrying the message id counts as
 * evidence.
 */

export type ReceiptState = 'queued' | 'delivered' | 'acknowledged' | 'dropped';

/** How we came to believe a message was actually consumed. */
export type AcknowledgementEvidence =
  /** The model referred to the message explicitly. */
  | { kind: 'explicit_ack'; detail: string }
  /** A plan revision cites it as the reason for the change. */
  | { kind: 'plan_revision'; revision: number }
  /** A `reconcile_steer` call carried this message's id. */
  | { kind: 'steer_reconciled'; receiptId: string };

export type DropReason =
  | 'turn_ended'
  | 'session_closed'
  | 'error'
  | 'superseded'
  | 'expired';

export interface MessageReceipt {
  messageId: string;
  state: ReceiptState;
  queuedAt: string;
  deliveredAt?: string;
  acknowledgedAt?: string;
  droppedAt?: string;
  evidence?: AcknowledgementEvidence;
  dropReason?: DropReason;
  /** Which turn carried it into context. */
  turnId?: string;
}

export function queueMessage(messageId: string, now: string): MessageReceipt {
  return { messageId, state: 'queued', queuedAt: now };
}

/**
 * The message entered a turn's context.
 *
 * This is the strongest thing we can assert on our own, and it is where the UI
 * stops unless evidence arrives. Deliberately NOT called "read".
 */
export function markDelivered(
  receipt: MessageReceipt,
  turnId: string,
  now: string,
): MessageReceipt {
  if (receipt.state !== 'queued') return receipt;
  return { ...receipt, state: 'delivered', deliveredAt: now, turnId };
}

/**
 * Something demonstrated the message was consumed.
 *
 * Only reachable with evidence, which is the entire point: presence in the
 * context window is `delivered`, and no amount of it adds up to
 * `acknowledged`. A caller that wants to promote a message without evidence
 * has to change this signature, which is the intended amount of friction.
 */
export function markAcknowledged(
  receipt: MessageReceipt,
  evidence: AcknowledgementEvidence,
  now: string,
): MessageReceipt {
  if (receipt.state === 'dropped' || receipt.state === 'acknowledged') return receipt;
  return { ...receipt, state: 'acknowledged', acknowledgedAt: now, evidence };
}

/**
 * The message never reached a model and never will.
 *
 * A queued message when the turn ends is the most harmful case in the whole
 * lifecycle, precisely because you have every reason to believe it landed: you
 * typed it, it appeared in the composer, nothing said otherwise. It has to be
 * loud.
 */
export function markDropped(
  receipt: MessageReceipt,
  reason: DropReason,
  now: string,
): MessageReceipt {
  if (receipt.state === 'acknowledged') return receipt;
  return { ...receipt, state: 'dropped', droppedAt: now, dropReason: reason };
}

/** What the UI shows. Never "read" — see the module note. */
export function describeReceipt(receipt: MessageReceipt): string {
  switch (receipt.state) {
    case 'queued':
      return 'Queued — waiting for the next turn.';
    case 'delivered':
      // The careful wording. It says what we know and stops there.
      return 'Delivered to the agent’s context.';
    case 'acknowledged':
      return `Acknowledged — ${describeEvidence(receipt.evidence!)}.`;
    case 'dropped':
      return describeDrop(receipt.dropReason ?? 'error');
  }
}

function describeEvidence(evidence: AcknowledgementEvidence): string {
  switch (evidence.kind) {
    case 'explicit_ack':
      return 'the agent referred to it';
    case 'plan_revision':
      return `the plan was revised (r${evidence.revision}) citing it`;
    case 'steer_reconciled':
      return 'it was reconciled into the work contract';
  }
}

function describeDrop(reason: DropReason): string {
  switch (reason) {
    case 'turn_ended':
      return 'Not delivered — the turn ended before this was picked up. It was not seen.';
    case 'session_closed':
      return 'Not delivered — the session closed. It was not seen.';
    case 'superseded':
      return 'Not delivered — a later message replaced this one.';
    case 'expired':
      return 'Not delivered — this sat in the queue too long to still be relevant.';
    case 'error':
      return 'Not delivered — an error prevented it reaching the agent. It was not seen.';
  }
}

/**
 * Does this drop need to be put in front of the human, with a resend?
 *
 * Superseded and expired do not: the person moved on, and telling them about a
 * message they themselves replaced is noise. The rest do — those are cases
 * where someone said something and reasonably believes it landed.
 */
export function needsResendPrompt(receipt: MessageReceipt): boolean {
  if (receipt.state !== 'dropped') return false;
  return receipt.dropReason !== 'superseded' && receipt.dropReason !== 'expired';
}

/**
 * Sweep the queue when a turn ends.
 *
 * Anything still `queued` never made it. Silently discarding these is the
 * failure B1 exists to remove: the message is gone, the sender believes it
 * arrived, and the divergence only shows up much later as the agent doing the
 * thing they thought they had corrected.
 */
export function reconcileQueueOnTurnEnd(
  receipts: readonly MessageReceipt[],
  now: string,
): { updated: MessageReceipt[]; needsAttention: MessageReceipt[] } {
  const updated = receipts.map((r) =>
    r.state === 'queued' ? markDropped(r, 'turn_ended', now) : r,
  );
  return { updated, needsAttention: updated.filter(needsResendPrompt) };
}
