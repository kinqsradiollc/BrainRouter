/**
 * Usage service (ADR-008, Wave 2) — a stateless port over the daily-usage
 * history store (global, not workspace-scoped). Additive and behaviour-preserving:
 * every method delegates to the existing usageHistoryStore functions. No logic
 * moved or removed.
 */
import {
  dayKey, recordDailyUsage, readUsageHistory, totalUsage, type DailyUsage,
} from "./usageHistoryStore.js";

/** Usage delta accepted by {@link IUsageService.record}. */
export type UsageDelta = Parameters<typeof recordDailyUsage>[0];
/** Aggregate returned by {@link IUsageService.total}. */
export type UsageTotals = ReturnType<typeof totalUsage>;

/** The daily-usage history contract. */
export interface IUsageService {
  dayKey(tsMs: number): string;
  record(usage: UsageDelta, nowMs: number): void;
  readHistory(days: number, nowMs: number): DailyUsage[];
  total(records: DailyUsage[]): UsageTotals;
}

/** {@link IUsageService} backed by the in-process usage store — delegates only. */
export class UsageService implements IUsageService {
  dayKey(tsMs: number): string {
    return dayKey(tsMs);
  }
  record(usage: UsageDelta, nowMs: number): void {
    return recordDailyUsage(usage, nowMs);
  }
  readHistory(days: number, nowMs: number): DailyUsage[] {
    return readUsageHistory(days, nowMs);
  }
  total(records: DailyUsage[]): UsageTotals {
    return totalUsage(records);
  }
}

/** Construct a usage service. */
export function createUsageService(): IUsageService {
  return new UsageService();
}
