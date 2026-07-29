/**
 * Per-workspace facade over durable turn checkpoints and file-mutation
 * snapshots. The service binds `workspaceRoot`, keeps `sessionKey` explicit,
 * and delegates persistence through an injected port. Restore planning remains
 * deterministic and host-independent.
 */
import type {
  FileMutationRecord,
  QueuedPrompt,
  RecoverableState,
  RestoreAction,
} from './contracts.js';
import { nodeStoragePersistenceAdapter } from './adapters/nodeStoragePersistenceAdapter.js';
import { planRestore } from './policy/restorePlan.js';
import type { StoragePersistencePort } from './ports/storagePersistencePort.js';

export type {
  FileMutationRecord,
  QueuedPrompt,
  RecoverableState,
  RestoreAction,
} from './contracts.js';

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

/** {@link IStorageService} backed by an injected persistence port. */
export class StorageService implements IStorageService {
  constructor(
    private readonly workspaceRoot: string,
    private readonly persistence: StoragePersistencePort = nodeStoragePersistenceAdapter,
  ) {}
  beginTurn(sessionKey: string, prompt: string, nowIso: string): void {
    return this.persistence.beginTurn(this.workspaceRoot, sessionKey, prompt, nowIso);
  }
  endTurn(sessionKey: string): void {
    return this.persistence.endTurn(this.workspaceRoot, sessionKey);
  }
  queueOffline(sessionKey: string, prompt: string, nowIso: string): void {
    return this.persistence.queueOffline(this.workspaceRoot, sessionKey, prompt, nowIso);
  }
  readOfflineQueue(sessionKey: string): QueuedPrompt[] {
    return this.persistence.readOfflineQueue(this.workspaceRoot, sessionKey);
  }
  clearOfflineQueue(sessionKey: string): void {
    return this.persistence.clearOfflineQueue(this.workspaceRoot, sessionKey);
  }
  readRecoverable(sessionKey: string): RecoverableState {
    return this.persistence.readRecoverable(this.workspaceRoot, sessionKey);
  }
  recordFileMutation(sessionKey: string, rec: FileMutationRecord): void {
    return this.persistence.recordFileMutation(this.workspaceRoot, sessionKey, rec);
  }
  readFileMutations(sessionKey: string): FileMutationRecord[] {
    return this.persistence.readFileMutations(this.workspaceRoot, sessionKey);
  }
  planRestore(records: FileMutationRecord[], turnN: number): RestoreAction[] {
    return planRestore(records, turnN);
  }
}

/** Construct a storage service bound to a workspace. */
export function createStorageService(
  workspaceRoot: string,
  persistence: StoragePersistencePort = nodeStoragePersistenceAdapter,
): IStorageService {
  return new StorageService(workspaceRoot, persistence);
}
