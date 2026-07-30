import { randomUUID } from 'node:crypto';

import { getStateFile, readJsonFile, writeJsonFile } from '../../storage/store.js';
import type { BackgroundTaskFile, BackgroundTaskHost } from './contracts.js';

const FILE_NAME = 'backgroundTasks.json';

function file(workspaceRoot: string): string {
  return getStateFile(workspaceRoot, FILE_NAME);
}

export const nodeBackgroundTaskHost: BackgroundTaskHost = {
  read: (workspaceRoot) => readJsonFile<BackgroundTaskFile>(
    file(workspaceRoot),
    { tasks: [] },
  ),
  write: (workspaceRoot, data) => writeJsonFile(file(workspaceRoot), data),
  createId: () => `btask_${randomUUID().slice(0, 8)}`,
  nowIso: () => new Date().toISOString(),
  ownerPid: () => process.pid,
  isProcessAlive: (pid) => {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
};
