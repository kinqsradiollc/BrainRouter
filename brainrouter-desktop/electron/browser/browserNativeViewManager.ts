/**
 * Native browser view ownership.
 *
 * The manager owns allocation, tab-to-WebContents registration, console
 * buffers, surface attachment, and deterministic destruction. Electron window
 * operations stay behind an injected host so lifecycle policy remains
 * independently testable.
 */
import type { WebContents, WebContentsView } from 'electron';
import { BrowserManagerError } from './browserManagerError.js';
import type {
  BrowserConsoleEntry,
  BrowserSurface,
  BrowserTab,
  BrowserTabId,
} from './protocol.js';

const MAX_CONSOLE_ROWS = 300;

interface BrowserNativeViewRecord {
  view: WebContentsView;
  console: BrowserConsoleEntry[];
}

export interface BrowserNativeViewHost {
  createView(partition: string): WebContentsView;
  attachView(view: WebContentsView): void;
  detachView(view: WebContentsView): void;
}

export class BrowserNativeViewManager {
  private readonly records = new Map<BrowserTabId, BrowserNativeViewRecord>();
  private attachedViewId: BrowserTabId | null = null;

  constructor(private readonly host: BrowserNativeViewHost) {}

  create(
    partition: string,
    createTab: () => BrowserTab,
  ): { tab: BrowserTab; contents: WebContents } {
    const view = this.host.createView(partition);
    view.setBackgroundColor('#ffffff');
    let tab: BrowserTab;
    try {
      tab = createTab();
    } catch (error) {
      if (!view.webContents.isDestroyed()) view.webContents.close();
      throw error;
    }
    this.records.set(tab.id, { view, console: [] });
    return { tab, contents: view.webContents };
  }

  contents(tabId: BrowserTabId): WebContents | null {
    return this.records.get(tabId)?.view.webContents ?? null;
  }

  requireContents(tabId: BrowserTabId): WebContents {
    const contents = this.contents(tabId);
    if (!contents || contents.isDestroyed()) {
      throw new BrowserManagerError(
        'TAB_NOT_FOUND',
        `Browser tab ${tabId} is closed.`,
      );
    }
    return contents;
  }

  tabIdForContents(contentsId: number): BrowserTabId | null {
    for (const [tabId, record] of this.records) {
      if (record.view.webContents.id === contentsId) return tabId;
    }
    return null;
  }

  consoleEntries(tabId: BrowserTabId): BrowserConsoleEntry[] {
    return [...(this.records.get(tabId)?.console ?? [])];
  }

  clearConsole(tabId: BrowserTabId): void {
    const record = this.records.get(tabId);
    if (record) record.console = [];
  }

  recordConsole(tabId: BrowserTabId, entry: BrowserConsoleEntry): void {
    const record = this.records.get(tabId);
    if (!record) return;
    record.console.push(entry);
    if (record.console.length > MAX_CONSOLE_ROWS) {
      record.console.splice(0, record.console.length - MAX_CONSOLE_ROWS);
    }
  }

  isTabVisible(
    tabId: BrowserTabId,
    activeTabId: BrowserTabId,
    surface: BrowserSurface,
  ): boolean {
    const contents = this.contents(tabId);
    return activeTabId === tabId
      && surface.visible
      && surface.width > 1
      && surface.height > 1
      && Boolean(contents && !contents.isDestroyed());
  }

  attach(activeTabId: BrowserTabId, surface: BrowserSurface): void {
    const active = this.records.get(activeTabId);
    const shouldAttach = Boolean(
      active
      && surface.visible
      && surface.width > 0
      && surface.height > 0
      && !active.view.webContents.isDestroyed(),
    );
    const wantedId = shouldAttach ? activeTabId : null;

    if (this.attachedViewId && this.attachedViewId !== wantedId) {
      const previous = this.records.get(this.attachedViewId);
      if (previous) {
        try {
          this.host.detachView(previous.view);
        } catch {
          // The native view may already be detached during window teardown.
        }
      }
      this.attachedViewId = null;
    }

    if (!shouldAttach || !active) return;
    active.view.setBounds({
      x: surface.x,
      y: surface.y,
      width: surface.width,
      height: surface.height,
    });
    if (this.attachedViewId !== activeTabId) {
      this.host.attachView(active.view);
      this.attachedViewId = activeTabId;
    }
  }

  destroy(
    tabId: BrowserTabId,
    beforeClose?: (contents: WebContents) => void,
  ): void {
    const record = this.records.get(tabId);
    if (!record) return;
    try {
      this.host.detachView(record.view);
    } catch {
      // The view may already be detached.
    }
    if (this.attachedViewId === tabId) this.attachedViewId = null;
    beforeClose?.(record.view.webContents);
    if (!record.view.webContents.isDestroyed()) record.view.webContents.close();
    this.records.delete(tabId);
  }

  destroyAll(
    beforeClose?: (tabId: BrowserTabId, contents: WebContents) => void,
  ): void {
    for (const tabId of [...this.records.keys()]) {
      this.destroy(tabId, (contents) => beforeClose?.(tabId, contents));
    }
  }
}
