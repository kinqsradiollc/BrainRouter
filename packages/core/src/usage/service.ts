/**
 * Usage service (ADR-008, Wave 2) — a stateless port over the daily-usage
 * history store (global, not workspace-scoped). Additive and behaviour-preserving:
 * every method delegates to the existing usageHistoryStore functions. No logic
 * moved or removed.
 */
import {
  dayKey, recordDailyUsage, readUsageHistory, readAutomationUsage, totalUsage,
  type DailyUsage, type AutomationUsage,
} from "./usageHistoryStore.js";

/** Usage delta accepted by {@link IUsageService.record}. */
export type UsageDelta = Parameters<typeof recordDailyUsage>[0];
/** Aggregate returned by {@link IUsageService.total}. */
export type UsageTotals = ReturnType<typeof totalUsage>;

/** The daily-usage history contract. */
export interface IUsageService {
  dayKey(tsMs: number): string;
  /** ADR-052 D2 — `attribution` folds the turn into a per-automation bucket. */
  record(usage: UsageDelta, nowMs: number, attribution?: string): void;
  readHistory(days: number, nowMs: number): DailyUsage[];
  total(records: DailyUsage[]): UsageTotals;
  /** ADR-052 D2 — per-automation token totals over `days`, costliest first. */
  automationBreakdown(days: number, nowMs: number): Array<AutomationUsage & { automation: string }>;
}

/** {@link IUsageService} backed by the in-process usage store — delegates only. */
export class UsageService implements IUsageService {
  dayKey(tsMs: number): string {
    return dayKey(tsMs);
  }
  record(usage: UsageDelta, nowMs: number, attribution?: string): void {
    return recordDailyUsage(usage, nowMs, attribution);
  }
  readHistory(days: number, nowMs: number): DailyUsage[] {
    return readUsageHistory(days, nowMs);
  }
  total(records: DailyUsage[]): UsageTotals {
    return totalUsage(records);
  }
  automationBreakdown(days: number, nowMs: number): Array<AutomationUsage & { automation: string }> {
    return readAutomationUsage(days, nowMs);
  }
}

/** Construct a usage service. */
export function createUsageService(): IUsageService {
  return new UsageService();
}
