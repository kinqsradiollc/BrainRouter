/**
 * Browser workspace persistence service.
 *
 * Owns restorable workspace tab locations, reviewed geolocation decisions, and
 * (ADR-055 P9) the workspace's bookmarks + visit history. Electron view
 * lifecycle and permission prompting remain in the BrowserViewManager facade.
 *
 * The bookmark/history mutators below are PURE and bounded, so the ranking and
 * capping rules unit-test without Electron or a filesystem.
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

/** ADR-055 P9 — a saved place. `url` is already stripped by persistableBrowserUrl. */
export type BrowserBookmark = {
  url: string;
  title: string;
  addedAt: number;
};

/** ADR-055 P9 — one visited place, deduped by url (visits counts revisits). */
export type BrowserHistoryEntry = {
  url: string;
  title: string;
  visitedAt: number;
  visits: number;
};

/** Bounds so the workspace file can never grow without limit. */
export const MAX_BROWSER_HISTORY = 5_000;
export const MAX_BROWSER_BOOKMARKS = 2_000;
/** How many bookmarks ride the broadcast state (the bar/drawer view). */
export const MAX_BROADCAST_BOOKMARKS = 500;

export type PersistedBrowserWorkspace = {
  version: 1;
  activeIndex: number;
  tabs: Array<{ url: string }>;
  permissions?: PersistedPermissionDecision[];
  bookmarks?: BrowserBookmark[];
  history?: BrowserHistoryEntry[];
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

/** A place worth remembering is an ordinary http(s) URL (never about:blank or
 *  the new-tab data: page). */
function isRecordablePlace(url: string): boolean {
  return !!url && url !== BROWSER_BLANK_URL && /^https?:\/\//i.test(url);
}

/**
 * ADR-055 P9 — record a visit. Deduped by url: a revisit bumps the count and
 * the timestamp and moves the entry to the front. Newest-first, bounded.
 * A blank/data: page is never recorded (it is not a place the user went).
 */
export function recordBrowserVisit(
  history: readonly BrowserHistoryEntry[],
  visit: { url: string; title: string; at: number },
): BrowserHistoryEntry[] {
  const url = persistableBrowserUrl(visit.url);
  // Only a real http(s) place is a visit — never about:blank, the new-tab
  // data: page, or any other scheme.
  if (!isRecordablePlace(url)) return [...history];
  const title = String(visit.title || '').slice(0, 300);
  const existing = history.find((entry) => entry.url === url);
  const rest = history.filter((entry) => entry.url !== url);
  const next: BrowserHistoryEntry = existing
    ? { url, title: title || existing.title, visitedAt: visit.at, visits: existing.visits + 1 }
    : { url, title, visitedAt: visit.at, visits: 1 };
  return [next, ...rest].slice(0, MAX_BROWSER_HISTORY);
}

/** ADR-055 P9 — save a place. Deduped by url (re-adding refreshes the title). */
export function addBrowserBookmark(
  bookmarks: readonly BrowserBookmark[],
  bookmark: { url: string; title: string; at: number },
): BrowserBookmark[] {
  const url = persistableBrowserUrl(bookmark.url);
  if (!isRecordablePlace(url)) return [...bookmarks];
  const title = String(bookmark.title || '').slice(0, 300) || url;
  const rest = bookmarks.filter((entry) => entry.url !== url);
  return [{ url, title, addedAt: bookmark.at }, ...rest].slice(0, MAX_BROWSER_BOOKMARKS);
}

/** ADR-055 P9 — forget a saved place. */
export function removeBrowserBookmark(
  bookmarks: readonly BrowserBookmark[],
  rawUrl: string,
): BrowserBookmark[] {
  const url = persistableBrowserUrl(rawUrl);
  return bookmarks.filter((entry) => entry.url !== url);
}

export function isBookmarked(bookmarks: readonly BrowserBookmark[], rawUrl: string): boolean {
  const url = persistableBrowserUrl(rawUrl);
  return bookmarks.some((entry) => entry.url === url);
}

export type BrowserOmniboxSuggestion = {
  url: string;
  title: string;
  source: 'bookmark' | 'history';
};

/**
 * ADR-055 P9 — omnibox autocomplete from LOCAL bookmarks + history only. There
 * is deliberately no remote suggest service: typing in the address bar must not
 * stream keystrokes to a third party. A bookmark outranks history; within
 * history, more-visited then more-recent wins; a prefix match outranks a
 * substring match. Case-insensitive over both url and title.
 */
export function omniboxSuggest(
  rawQuery: string,
  input: { bookmarks?: readonly BrowserBookmark[]; history?: readonly BrowserHistoryEntry[]; limit?: number },
): BrowserOmniboxSuggestion[] {
  const query = String(rawQuery || '').trim().toLowerCase();
  if (!query) return [];
  const limit = Math.max(1, Math.min(Math.floor(input.limit ?? 8), 50));
  const seen = new Set<string>();
  const out: Array<BrowserOmniboxSuggestion & { rank: number }> = [];

  const consider = (url: string, title: string, source: 'bookmark' | 'history', tieBreak: number): void => {
    if (seen.has(url)) return;
    const haystackUrl = url.toLowerCase();
    const haystackTitle = String(title || '').toLowerCase();
    const prefix = haystackUrl.includes(`//${query}`) || haystackUrl.startsWith(query) || haystackTitle.startsWith(query);
    const hit = prefix || haystackUrl.includes(query) || haystackTitle.includes(query);
    if (!hit) return;
    seen.add(url);
    // Lower rank sorts first: bookmarks before history, prefix before substring.
    const rank = (source === 'bookmark' ? 0 : 100) + (prefix ? 0 : 10) - Math.min(tieBreak, 9);
    out.push({ url, title: title || url, source, rank });
  };

  for (const entry of input.bookmarks ?? []) consider(entry.url, entry.title, 'bookmark', 0);
  for (const entry of input.history ?? []) consider(entry.url, entry.title, 'history', entry.visits);

  return out
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
    .map(({ url, title, source }) => ({ url, title, source }));
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
