import type { BackgroundTaskRecord } from '@kinqs/brainrouter-types';

export type StoredBackgroundTask = BackgroundTaskRecord & { pid?: number };

export interface BackgroundTaskFile {
  tasks: StoredBackgroundTask[];
}

export interface BackgroundTaskHost {
  read(workspaceRoot: string): BackgroundTaskFile;
  write(workspaceRoot: string, data: BackgroundTaskFile): void;
  createId(): string;
  nowIso(): string;
  ownerPid(): number;
  isProcessAlive(pid: number | null | undefined): boolean;
}
