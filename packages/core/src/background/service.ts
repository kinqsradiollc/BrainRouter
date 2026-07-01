/**
 * Background-task service (ADR-008, Wave 1) — a per-workspace port over the
 * durable background-task store.
 *
 * Additive and behaviour-preserving: every method delegates to the existing
 * store functions (`createBackgroundTask` / `getBackgroundTask` /
 * `listBackgroundTasks` / `countActiveBackgroundTasks` / `updateBackgroundTask` /
 * `appendTaskProgress` / `linkBackgroundTaskMemory`). `workspaceRoot` is bound at
 * construction. No logic moved or removed; the port lives here with its
 * input/filter/patch types (the record types stay in `@kinqs/brainrouter-types`).
 */
import type { BackgroundTaskRecord, BackgroundTaskProgress } from "@kinqs/brainrouter-types";
import {
  createBackgroundTask, getBackgroundTask, listBackgroundTasks, countActiveBackgroundTasks,
  updateBackgroundTask, appendTaskProgress, linkBackgroundTaskMemory,
  type CreateBackgroundTaskInput, type BackgroundTaskFilter, type BackgroundTaskPatch,
} from "./backgroundTaskStore.js";

/** The durable background-task store service contract, scoped to one workspace. */
export interface IBackgroundTaskService {
  create(input: CreateBackgroundTaskInput): BackgroundTaskRecord;
  get(id: string): BackgroundTaskRecord | undefined;
  list(filter?: BackgroundTaskFilter): BackgroundTaskRecord[];
  countActive(sessionKey?: string): number;
  update(id: string, patch: BackgroundTaskPatch): BackgroundTaskRecord | undefined;
  appendProgress(id: string, progress: Omit<BackgroundTaskProgress, "at"> & { at?: string }): BackgroundTaskRecord | undefined;
  linkMemory(id: string, memoryId: string): BackgroundTaskRecord | undefined;
}

/** {@link IBackgroundTaskService} backed by the in-process store — delegates only. */
export class BackgroundTaskService implements IBackgroundTaskService {
  constructor(private readonly workspaceRoot: string) {}
  create(input: CreateBackgroundTaskInput): BackgroundTaskRecord {
    return createBackgroundTask(this.workspaceRoot, input);
  }
  get(id: string): BackgroundTaskRecord | undefined {
    return getBackgroundTask(this.workspaceRoot, id);
  }
  list(filter: BackgroundTaskFilter = {}): BackgroundTaskRecord[] {
    return listBackgroundTasks(this.workspaceRoot, filter);
  }
  countActive(sessionKey?: string): number {
    return countActiveBackgroundTasks(this.workspaceRoot, sessionKey);
  }
  update(id: string, patch: BackgroundTaskPatch): BackgroundTaskRecord | undefined {
    return updateBackgroundTask(this.workspaceRoot, id, patch);
  }
  appendProgress(id: string, progress: Omit<BackgroundTaskProgress, "at"> & { at?: string }): BackgroundTaskRecord | undefined {
    return appendTaskProgress(this.workspaceRoot, id, progress);
  }
  linkMemory(id: string, memoryId: string): BackgroundTaskRecord | undefined {
    return linkBackgroundTaskMemory(this.workspaceRoot, id, memoryId);
  }
}

/** Construct a background-task service bound to a workspace. */
export function createBackgroundTaskService(workspaceRoot: string): IBackgroundTaskService {
  return new BackgroundTaskService(workspaceRoot);
}
