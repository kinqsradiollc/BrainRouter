/**
 * ADR-049 S6 / D6 — the once-daily study reminder, expressed as a record in the
 * EXISTING schedule store (`schedules.json`), no new scheduler. This module is the
 * pure, browser-safe shape + query logic; the desktop host manages the record
 * (add/remove) and surfaces the nudge (§4 keeps this desktop-only — no CLI
 * command). Every function here is a pure function of its inputs.
 */
import type { ScheduleRecord, AddScheduleInput } from "../schedule/scheduleStore.js";
import { isoDay } from "./srs.js";

/**
 * The command a study reminder record carries. It is a marker owned by the study
 * mode (the desktop is its consumer); it is deliberately NOT a CLI slash command
 * — ADR-049 §4 keeps study desktop-only. A schedule ticker that does not know it
 * ignores it, which is the correct no-op.
 */
export const STUDY_REMINDER_COMMAND = "study:daily-review";

const DEFAULT_HOUR = 9;

function clampHour(hour: number | undefined): number {
  const h = Math.floor(hour ?? DEFAULT_HOUR);
  return Number.isFinite(h) ? Math.max(0, Math.min(23, h)) : DEFAULT_HOUR;
}

/** ISO timestamp of the next occurrence of `hour:00` at or after `now`. */
export function nextDailyRun(hour: number, now: Date): string {
  const h = clampHour(hour);
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setMinutes(0);
  next.setHours(h);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

/** The AddScheduleInput for a daily study reminder at `hour`, owned by `owner`. */
export function buildStudyReminderSchedule(
  input: { owner: string; hour?: number },
  now: Date,
): AddScheduleInput {
  const hour = clampHour(input.hour);
  return {
    kind: "cron",
    expr: `0 ${hour} * * *`,
    command: STUDY_REMINDER_COMMAND,
    owner: input.owner,
    nextRun: nextDailyRun(hour, now),
    enabled: true,
  };
}

/** The study reminder record among `schedules`, or undefined when none is set. */
export function findStudyReminder(schedules: readonly ScheduleRecord[]): ScheduleRecord | undefined {
  return schedules.find((s) => s.command === STUDY_REMINDER_COMMAND);
}

/** The configured reminder hour (0–23) parsed from a record's cron expr, or default. */
export function studyReminderHour(record: ScheduleRecord | undefined): number {
  if (!record) return DEFAULT_HOUR;
  const parts = record.expr.trim().split(/\s+/);
  return clampHour(parts.length >= 2 ? Number(parts[1]) : DEFAULT_HOUR);
}

export interface StudyReminderState {
  enabled: boolean;
  hour: number;
}

/** The reminder's on/off + hour, from the schedule list. */
export function studyReminderState(schedules: readonly ScheduleRecord[]): StudyReminderState {
  const record = findStudyReminder(schedules);
  return { enabled: Boolean(record?.enabled), hour: studyReminderHour(record) };
}

/**
 * Should the desktop nudge now? True when the reminder is enabled, at least
 * `dueCount` cards are due, today's reminder hour has passed, and no nudge has
 * fired today already (`lastNudgeDay`, an ISO yyyy-mm-dd). Pure — the host owns
 * reading due counts and persisting `lastNudgeDay`.
 */
export function shouldNudge(
  input: { enabled: boolean; hour: number; dueCount: number; lastNudgeDay?: string },
  now: Date,
): boolean {
  if (!input.enabled || input.dueCount <= 0) return false;
  const today = isoDay(now);
  if (input.lastNudgeDay === today) return false;
  return now.getHours() >= clampHour(input.hour);
}
