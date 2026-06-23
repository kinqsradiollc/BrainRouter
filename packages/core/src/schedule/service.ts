/**
 * Schedule service (ADR-008, Wave 1) — a per-workspace port over the schedule
 * store + cron parser.
 *
 * Additive and behaviour-preserving: every method delegates to the existing
 * functions (`loadSchedules` / `addSchedule` / `removeSchedule` /
 * `setScheduleEnabled` / `recordFire`, `parseCron` / `nextCronFire`).
 * `workspaceRoot` is bound at construction so callers get a clean per-workspace
 * object. No logic moved or removed; the port lives here with its record types.
 */
import { parseCron, nextCronFire, type CronExpr } from "./cronParser.js";
import {
  loadSchedules, addSchedule, removeSchedule, setScheduleEnabled, recordFire,
  type ScheduleRecord, type AddScheduleInput,
} from "./scheduleStore.js";

/** The schedule (cron/once) service contract, scoped to one workspace. */
export interface IScheduleService {
  list(): ScheduleRecord[];
  add(input: AddScheduleInput): ScheduleRecord;
  remove(id: string): boolean;
  setEnabled(id: string, enabled: boolean): boolean;
  recordFire(id: string, firedAt: Date, nextRun: string | undefined): void;
  parseCron(expr: string): CronExpr | undefined;
  nextFire(cron: CronExpr, after: Date): Date;
}

/** {@link IScheduleService} backed by the in-process schedule store — delegates only. */
export class ScheduleService implements IScheduleService {
  constructor(private readonly workspaceRoot: string) {}
  list(): ScheduleRecord[] {
    return loadSchedules(this.workspaceRoot);
  }
  add(input: AddScheduleInput): ScheduleRecord {
    return addSchedule(this.workspaceRoot, input);
  }
  remove(id: string): boolean {
    return removeSchedule(this.workspaceRoot, id);
  }
  setEnabled(id: string, enabled: boolean): boolean {
    return setScheduleEnabled(this.workspaceRoot, id, enabled);
  }
  recordFire(id: string, firedAt: Date, nextRun: string | undefined): void {
    return recordFire(this.workspaceRoot, id, firedAt, nextRun);
  }
  parseCron(expr: string): CronExpr | undefined {
    return parseCron(expr);
  }
  nextFire(cron: CronExpr, after: Date): Date {
    return nextCronFire(cron, after);
  }
}

/** Construct a schedule service bound to a workspace. */
export function createScheduleService(workspaceRoot: string): IScheduleService {
  return new ScheduleService(workspaceRoot);
}
