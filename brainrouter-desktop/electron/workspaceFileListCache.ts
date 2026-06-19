export interface WorkspaceFileListResult {
  files: string[];
  truncated: boolean;
  source: 'git' | 'filesystem';
  generatedAt: number;
  cached?: boolean;
  error?: string;
}

export class WorkspaceFileListCache {
  private readonly entries = new Map<string, WorkspaceFileListResult>();

  constructor(private readonly ttlMs = 30_000) {}

  get(workspaceRoot: string, now = Date.now()): WorkspaceFileListResult | null {
    const entry = this.entries.get(workspaceRoot);
    if (!entry) return null;
    if (now - entry.generatedAt > this.ttlMs) {
      this.entries.delete(workspaceRoot);
      return null;
    }
    return { ...entry, cached: true };
  }

  set(workspaceRoot: string, result: Omit<WorkspaceFileListResult, 'cached'>): WorkspaceFileListResult {
    const entry: WorkspaceFileListResult = { ...result, cached: false };
    this.entries.set(workspaceRoot, entry);
    return entry;
  }

  invalidate(workspaceRoot?: string): void {
    if (workspaceRoot) this.entries.delete(workspaceRoot);
    else this.entries.clear();
  }
}
