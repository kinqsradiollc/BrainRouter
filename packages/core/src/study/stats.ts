/**
 * ADR-049 S1 — pure per-deck stats: the honest numbers the deck list and review
 * summary show (D6 — measurements, not points). Browser-safe.
 */
import type { StudyDeck, StudyDeckStats, StudyProgress } from "@kinqs/brainrouter-types";
import { isoDay } from "./srs.js";

/** Count new / learning / review / due cards and the graduated fraction. */
export function deckStats(deck: StudyDeck, progress: StudyProgress, now: Date): StudyDeckStats {
  const today = isoDay(now);
  let newCards = 0;
  let learningCards = 0;
  let reviewCards = 0;
  let dueCards = 0;
  let scheduled = 0;
  for (const card of deck.cards) {
    const s = progress.schedules[card.id];
    if (!s) { newCards++; continue; }
    scheduled++;
    if (s.state === "learning") learningCards++;
    else reviewCards++;
    if (s.dueOn <= today) dueCards++;
  }
  return {
    deckId: deck.id,
    totalCards: deck.cards.length,
    newCards,
    learningCards,
    reviewCards,
    dueCards,
    // Graduated-to-review fraction of scheduled cards — a card in `learning`
    // lapsed recently. 0 when nothing has been reviewed yet.
    retention: scheduled === 0 ? 0 : Math.round((reviewCards / scheduled) * 100) / 100,
  };
}

/** The current daily review streak (consecutive days ending today with ≥1 review). */
export function reviewStreak(progress: StudyProgress, now: Date): number {
  let streak = 0;
  const cursor = new Date(now);
  // Count back day by day while that day has a review; today with none breaks it.
  for (;;) {
    const day = isoDay(cursor);
    if ((progress.reviewsByDay[day] ?? 0) > 0) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    } else break;
  }
  return streak;
}
