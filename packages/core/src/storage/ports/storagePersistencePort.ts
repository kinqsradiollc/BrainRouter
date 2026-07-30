import type {
  FileMutationRecord,
  QueuedPrompt,
  RecoverableState,
} from '../contracts.js';

export interface StoragePersistencePort {
  beginTurn(workspaceRoot: string, sessionKey: string, prompt: string, nowIso: string): void;
  endTurn(workspaceRoot: string, sessionKey: string): void;
  queueOffline(workspaceRoot: string, sessionKey: string, prompt: string, nowIso: string): void;
  readOfflineQueue(workspaceRoot: string, sessionKey: string): QueuedPrompt[];
  clearOfflineQueue(workspaceRoot: string, sessionKey: string): void;
  readRecoverable(workspaceRoot: string, sessionKey: string): RecoverableState;
  recordFileMutation(workspaceRoot: string, sessionKey: string, record: FileMutationRecord): void;
  readFileMutations(workspaceRoot: string, sessionKey: string): FileMutationRecord[];
}
