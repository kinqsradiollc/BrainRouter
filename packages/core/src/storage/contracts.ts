export interface QueuedPrompt {
  prompt: string;
  at: string;
  kind: 'crash' | 'offline';
}

export interface RecoverableState {
  crashed: QueuedPrompt | null;
  offline: QueuedPrompt[];
}

export interface FileMutationRecord {
  /** User-turn ordinal at mutation time (1-based). */
  turn: number;
  /** Workspace-relative path. */
  path: string;
  /** File content before the turn's first mutation, or null when absent. */
  priorContent: string | null;
}

export interface RestoreAction {
  path: string;
  action: 'write' | 'delete';
  content?: string;
}
