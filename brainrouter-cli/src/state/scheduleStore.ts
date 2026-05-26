/**
 * Persistent store for `/schedule` jobs.
 *
 * One JSON file per workspace under the user-global brainrouter home
 * (same contract /feedback uses) — writes go through `writeJsonFile`
 * which does the atomic temp-then-rename dance, so a Ctrl-C mid-write
 * can't corrupt the file.
 */

import crypto from 'node:crypto';
import { getCliStateFile, readJsonFile, writeJsonFile } from './cliState.js';

export type ScheduleKind = 'cron' | 'once';

export interface ScheduleRecord {
  id: string;
  kind: ScheduleKind;
  /** Cron expression for `cron`, or ISO timestamp for `once`. */
  expr: string;
  /** Slash command to dispatch. Always starts with `/`. */
  command: string;
  /** sessionKey of the REPL that registered the schedule. */
  owner: string;
  createdAt: string;
  enabled: boolean;
  nextRun: string;
  lastRun?: string;
}

interface ScheduleFile {
  version: 1;
  schedules: ScheduleRecord[];
}

const FILE_NAME = 'schedules.json';
const EMPTY: ScheduleFile = { version: 1, schedules: [] };

function filePath(workspaceRoot: string): string {
  return getCliStateFile(workspaceRoot, FILE_NAME);
}

export function loadSchedules(workspaceRoot: string): ScheduleRecord[] {
  return readJsonFile<ScheduleFile>(filePath(workspaceRoot), EMPTY).schedules ?? [];
}

export function saveSchedules(workspaceRoot: string, list: ScheduleRecord[]): void {
  writeJsonFile(filePath(workspaceRoot), { version: 1, schedules: list } satisfies ScheduleFile);
}

export interface AddScheduleInput {
  kind: ScheduleKind;
  expr: string;
  command: string;
  owner: string;
  nextRun: string;
  enabled?: boolean;
}

export function addSchedule(workspaceRoot: string, input: AddScheduleInput): ScheduleRecord {
  const list = loadSchedules(workspaceRoot);
  const rec: ScheduleRecord = {
    id: 'sch_' + crypto.randomBytes(4).toString('hex'),
    kind: input.kind,
    expr: input.expr,
    command: input.command,
    owner: input.owner,
    createdAt: new Date().toISOString(),
    enabled: input.enabled ?? true,
    nextRun: input.nextRun,
  };
  list.push(rec);
  saveSchedules(workspaceRoot, list);
  return rec;
}

export function removeSchedule(workspaceRoot: string, id: string): boolean {
  const list = loadSchedules(workspaceRoot);
  const next = list.filter((s) => s.id !== id);
  if (next.length === list.length) return false;
  saveSchedules(workspaceRoot, next);
  return true;
}

export function setScheduleEnabled(workspaceRoot: string, id: string, enabled: boolean): boolean {
  const list = loadSchedules(workspaceRoot);
  const rec = list.find((s) => s.id === id);
  if (!rec) return false;
  rec.enabled = enabled;
  saveSchedules(workspaceRoot, list);
  return true;
}

export function recordFire(
  workspaceRoot: string,
  id: string,
  firedAt: Date,
  nextRun: string | undefined,
): void {
  const list = loadSchedules(workspaceRoot);
  const rec = list.find((s) => s.id === id);
  if (!rec) return;
  rec.lastRun = firedAt.toISOString();
  if (nextRun) rec.nextRun = nextRun;
  saveSchedules(workspaceRoot, list);
}
