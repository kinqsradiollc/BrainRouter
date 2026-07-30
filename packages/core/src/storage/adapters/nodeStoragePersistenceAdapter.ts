import {
  beginTurnCheckpoint,
  clearOfflineQueue,
  endTurnCheckpoint,
  queueOfflinePrompt,
  readOfflineQueue,
  readRecoverable,
} from '../checkpointStore.js';
import {
  readFileMutations,
  recordFileMutation,
} from '../fileSnapshotStore.js';
import type { StoragePersistencePort } from '../ports/storagePersistencePort.js';

export const nodeStoragePersistenceAdapter: StoragePersistencePort = {
  beginTurn: beginTurnCheckpoint,
  endTurn: endTurnCheckpoint,
  queueOffline: queueOfflinePrompt,
  readOfflineQueue,
  clearOfflineQueue,
  readRecoverable,
  recordFileMutation,
  readFileMutations,
};
