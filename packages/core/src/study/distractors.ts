/**
 * ADR-049 S1 / D3 — deterministic multiple-choice distractor sampling. No model:
 * distractors are drawn from the deck's OTHER cards' answers, seeded by the card
 * id so the same card always offers the same options (a reordering wouldn't be a
 * new question). Falls short gracefully — a deck with too few distinct answers
 * simply offers fewer options.
 */
import type { StudyCard } from "@kinqs/brainrouter-types";

/** A small stable string hash (FNV-1a) — for deterministic seeded ordering. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Up to `count` distractor answers for `correct`, drawn from `siblings`
 * (the deck's other cards), each distinct from the correct answer and from each
 * other, ordered deterministically by `hash(cardId + answer)`.
 */
export function pickDistractors(
  correct: StudyCard,
  siblings: readonly StudyCard[],
  count: number,
): string[] {
  const want = Math.max(0, Math.floor(count));
  if (want === 0) return [];
  const seen = new Set<string>([correct.back.trim()]);
  const candidates: string[] = [];
  for (const card of siblings) {
    if (card.id === correct.id) continue;
    const answer = card.back.trim();
    if (!answer || seen.has(answer)) continue;
    seen.add(answer);
    candidates.push(answer);
  }
  candidates.sort((a, b) => hash(correct.id + a) - hash(correct.id + b));
  return candidates.slice(0, want);
}

/**
 * The full option set for a multiple-choice question: the correct answer plus
 * its distractors, shuffled into a stable position seeded by the card id (so the
 * answer is not always first). Returns the options and the correct index.
 */
export function multipleChoiceOptions(
  correct: StudyCard,
  siblings: readonly StudyCard[],
  count: number,
): { options: string[]; correctIndex: number } {
  const distractors = pickDistractors(correct, siblings, Math.max(0, count - 1));
  const answer = correct.back.trim();
  const all = [answer, ...distractors];
  // Stable seeded order — same card, same layout.
  all.sort((a, b) => hash(correct.id + ":" + a) - hash(correct.id + ":" + b));
  return { options: all, correctIndex: all.indexOf(answer) };
}
