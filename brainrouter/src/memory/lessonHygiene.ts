/**
 * LESSON-HYGIENE (0.4.5) — deterministic helpers for lesson conflict detection
 * and staleness, with NO I/O or LLM calls so they unit-test in isolation.
 *
 * The store already has the supersede/expire plumbing: `invalidateCognitiveRecord`
 * sets `invalid_at` / `superseded_by` / `status='superseded'`, and recall filters
 * `invalid_at IS NULL`. What was missing is deciding, WITHOUT an LLM, (a) which
 * older lesson a new one likely supersedes and (b) which live lessons have gone
 * stale. These helpers give a conservative, explainable answer — they err toward
 * doing nothing rather than wrongly invalidating a good memory.
 */

// Stance / framing words that state a rule's POLARITY but not its SUBJECT.
// Stripping them lets "always use pnpm" and "never use pnpm" collide on the
// subject ("pnpm") so the newer one can supersede the older. Conservative: we
// only collapse leading stance words, never the subject itself.
const STANCE_PREFIX_RE =
  /^(?:always|never|prefer|avoid|don'?t|do not|do|please|make sure to|remember to|ensure(?: that)?|you should|we should|should|must(?: not)?|use|using)\b/;

/** Lowercase, strip md emphasis/quotes, collapse whitespace, drop trailing punctuation. */
export function normalizeLessonText(text: string): string {
  return (text ?? "")
    .toLowerCase()
    .replace(/[`"'*_]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?,;:]+$/g, "")
    .trim();
}

/**
 * A deterministic "topic key" for a lesson: the normalized text with leading
 * stance words peeled off (repeatedly, to handle "always use …"). Rules about
 * the same subject collide regardless of polarity:
 *   "Always use pnpm"  → "pnpm"
 *   "Never use pnpm"   → "pnpm"   (same key → conflict candidate)
 *   "use npm"          → "npm"    (different key → NOT flagged; left to the
 *                                  explicit `supersedes` arg or the LLM path)
 * The narrowness is intentional — a deterministic detector must not guess at
 * semantic equivalence (npm≠pnpm) and risk clobbering a distinct lesson.
 */
export function deriveConflictKey(text: string): string {
  let key = normalizeLessonText(text);
  for (let i = 0; i < 4; i++) {
    const stripped = key.replace(STANCE_PREFIX_RE, "").trim();
    if (stripped === key) break;
    key = stripped;
  }
  return key;
}

/**
 * Two lessons conflict when they share a non-empty conflict key but differ in
 * their full normalized text (same subject, different/again-stated rule).
 * Identical lessons do NOT conflict — that path is reinforcement, handled by
 * the fingerprint dedup in `recordLesson`.
 */
export function lessonsConflict(aText: string, bText: string): boolean {
  const ka = deriveConflictKey(aText);
  const kb = deriveConflictKey(bText);
  if (!ka || !kb || ka !== kb) return false;
  return normalizeLessonText(aText) !== normalizeLessonText(bText);
}

export interface StalenessThresholds {
  /** Flag only lessons not cited (or, if never cited, not created) within this window. */
  staleAfterDays: number;
  /** Flag only lessons at or below this confidence — trusted lessons are kept. */
  maxConfidence: number;
  /** Flag only weakly-corroborated lessons — repeatedly-confirmed ones are kept. */
  maxCorroborations: number;
}

// Conservative defaults: a lesson must be old AND not-reinforced AND barely
// corroborated before it is even a candidate. A genuinely useful rule keeps
// getting cited (resetting its clock) and corroborated (raising its count +
// confidence), so these gates protect the lessons that matter.
//
// `maxConfidence: 0.8` is the lesson baseline: a fresh lesson is created at
// 0.8 and never decays (halfLifeDays=null), while *reinforcing* it lifts
// confidence to ≥0.85. So "confidence ≤ 0.8" means "recorded once, never
// re-confirmed" — exactly the cohort a staleness sweep should consider.
export const DEFAULT_STALENESS: StalenessThresholds = {
  staleAfterDays: 120,
  maxConfidence: 0.8,
  maxCorroborations: 1,
};

/**
 * Pure staleness predicate. Returns true only when a lesson is old, weak, and
 * uncorroborated. Anything trusted, corroborated, recent, or of unknown age is
 * kept (returns false) — the sweep never removes a record it can't justify.
 */
export function isLessonStale(
  rec: { lastCitedAt?: string | null; createdTime?: string | null; confidence?: number; citationCount?: number },
  nowMs: number,
  t: StalenessThresholds = DEFAULT_STALENESS,
): boolean {
  const confidence = rec.confidence ?? 1;
  const corroborations = rec.citationCount ?? 0;
  if (confidence > t.maxConfidence) return false;
  if (corroborations > t.maxCorroborations) return false;
  const ref = rec.lastCitedAt ?? rec.createdTime;
  if (!ref) return false;
  const ageMs = nowMs - Date.parse(ref);
  if (!Number.isFinite(ageMs)) return false;
  return ageMs >= t.staleAfterDays * 86_400_000;
}

/** Normalize the `supersedes` arg (string | string[] | undefined) to a clean id list. */
export function normalizeSupersedes(supersedes: string | string[] | undefined): string[] {
  if (!supersedes) return [];
  const list = Array.isArray(supersedes) ? supersedes : [supersedes];
  return Array.from(new Set(list.map((s) => String(s ?? "").trim()).filter(Boolean)));
}
