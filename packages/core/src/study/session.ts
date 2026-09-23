/**
 * ADR-049 S1/S4 — the pure review-session builder. Given a deck and a user's
 * progress, produce the ordered queue for a sitting: the due scheduled cards
 * (most-overdue first) followed by up to `newLimit` never-seen cards, each with
 * its multiple-choice option set already computed. No I/O, no model — the host
 * calls this once and hands the queue to the renderer.
 */
import type {
  StudyCard, StudyCardSchedule, StudyDeck, StudyProgress,
} from "@kinqs/brainrouter-types";
import { dueCardIds, newSchedule } from "./srs.js";
import { multipleChoiceOptions } from "./distractors.js";

export interface StudyReviewItem {
  card: StudyCard;
  /** The card's current schedule, or a fresh `new` one. */
  schedule: StudyCardSchedule;
  isNew: boolean;
  /** Deterministic multiple-choice options + the correct index. */
  mc: { options: string[]; correctIndex: number };
}

export interface BuildSessionOptions {
  now: Date;
  /** Max never-seen cards to introduce this sitting. Default 20. */
  newLimit?: number;
  /** Options per multiple-choice question (incl. the answer). Default 4. */
  mcCount?: number;
}

/** Build the review queue for one deck + one user. Pure + deterministic. */
export function buildReviewSession(
  deck: StudyDeck,
  progress: StudyProgress,
  opts: BuildSessionOptions,
): StudyReviewItem[] {
  const byId = new Map(deck.cards.map((c) => [c.id, c]));
  const mcCount = opts.mcCount ?? 4;
  const newLimit = opts.newLimit ?? 20;
  const items: StudyReviewItem[] = [];

  for (const id of dueCardIds(progress.schedules, opts.now)) {
    const card = byId.get(id);
    if (!card) continue; // schedule for a deleted card — skip
    items.push({
      card,
      schedule: progress.schedules[id]!,
      isNew: false,
      mc: multipleChoiceOptions(card, deck.cards, mcCount),
    });
  }
  let introduced = 0;
  for (const card of deck.cards) {
    if (introduced >= newLimit) break;
    if (progress.schedules[card.id]) continue;
    introduced++;
    items.push({
      card,
      schedule: newSchedule(card.id, opts.now),
      isNew: true,
      mc: multipleChoiceOptions(card, deck.cards, mcCount),
    });
  }
  return items;
}
