/**
 * Native browser view ownership.
 *
 * The manager owns allocation, tab-to-WebContents registration, console
 * buffers, surface attachment, and deterministic destruction. Electron window
 * operations stay behind an injected host so lifecycle policy remains
 * independently testable.
 */
import type {
  AuthInfo,
  Certificate,
  ContextMenuParams,
  Event as ElectronEvent,
  HandlerDetails,
  Input,
  LoginAuthenticationResponseDetails,
  WebContents,
  WebContentsConsoleMessageEventParams,
  WebContentsView,
  WindowOpenHandlerResponse,
} from 'electron';
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

export interface BrowserNativeViewEventHandlers {
  gate(event: { preventDefault(): void }, url: string): void;
  updateNavigation(): void;
  startLoading(): void;
  stopLoading(): void;
  updateTitle(title: string): void;
  updateFavicons(favicons: string[]): void;
  mediaStarted(): void;
  /** ADR-055 P10 — HTML5 fullscreen (a video going full-window). */
  enterHtmlFullScreen(): void;
  leaveHtmlFullScreen(): void;
  mediaPaused(): void;
  renderProcessGone(reason: string): void;
  loadFailed(
    code: number,
    description: string,
    validatedUrl: string,
    isMainFrame: boolean,
  ): void;
  consoleMessage(
    details: ElectronEvent<WebContentsConsoleMessageEventParams>,
  ): void;
  beforeInput(event: { preventDefault(): void }, input: Input): void;
  beforeMouse(event: { preventDefault(): void }): void;
  contextMenu(params: ContextMenuParams): void;
  login(
    event: { preventDefault(): void },
    details: LoginAuthenticationResponseDetails,
    authInfo: AuthInfo,
    callback: (username?: string, password?: string) => void,
  ): void;
  certificateError(
    event: { preventDefault(): void },
    url: string,
    error: string,
    certificate: Certificate,
    callback: (isTrusted: boolean) => void,
    isMainFrame: boolean,
  ): void;
  debuggerMessage(method: string, params: unknown): void;
  initializeDebugger(contents: WebContents): void;
  openWindow(details: HandlerDetails): WindowOpenHandlerResponse;
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

  wire(tabId: BrowserTabId, handlers: BrowserNativeViewEventHandlers): void {
    const contents = this.requireContents(tabId);
    contents.on('will-navigate', handlers.gate);
    contents.on('will-redirect', handlers.gate);
    contents.on('did-navigate', handlers.updateNavigation);
    contents.on('did-navigate-in-page', handlers.updateNavigation);
    contents.on('did-start-loading', handlers.startLoading);
    contents.on('did-stop-loading', handlers.stopLoading);
    contents.on('page-title-updated', (_event, title) => {
      handlers.updateTitle(title);
    });
    contents.on('page-favicon-updated', (_event, favicons) => {
      handlers.updateFavicons(favicons);
    });
    contents.on('media-started-playing', handlers.mediaStarted);
    contents.on('enter-html-full-screen', handlers.enterHtmlFullScreen);
    contents.on('leave-html-full-screen', handlers.leaveHtmlFullScreen);
    contents.on('media-paused', handlers.mediaPaused);
    contents.on('render-process-gone', (_event, details) => {
      handlers.renderProcessGone(details.reason);
    });
    contents.on(
      'did-fail-load',
      (_event, code, description, validatedUrl, isMainFrame) => {
        handlers.loadFailed(
          code,
          description,
          validatedUrl,
          isMainFrame,
        );
      },
    );
    contents.on('console-message', (details) => {
      handlers.consoleMessage(details);
    });
    contents.on('before-input-event', handlers.beforeInput);
    contents.on('before-mouse-event', (event) => {
      handlers.beforeMouse(event);
    });
    contents.on('context-menu', (_event, params) => {
      handlers.contextMenu(params);
    });
    contents.on(
      'login',
      (event, details, authInfo, callback) => {
        handlers.login(event, details, authInfo, callback);
      },
    );
    contents.on(
      'certificate-error',
      (event, url, error, certificate, callback, isMainFrame) => {
        handlers.certificateError(
          event,
          url,
          error,
          certificate,
          callback,
          isMainFrame,
        );
      },
    );
    contents.debugger.on('message', (_event, method, params) => {
      handlers.debuggerMessage(method, params);
    });
    handlers.initializeDebugger(contents);
    contents.setWindowOpenHandler(handlers.openWindow);
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
