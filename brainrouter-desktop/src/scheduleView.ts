/**
 * T14 — pure presentation helpers for the Schedules panel. The CLI owns the
 * store, cron parsing, and the ticker (all tested there); this just shapes a
 * ScheduleRecord[] for display, so the rendering is unit-testable without the
 * host.
 */
export interface ScheduleRecordView {
  id: string;
  kind: 'cron' | 'once';
  expr: string;
  command: string;
  enabled: boolean;
  nextRun: string;
  lastRun?: string;
  createdAt?: string;
}

/** Split into enabled (active) and disabled, each newest-next-run first. */
export function partitionSchedules(records: ScheduleRecordView[]): { active: ScheduleRecordView[]; disabled: ScheduleRecordView[] } {
  const byNext = (a: ScheduleRecordView, b: ScheduleRecordView) => a.nextRun.localeCompare(b.nextRun);
  return {
    active: records.filter((r) => r.enabled).sort(byNext),
    disabled: records.filter((r) => !r.enabled).sort(byNext),
  };
}

/** Human label for a schedule's cadence: "every 15m" style is hard to derive
 *  generally, so show the raw cron expr (cron) or the local time (once). */
export function describeSchedule(r: ScheduleRecordView): string {
  if (r.kind === 'once') {
    const d = new Date(r.expr);
    return Number.isNaN(d.getTime()) ? `once · ${r.expr}` : `once · ${d.toLocaleString()}`;
  }
  return `cron · ${r.expr}`;
}

/** Compact relative "fires in 12m" / "fired 3h ago" string from an ISO time. */
export function relTime(iso: string | undefined, now: number): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diff = t - now;
  const ago = diff < 0;
  const s = Math.round(Math.abs(diff) / 1000);
  const unit = s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
  return ago ? `${unit} ago` : `in ${unit}`;
}
