/**
 * Browser tab collection lifecycle.
 *
 * Owns tab identity, ordering, active selection, recently closed entries, and
 * bounded snapshots. Electron views and attachment remain host-managed.
 */
import { BrowserManagerError } from './browserManagerError.js';
import { persistableBrowserUrl } from './browserWorkspaceStore.js';
import {
  BROWSER_BLANK_URL,
  MAX_BROWSER_TABS,
  boundBrowserText,
  type BrowserTab,
  type BrowserTabId,
} from './protocol.js';

type ClosedTab = { url: string; title: string };

export interface RemovedBrowserTab {
  tab: BrowserTab;
  activeChanged: boolean;
  needsBlankTab: boolean;
}

function initialTab(
  id: string,
  url: string,
  title = 'New tab',
  now = Date.now(),
): BrowserTab {
  return {
    id,
    url,
    title: boundBrowserText(title || 'New tab', 256),
    faviconUrl: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    crashed: false,
    audible: false,
    muted: false,
    zoomFactor: 1,
    revision: 0,
    lastAccessedAt: now,
  };
}

export class BrowserTabStateManager {
  private readonly tabs: BrowserTab[] = [];
  private activeId = '';
  private closedTabs: ClosedTab[] = [];
  private sequence = 0;

  constructor(private readonly windowPrefix: string) {}

  get activeTabId(): BrowserTabId {
    return this.activeId;
  }

  get length(): number {
    return this.tabs.length;
  }

  get closedCount(): number {
    return this.closedTabs.length;
  }

  all(): BrowserTab[] {
    return this.tabs;
  }

  snapshot(): BrowserTab[] {
    return this.tabs.map((tab) => ({ ...tab }));
  }

  ensureCanCreate(): void {
    if (this.tabs.length >= MAX_BROWSER_TABS) {
      throw new BrowserManagerError(
        'TAB_LIMIT',
        `A maximum of ${MAX_BROWSER_TABS} tabs is supported.`,
      );
    }
  }

  create(url: string, title?: string): BrowserTab {
    this.ensureCanCreate();
    const tab = initialTab(
      `tab_${this.windowPrefix}_${++this.sequence}`,
      url,
      title,
    );
    this.tabs.push(tab);
    return tab;
  }

  select(id: BrowserTabId): BrowserTab {
    const tab = this.get(id);
    if (!tab) {
      throw new BrowserManagerError(
        'TAB_NOT_FOUND',
        `Browser tab ${id} was not found.`,
      );
    }
    this.activeId = id;
    tab.lastAccessedAt = Date.now();
    return tab;
  }

  remove(id: BrowserTabId): RemovedBrowserTab {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index < 0) {
      throw new BrowserManagerError(
        'TAB_NOT_FOUND',
        `Browser tab ${id} was not found.`,
      );
    }
    const [tab] = this.tabs.splice(index, 1);
    if (tab.url !== BROWSER_BLANK_URL) {
      this.closedTabs.push({
        url: persistableBrowserUrl(tab.url),
        title: tab.title,
      });
      this.closedTabs = this.closedTabs.slice(-25);
    }
    const activeChanged = this.activeId === id;
    if (this.tabs.length === 0) {
      this.activeId = '';
    } else if (activeChanged) {
      this.activeId = this.tabs[Math.min(index, this.tabs.length - 1)].id;
    }
    return {
      tab,
      activeChanged,
      needsBlankTab: this.tabs.length === 0,
    };
  }

  takeClosed(): ClosedTab | undefined {
    return this.closedTabs.pop();
  }

  reorder(id: BrowserTabId, toIndex: number): BrowserTab[] {
    const from = this.tabs.findIndex((tab) => tab.id === id);
    if (from < 0) {
      throw new BrowserManagerError(
        'TAB_NOT_FOUND',
        `Browser tab ${id} was not found.`,
      );
    }
    const target = Math.max(
      0,
      Math.min(this.tabs.length - 1, Math.floor(toIndex)),
    );
    const [tab] = this.tabs.splice(from, 1);
    this.tabs.splice(target, 0, tab);
    return this.snapshot();
  }

  get(id?: BrowserTabId): BrowserTab | null {
    const wanted = id || this.activeId;
    return this.tabs.find((tab) => tab.id === wanted) ?? null;
  }

  reset(): void {
    this.tabs.splice(0, this.tabs.length);
    this.activeId = '';
    this.closedTabs = [];
  }
}
