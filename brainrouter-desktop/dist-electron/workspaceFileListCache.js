export class WorkspaceFileListCache {
    ttlMs;
    entries = new Map();
    constructor(ttlMs = 30_000) {
        this.ttlMs = ttlMs;
    }
    get(workspaceRoot, now = Date.now()) {
        const entry = this.entries.get(workspaceRoot);
        if (!entry)
            return null;
        if (now - entry.generatedAt > this.ttlMs) {
            this.entries.delete(workspaceRoot);
            return null;
        }
        return { ...entry, cached: true };
    }
    set(workspaceRoot, result) {
        const entry = { ...result, cached: false };
        this.entries.set(workspaceRoot, entry);
        return entry;
    }
    invalidate(workspaceRoot) {
        if (workspaceRoot)
            this.entries.delete(workspaceRoot);
        else
            this.entries.clear();
    }
}
