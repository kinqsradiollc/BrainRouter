/**
 * ADR-049 (documents) — a one-shot hand-off from another surface into Study.
 *
 * The Document reader can say "Generate flashcards from this document" while the
 * user is in Code mode, where StudyView is not mounted. It stashes the intent
 * here and dispatches `br-study-generate`; App switches to Study, and StudyView
 * takes the intent on mount (once, then it is cleared). A tiny renderer-side
 * singleton — no host round-trip, no prop threading through MainContent.
 */
export interface StudyGenerateIntent {
  kind: 'document';
  ref: string;
  /** A human name for the source, used to title the new deck. */
  name?: string;
}

/** The window event App listens for to switch into Study mode. */
export const STUDY_GENERATE_EVENT = 'br-study-generate';

let pending: StudyGenerateIntent | null = null;

/** Queue a generate intent and ask App (via the event) to open Study. */
export function requestStudyGenerate(intent: StudyGenerateIntent): void {
  pending = intent;
  try { window.dispatchEvent(new CustomEvent(STUDY_GENERATE_EVENT)); } catch { /* no window in tests */ }
}

/** Take the queued intent (clearing it), or null when there is none. */
export function takeStudyGenerateIntent(): StudyGenerateIntent | null {
  const intent = pending;
  pending = null;
  return intent;
}
