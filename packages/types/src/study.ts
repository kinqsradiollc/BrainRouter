/**
 * ADR-049 — Study mode data model.
 *
 * The dependency-free contract shared by the core scheduler/store and the desktop
 * Study view. Two artifacts, deliberately split (ADR-049 D5):
 *
 *  - {@link StudyDeck} — content only (cards, tags, provenance). Lives in
 *    `<workspaceRoot>/.brainrouter/study/decks/*.json` and is designed to COMMIT
 *    cleanly, so sharing a deck is `git commit`.
 *  - {@link StudyProgress} — one person's scheduling state (ease, intervals,
 *    streak), keyed per user in `progress/<user>.json` and meant to be
 *    git-ignored: your retention is yours, and two teammates reviewing the same
 *    committed deck never conflict.
 */

export const STUDY_SCHEMA_VERSION = 1;

/** Where a generated card came from — a click-through receipt (ADR-049 D4). */
export type StudyProvenance =
  | { kind: "meeting"; id: string }
  | { kind: "doc"; path: string }
  | { kind: "memory"; id: string }
  | { kind: "atlas"; nodeId: string; filePath?: string }
  | { kind: "adr"; number: string }
  | { kind: "manual" };

/** How a card is quizzed. `cloze` fronts carry `{{...}}` spans to blank out. */
export type StudyCardFormat = "basic" | "cloze";

/** One flashcard. Content only — scheduling lives in the per-user progress file. */
export interface StudyCard {
  /** Stable id, unique within the deck (never reused). */
  id: string;
  /** Front / prompt. For `cloze`, the source text with `{{answer}}` spans. */
  front: string;
  /** Back / answer. For `cloze`, the fully-revealed text (may be empty). */
  back: string;
  format: StudyCardFormat;
  tags: string[];
  /** Present on generated cards; absent (or `manual`) on hand-authored ones. */
  provenance?: StudyProvenance;
  createdAt: string;
}

/** A committable set of cards. */
export interface StudyDeck {
  schemaVersion: number;
  /** Stable id; also the deck file's basename. */
  id: string;
  name: string;
  description?: string;
  tags: string[];
  cards: StudyCard[];
  createdAt: string;
  updatedAt: string;
}

/** The four self-graded recall outcomes (keyboard 1–4 in the review UI). */
export type StudyGrade = "again" | "hard" | "good" | "easy";

/** A card's learning state in the SM-2 family. */
export type StudyCardState = "new" | "learning" | "review";

/** Per-card scheduling — in the per-user progress file, NOT the deck. */
export interface StudyCardSchedule {
  cardId: string;
  state: StudyCardState;
  /** SM-2 ease factor (>= 1.3). */
  ease: number;
  /** Current interval in whole days. */
  intervalDays: number;
  /** Consecutive successful reviews since the last lapse. */
  repetitions: number;
  /** Total lapses (an `again` on a review card). */
  lapses: number;
  /** ISO date (`YYYY-MM-DD`, day granularity) the card is next due. */
  dueOn: string;
  /** ISO timestamp of the most recent review. */
  lastReviewedAt?: string;
  /** Total times this card has been graded. */
  reviewCount: number;
}

/** One person's scheduling state for every card across a workspace's decks. */
export interface StudyProgress {
  schemaVersion: number;
  /** The user this progress belongs to (git email / account id / `local`). */
  user: string;
  /** cardId → schedule. A card with no entry is `new`. */
  schedules: Record<string, StudyCardSchedule>;
  /** ISO date (`YYYY-MM-DD`) → reviews graded that day, for the streak. */
  reviewsByDay: Record<string, number>;
  updatedAt: string;
}

/** A source a deck can be generated from — a review tray proposal before accept. */
export interface StudyCardProposal {
  front: string;
  back: string;
  format: StudyCardFormat;
  tags: string[];
  provenance?: StudyProvenance;
}

/** Compact per-deck stats for the deck list + review summary. */
export interface StudyDeckStats {
  deckId: string;
  totalCards: number;
  newCards: number;
  learningCards: number;
  reviewCards: number;
  dueCards: number;
  /** Fraction of scheduled cards whose last grade was not `again`, 0..1. */
  retention: number;
}

/** Structural guard for a deck read off disk (a malformed file contributes nothing). */
export function isStudyDeck(value: unknown): value is StudyDeck {
  if (!value || typeof value !== "object") return false;
  const d = value as Record<string, unknown>;
  return (
    typeof d.id === "string" &&
    typeof d.name === "string" &&
    Array.isArray(d.cards) &&
    Array.isArray(d.tags) &&
    typeof d.schemaVersion === "number"
  );
}
