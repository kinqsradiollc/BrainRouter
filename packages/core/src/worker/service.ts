/**
 * Worker service (ADR-008, Wave 1) — a per-workspace port over the worker store.
 *
 * Additive and behaviour-preserving: every method delegates to the existing
 * worker-store functions. `workspaceRoot` is bound at construction. No logic
 * moved or removed; the port lives here with its `WorkerMeta`/`CreateWorkerInput`
 * types. Part of the jobs tier alongside the schedule + background-task ports.
 */
import {
  createWorker, readWorkerMeta, updateWorkerMeta, listWorkers,
  appendWorkerTranscript, readWorkerTranscript, writeWorkerSummary, readWorkerSummary,
  closeWorker, canSpawnWorker, reconcileStaleWorkers,
  type WorkerMeta, type CreateWorkerInput,
} from "./workerStore.js";

/** The worker (sub-agent run) store service contract, scoped to one workspace. */
export interface IWorkerService {
  canSpawn(parentDepth: number): boolean;
  create(input: CreateWorkerInput): WorkerMeta;
  get(id: string): WorkerMeta | null;
  update(id: string, patch: Partial<Omit<WorkerMeta, "id" | "createdAt">>): WorkerMeta | null;
  list(): WorkerMeta[];
  appendTranscript(id: string, entry: unknown): void;
  readTranscript(id: string, limit?: number): unknown[];
  writeSummary(id: string, markdown: string): void;
  readSummary(id: string): string | null;
  close(id: string): WorkerMeta | null;
  reconcileStale(currentPid?: number): number;
}

/** {@link IWorkerService} backed by the in-process worker store — delegates only. */
export class WorkerService implements IWorkerService {
  constructor(private readonly workspaceRoot: string) {}
  canSpawn(parentDepth: number): boolean {
    return canSpawnWorker(parentDepth);
  }
  create(input: CreateWorkerInput): WorkerMeta {
    return createWorker(this.workspaceRoot, input);
  }
  get(id: string): WorkerMeta | null {
    return readWorkerMeta(this.workspaceRoot, id);
  }
  update(id: string, patch: Partial<Omit<WorkerMeta, "id" | "createdAt">>): WorkerMeta | null {
    return updateWorkerMeta(this.workspaceRoot, id, patch);
  }
  list(): WorkerMeta[] {
    return listWorkers(this.workspaceRoot);
  }
  appendTranscript(id: string, entry: unknown): void {
    return appendWorkerTranscript(this.workspaceRoot, id, entry);
  }
  readTranscript(id: string, limit?: number): unknown[] {
    return limit === undefined ? readWorkerTranscript(this.workspaceRoot, id) : readWorkerTranscript(this.workspaceRoot, id, limit);
  }
  writeSummary(id: string, markdown: string): void {
    return writeWorkerSummary(this.workspaceRoot, id, markdown);
  }
  readSummary(id: string): string | null {
    return readWorkerSummary(this.workspaceRoot, id);
  }
  close(id: string): WorkerMeta | null {
    return closeWorker(this.workspaceRoot, id);
  }
  reconcileStale(currentPid?: number): number {
    return currentPid === undefined ? reconcileStaleWorkers(this.workspaceRoot) : reconcileStaleWorkers(this.workspaceRoot, currentPid);
  }
}

/** Construct a worker service bound to a workspace. */
export function createWorkerService(workspaceRoot: string): IWorkerService {
  return new WorkerService(workspaceRoot);
}
