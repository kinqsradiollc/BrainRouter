/**
 * Browser workspace persistence service.
 *
 * Owns only restorable workspace tab locations and reviewed geolocation
 * decisions. Electron view lifecycle and permission prompting remain in the
 * BrowserViewManager facade.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BROWSER_BLANK_URL } from './protocol.js';

export type PersistedPermissionDecision = {
  origin: string;
  permission: 'geolocation';
  decision: 'allow' | 'block';
};

export type PersistedBrowserWorkspace = {
  version: 1;
  activeIndex: number;
  tabs: Array<{ url: string }>;
  permissions?: PersistedPermissionDecision[];
};

export interface BrowserWorkspacePersistenceTimers {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

const SYSTEM_PERSISTENCE_TIMERS: BrowserWorkspacePersistenceTimers = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Coalesce navigation/title persistence bursts while retaining an explicit
 * synchronous flush for tab mutations and host shutdown.
 */
export class BrowserWorkspacePersistenceQueue {
  private pending: unknown = null;

  constructor(
    private readonly persist: () => void,
    private readonly delayMs = 50,
    private readonly timers: BrowserWorkspacePersistenceTimers =
      SYSTEM_PERSISTENCE_TIMERS,
  ) {}

  schedule(): void {
    if (this.pending !== null) return;
    this.pending = this.timers.set(() => {
      this.pending = null;
      this.persist();
    }, this.delayMs);
    const handle = this.pending as { unref?: () => void };
    handle?.unref?.();
  }

  flush(): void {
    if (this.pending !== null) {
      this.timers.clear(this.pending);
      this.pending = null;
    }
    this.persist();
  }
}

export function persistableBrowserUrl(raw: string): string {
  if (!raw || raw.startsWith('data:')) return BROWSER_BLANK_URL;
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return BROWSER_BLANK_URL;
  }
}

export class BrowserWorkspaceStore {
  constructor(
    private readonly userDataPath: string,
    private readonly workspaceRoot: string,
  ) {}

  load(): PersistedBrowserWorkspace | null {
    try {
      return JSON.parse(
        fs.readFileSync(this.filePath(), 'utf8'),
      ) as PersistedBrowserWorkspace;
    } catch {
      return null;
    }
  }

  save(state: PersistedBrowserWorkspace): void {
    const file = this.filePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(temporary, file);
  }

  private filePath(): string {
    const key = createHash('sha256')
      .update(this.workspaceRoot)
      .digest('hex')
      .slice(0, 20);
    return path.join(this.userDataPath, 'browser-tabs-v1', `${key}.json`);
  }
}
