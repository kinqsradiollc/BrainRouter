/**
 * ADR-049 S1 / D3 — the spaced-repetition scheduler. Deterministic engineering:
 * the same grades from the same state always produce the same schedule, offline,
 * with no model in the loop. An SM-2-family algorithm with four grades
 * (again/hard/good/easy) at day granularity.
 *
 * Pure over its inputs and the injected `now` — every function returns a NEW
 * schedule, never mutating the argument, so a review UI can preview each grade's
 * outcome before committing one.
 */
import type { StudyCardSchedule, StudyGrade } from "@kinqs/brainrouter-types";

export const MIN_EASE = 1.3;
export const DEFAULT_EASE = 2.5;

/** `YYYY-MM-DD` for the local day of `d`. Day granularity is the SRS unit. */
export function isoDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(fromIsoDay: string, days: number): string {
  const [y, m, d] = fromIsoDay.split("-").map((n) => parseInt(n, 10));
  const base = new Date(y, m - 1, d);
  base.setDate(base.getDate() + Math.max(0, Math.round(days)));
  return isoDay(base);
}

function clampEase(ease: number): number {
  return Math.max(MIN_EASE, Math.round(ease * 100) / 100);
}

/** A fresh schedule for a never-seen card — `new`, due today. */
export function newSchedule(cardId: string, now: Date): StudyCardSchedule {
  return {
    cardId,
    state: "new",
    ease: DEFAULT_EASE,
    intervalDays: 0,
    repetitions: 0,
    lapses: 0,
    dueOn: isoDay(now),
    reviewCount: 0,
  };
}

/**
 * The interval (in whole days) a grade WOULD set for this schedule, without
 * committing — the review UI labels each grade button with it. Mirrors
 * {@link applyGrade}'s interval math exactly.
 */
export function previewIntervalDays(schedule: StudyCardSchedule, grade: StudyGrade): number {
  if (grade === "again") return 1;
  const reps = schedule.repetitions;
  if (reps === 0) return grade === "easy" ? 4 : 1;
  if (reps === 1) return grade === "hard" ? 3 : grade === "easy" ? 8 : 6;
  const nextEase = grade === "hard" ? clampEase(schedule.ease - 0.15)
    : grade === "easy" ? clampEase(schedule.ease + 0.15)
      : schedule.ease;
  const mult = grade === "hard" ? 1.2 : grade === "easy" ? nextEase * 1.3 : nextEase;
  return Math.max(schedule.intervalDays + 1, Math.round(schedule.intervalDays * mult));
}

/**
 * Apply one grade → the next schedule. Deterministic and total. `again` is a
 * lapse (ease penalty, reps reset, due tomorrow — the live review session may
 * still re-show it this sitting); the rest advance the SM-2 progression, with
 * hard/easy nudging the ease down/up.
 */
export function applyGrade(
  schedule: StudyCardSchedule,
  grade: StudyGrade,
  now: Date,
): StudyCardSchedule {
  const today = isoDay(now);
  const nowIso = now.toISOString();
  const base = {
    cardId: schedule.cardId,
    lastReviewedAt: nowIso,
    reviewCount: schedule.reviewCount + 1,
  };

  if (grade === "again") {
    return {
      ...base,
      state: "learning",
      ease: clampEase(schedule.ease - 0.2),
      intervalDays: 1,
      repetitions: 0,
      lapses: schedule.lapses + 1,
      dueOn: addDays(today, 1),
    };
  }

  const ease = grade === "hard" ? clampEase(schedule.ease - 0.15)
    : grade === "easy" ? clampEase(schedule.ease + 0.15)
      : schedule.ease;
  const intervalDays = previewIntervalDays(schedule, grade);
  return {
    ...base,
    state: "review",
    ease,
    intervalDays,
    repetitions: schedule.repetitions + 1,
    lapses: schedule.lapses,
    dueOn: addDays(today, intervalDays),
  };
}

/**
 * The card ids due on or before `now`, most-overdue first (then by id for a
 * stable order). A card with no schedule is `new` and handled by the session,
 * not here — this ranks the SCHEDULED cards.
 */
export function dueCardIds(
  schedules: Record<string, StudyCardSchedule>,
  now: Date,
): string[] {
  const today = isoDay(now);
  return Object.values(schedules)
    .filter((s) => s.dueOn <= today)
    .sort((a, b) => (a.dueOn < b.dueOn ? -1 : a.dueOn > b.dueOn ? 1 : a.cardId.localeCompare(b.cardId)))
    .map((s) => s.cardId);
}
