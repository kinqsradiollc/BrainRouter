/**
 * Storage service (ADR-008, Wave 2) — a per-workspace port over the turn /
 * offline-queue checkpoint store and the file-mutation snapshot store. A
 * workspace holds many sessions, so the facade binds `workspaceRoot` and keeps
 * `sessionKey` a per-call argument. Additive and behaviour-preserving: every
 * method delegates to the existing store functions. The low-level
 * `store.ts` primitive and the pure connectivity/retry predicates stay importable
 * as module utilities. No logic moved or removed.
 */
import {
  beginTurnCheckpoint, endTurnCheckpoint, queueOfflinePrompt, readOfflineQueue,
  clearOfflineQueue, readRecoverable, type QueuedPrompt,
} from "./checkpointStore.js";
import {
  recordFileMutation, readFileMutations, planRestore,
  type FileMutationRecord, type RestoreAction,
} from "./fileSnapshotStore.js";

/** Result of {@link IStorageService.readRecoverable} — the store's exact shape. */
export type RecoverableState = ReturnType<typeof readRecoverable>;

/** The turn-checkpoint + file-snapshot store contract, scoped to one workspace. */
export interface IStorageService {
  beginTurn(sessionKey: string, prompt: string, nowIso: string): void;
  endTurn(sessionKey: string): void;
  queueOffline(sessionKey: string, prompt: string, nowIso: string): void;
  readOfflineQueue(sessionKey: string): QueuedPrompt[];
  clearOfflineQueue(sessionKey: string): void;
  readRecoverable(sessionKey: string): RecoverableState;
  recordFileMutation(sessionKey: string, rec: FileMutationRecord): void;
  readFileMutations(sessionKey: string): FileMutationRecord[];
  planRestore(records: FileMutationRecord[], turnN: number): RestoreAction[];
}

/** {@link IStorageService} backed by the in-process stores — delegates only. */
export class StorageService implements IStorageService {
  constructor(private readonly workspaceRoot: string) {}
  beginTurn(sessionKey: string, prompt: string, nowIso: string): void {
    return beginTurnCheckpoint(this.workspaceRoot, sessionKey, prompt, nowIso);
  }
  endTurn(sessionKey: string): void {
    return endTurnCheckpoint(this.workspaceRoot, sessionKey);
  }
  queueOffline(sessionKey: string, prompt: string, nowIso: string): void {
    return queueOfflinePrompt(this.workspaceRoot, sessionKey, prompt, nowIso);
  }
  readOfflineQueue(sessionKey: string): QueuedPrompt[] {
    return readOfflineQueue(this.workspaceRoot, sessionKey);
  }
  clearOfflineQueue(sessionKey: string): void {
    return clearOfflineQueue(this.workspaceRoot, sessionKey);
  }
  readRecoverable(sessionKey: string): RecoverableState {
    return readRecoverable(this.workspaceRoot, sessionKey);
  }
  recordFileMutation(sessionKey: string, rec: FileMutationRecord): void {
    return recordFileMutation(this.workspaceRoot, sessionKey, rec);
  }
  readFileMutations(sessionKey: string): FileMutationRecord[] {
    return readFileMutations(this.workspaceRoot, sessionKey);
  }
  planRestore(records: FileMutationRecord[], turnN: number): RestoreAction[] {
    return planRestore(records, turnN);
  }
}

/** Construct a storage service bound to a workspace. */
export function createStorageService(workspaceRoot: string): IStorageService {
  return new StorageService(workspaceRoot);
}
