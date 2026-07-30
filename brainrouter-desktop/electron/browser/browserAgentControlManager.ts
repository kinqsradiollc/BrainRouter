/**
 * A25-6b5 — session-scoped agent authority for the window-owned browser.
 *
 * This manager owns chat/tab attribution, request cancellation, exact-visible
 * tab leases, and the shared visible-operation FIFO. Electron window/process
 * mechanics stay behind injected ports so the authority and event-order rules
 * are testable without starting Electron.
 */
import {
  BROWSER_CONTROL_PROTOCOL_VERSION,
  type BrowserControlCommand,
  type BrowserControlErrorCode,
  type BrowserControlRequestMessage,
  type BrowserControlResult,
} from '@kinqs/brainrouter-core/browser';
import {
  executeAgentBrowserCommand,
  type BrowserManagerPort,
} from './browserAgentAdapter.js';
import {
  browserCommandTabId,
  commandRequiresOwnedTab,
  scopedBrowserState,
  scopedBrowserTarget,
} from './browserSessionScope.js';
import { shouldBypassAgentVisibleQueue } from './visibleQueuePolicy.js';
import type { BrowserState } from './protocol.js';

const BACKGROUND_BROWSER_COMMANDS = new Set<BrowserControlCommand['kind']>([
  'capabilities',
  'tabs.list',
  'page.state',
  'page.snapshot',
  'page.screenshot',
  'page.console',
  'page.network',
  'page.downloads',
  'page.wait',
]);

export interface BrowserAgentControlHost {
  postMessage(message: unknown): void;
}

export interface BrowserAgentControlWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  show(): void;
  focus(): void;
  requestSurface(command: string, generation: number): void;
}

export interface BrowserAgentControlBrowser extends BrowserManagerPort {
  pinVisibleTab(tabId: string): () => void;
  isTabVisible(tabId: string): boolean;
  waitForRequestSettlement(requestId: string): Promise<void>;
}

export interface BrowserAgentControlManagerOptions {
  browser: BrowserAgentControlBrowser;
  window: BrowserAgentControlWindow;
  isWorkspaceOwner(host: BrowserAgentControlHost, workspaceRoot: string): boolean;
  surfaceTimeoutMs?: number;
}

function commandNeedsVisibleSurface(kind: BrowserControlCommand['kind']): boolean {
  return !BACKGROUND_BROWSER_COMMANDS.has(kind);
}

function pinCommand(command: BrowserControlCommand, tabId?: string): BrowserControlCommand {
  if (!tabId || (!command.kind.startsWith('page.') && command.kind !== 'dialog.respond')) return command;
  return { ...command, tabId } as BrowserControlCommand;
}

function errorDetails(error: unknown, signal: AbortSignal): {
  code: BrowserControlErrorCode;
  message: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  if (signal.aborted || message === 'BROWSER_ABORTED') {
    return { code: 'aborted', message: 'Browser control was cancelled.' };
  }
  if (message === 'BROWSER_OWNERSHIP_CHANGED') {
    return {
      code: 'ownership_mismatch',
      message: 'Browser control no longer belongs to the active workspace.',
    };
  }
  if (message === 'BROWSER_TAB_NOT_FOUND') {
    return { code: 'not_found', message: 'The requested browser tab no longer exists.' };
  }
  if (message === 'BROWSER_SURFACE_UNAVAILABLE') {
    return {
      code: 'unavailable',
      message: 'The visible Browser panel did not acknowledge fresh bounds in time.',
    };
  }
  if (message === 'BROWSER_TAB_NOT_VISIBLE') {
    return { code: 'unavailable', message: 'The requested browser tab is not the visible in-app tab.' };
  }
  return { code: 'internal', message };
}

export class BrowserAgentControlManager {
  private readonly browser: BrowserAgentControlBrowser;
  private readonly window: BrowserAgentControlWindow;
  private readonly isWorkspaceOwner: BrowserAgentControlManagerOptions['isWorkspaceOwner'];
  private readonly surfaceTimeoutMs: number;
  private workspaceGeneration = 0;
  private visibleQueue: Promise<void> = Promise.resolve();
  private surfaceSequence = 0;
  private readonly pendingSurfaceRequests = new Map<number, (visible: boolean) => void>();
  private readonly pendingByHost = new Map<BrowserAgentControlHost, Map<string, AbortController>>();
  private readonly activeVisibleControllers = new Set<AbortController>();
  private readonly tabsByWorkspaceAndSession = new Map<string, Map<string, Set<string>>>();
  private disposed = false;

  constructor(options: BrowserAgentControlManagerOptions) {
    this.browser = options.browser;
    this.window = options.window;
    this.isWorkspaceOwner = options.isWorkspaceOwner;
    this.surfaceTimeoutMs = Math.max(1, options.surfaceTimeoutMs ?? 2_500);
  }

  get generation(): number {
    return this.workspaceGeneration;
  }

  isGenerationCurrent(generation: number): boolean {
    return !this.disposed && generation === this.workspaceGeneration;
  }

  enqueueVisibleOperation<T>(operation: () => Promise<T>): Promise<T> {
    const before = this.visibleQueue.catch(() => undefined);
    let release!: () => void;
    const latch = new Promise<void>((resolve) => { release = resolve; });
    const chain = before.then(() => latch);
    this.visibleQueue = chain;
    return before.then(async () => {
      try {
        return await operation();
      } finally {
        release();
        if (this.visibleQueue === chain) this.visibleQueue = Promise.resolve();
      }
    });
  }

  acknowledgeSurface(generation: number, visible: boolean): void {
    this.pendingSurfaceRequests.get(generation)?.(visible);
  }

  handleUserTakeover(): void {
    for (const controller of this.activeVisibleControllers) controller.abort();
  }

  invalidateWorkspace(): void {
    this.workspaceGeneration += 1;
    for (const requests of this.pendingByHost.values()) {
      for (const controller of requests.values()) controller.abort();
    }
    this.cancelPendingSurfaceRequests();
  }

  releaseHost(host: BrowserAgentControlHost): void {
    const requests = this.pendingByHost.get(host);
    if (!requests) return;
    for (const controller of requests.values()) controller.abort();
    this.pendingByHost.delete(host);
  }

  cancelRequest(host: BrowserAgentControlHost, requestId: string): void {
    this.pendingByHost.get(host)?.get(requestId)?.abort();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.workspaceGeneration += 1;
    for (const host of [...this.pendingByHost.keys()]) this.releaseHost(host);
    this.cancelPendingSurfaceRequests();
    this.tabsByWorkspaceAndSession.clear();
  }

  async handleRequest(
    host: BrowserAgentControlHost,
    workspaceRoot: string,
    request: BrowserControlRequestMessage,
  ): Promise<void> {
    if (this.disposed || this.window.isDestroyed()) {
      this.postError(host, request.id, 'closed', 'The owning desktop window is closed.');
      return;
    }
    const sessionKey = request.sessionKey?.trim();
    if (!sessionKey) {
      this.postError(host, request.id, 'ownership_mismatch', 'Browser control requires an owning chat session.');
      return;
    }
    if (!this.isWorkspaceOwner(host, workspaceRoot)) {
      this.postError(host, request.id, 'ownership_mismatch', 'Browser control belongs to the active workspace window only.');
      return;
    }

    const workspaceGeneration = this.workspaceGeneration;
    const ownedTabs = this.ownedTabs(workspaceRoot, sessionKey);
    if (request.command.kind === 'tabs.reopen') {
      this.postError(
        host,
        request.id,
        'permission_denied',
        'Reopening a workspace browser tab is unavailable to agents; open its URL in a new tab.',
      );
      return;
    }
    const explicitTabId = browserCommandTabId(request.command);
    if (explicitTabId && !ownedTabs.has(explicitTabId)) {
      this.postError(
        host,
        request.id,
        'ownership_mismatch',
        'The requested browser tab belongs to another chat or to the user.',
      );
      return;
    }
    const state = this.browser.getState();
    const targetTabId = scopedBrowserTarget(request.command, state, ownedTabs);
    if (commandRequiresOwnedTab(request.command) && !targetTabId) {
      this.postError(
        host,
        request.id,
        'not_found',
        'This chat has no browser tab for that operation. Open a new tab first.',
      );
      return;
    }

    const byId = this.pendingByHost.get(host) ?? new Map<string, AbortController>();
    this.pendingByHost.set(host, byId);
    if (byId.has(request.id)) {
      this.postError(host, request.id, 'invalid_request', 'Duplicate browser request id.');
      return;
    }

    const pinnedRequest: BrowserControlRequestMessage = {
      ...request,
      command: pinCommand(request.command, targetTabId),
    };
    const controller = new AbortController();
    byId.set(request.id, controller);
    const needsVisibleSurface = commandNeedsVisibleSurface(pinnedRequest.command.kind);
    if (needsVisibleSurface) this.activeVisibleControllers.add(controller);

    try {
      const execute = async (recoveryLane = false): Promise<BrowserControlResult> => {
        this.assertOwnership(host, workspaceRoot, workspaceGeneration);
        let releaseVisiblePin: (() => void) | undefined;
        try {
          if (needsVisibleSurface && !recoveryLane) {
            if (targetTabId && !this.hasTab(targetTabId)) throw new Error('BROWSER_TAB_NOT_FOUND');
            if (!this.window.isVisible()) this.window.show();
            this.window.focus();
            if (targetTabId) releaseVisiblePin = this.browser.pinVisibleTab(targetTabId);
            if (!await this.requestFreshSurface(pinnedRequest.command.kind, controller.signal)) {
              throw new Error(controller.signal.aborted ? 'BROWSER_ABORTED' : 'BROWSER_SURFACE_UNAVAILABLE');
            }
            if (targetTabId && !this.browser.isTabVisible(targetTabId)) throw new Error('BROWSER_TAB_NOT_VISIBLE');
          } else if (recoveryLane && (!targetTabId || !this.browser.isTabVisible(targetTabId))) {
            throw new Error('BROWSER_TAB_NOT_VISIBLE');
          }
          this.assertOwnership(host, workspaceRoot, workspaceGeneration);
          const scopedManager: BrowserManagerPort = {
            getState: () => scopedBrowserState(this.browser.getState(), ownedTabs),
            execute: this.browser.execute.bind(this.browser),
          };
          const result = await executeAgentBrowserCommand(
            scopedManager,
            pinnedRequest,
            workspaceRoot,
            controller.signal,
          );
          this.assertOwnership(host, workspaceRoot, workspaceGeneration);
          if (result.ok && request.command.kind === 'tabs.open' && result.tabId) {
            ownedTabs.add(result.tabId);
          }
          if (result.ok && request.command.kind === 'tabs.close' && targetTabId) {
            ownedTabs.delete(targetTabId);
          }
          return result;
        } finally {
          // Cancellation may resolve the bounded adapter before Chromium has
          // finished its raw operation. The exact tab remains pinned until that
          // work settles, preventing a late input from landing on another tab.
          await this.browser.waitForRequestSettlement(request.id);
          releaseVisiblePin?.();
        }
      };

      const recoveryLane = shouldBypassAgentVisibleQueue(
        pinnedRequest.command.kind,
        Boolean(targetTabId && this.browser.isTabVisible(targetTabId)),
      );
      const result = recoveryLane
        ? await execute(true)
        : needsVisibleSurface
          ? await this.enqueueVisibleOperation(execute)
          : await execute();
      this.assertOwnership(host, workspaceRoot, workspaceGeneration);
      this.postSuccess(host, request.id, result);
    } catch (error) {
      const details = errorDetails(error, controller.signal);
      this.postError(host, request.id, details.code, details.message);
    } finally {
      byId.delete(request.id);
      if (byId.size === 0) this.pendingByHost.delete(host);
      this.activeVisibleControllers.delete(controller);
    }
  }

  private ownedTabs(workspaceRoot: string, sessionKey: string): Set<string> {
    const bySession = this.tabsByWorkspaceAndSession.get(workspaceRoot) ?? new Map<string, Set<string>>();
    this.tabsByWorkspaceAndSession.set(workspaceRoot, bySession);
    const tabs = bySession.get(sessionKey) ?? new Set<string>();
    bySession.set(sessionKey, tabs);
    return tabs;
  }

  private hasTab(tabId: string): boolean {
    return this.browser.getState().tabs.some((tab) => tab.id === tabId);
  }

  private assertOwnership(
    host: BrowserAgentControlHost,
    workspaceRoot: string,
    generation: number,
  ): void {
    if (
      this.disposed
      || this.window.isDestroyed()
      || generation !== this.workspaceGeneration
      || !this.isWorkspaceOwner(host, workspaceRoot)
    ) {
      throw new Error('BROWSER_OWNERSHIP_CHANGED');
    }
  }

  private async requestFreshSurface(
    command: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (signal.aborted || this.disposed || this.window.isDestroyed()) return false;
    const generation = ++this.surfaceSequence;
    const acknowledged = new Promise<boolean>((resolve) => {
      this.pendingSurfaceRequests.set(generation, resolve);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      this.window.requestSurface(command, generation);
      return await Promise.race([
        acknowledged,
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), this.surfaceTimeoutMs);
        }),
        new Promise<boolean>((resolve) => {
          abort = () => resolve(false);
          signal.addEventListener('abort', abort, { once: true });
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) signal.removeEventListener('abort', abort);
      this.pendingSurfaceRequests.delete(generation);
    }
  }

  private cancelPendingSurfaceRequests(): void {
    for (const resolve of this.pendingSurfaceRequests.values()) resolve(false);
    this.pendingSurfaceRequests.clear();
  }

  private postSuccess(host: BrowserAgentControlHost, id: string, result: BrowserControlResult): void {
    try {
      host.postMessage({
        kind: 'browser-command-response',
        version: BROWSER_CONTROL_PROTOCOL_VERSION,
        id,
        ok: true,
        result,
      });
    } catch {
      // A utility process may exit between request settlement and publication.
    }
  }

  private postError(
    host: BrowserAgentControlHost,
    id: string,
    code: BrowserControlErrorCode,
    message: string,
  ): void {
    try {
      host.postMessage({
        kind: 'browser-command-response',
        version: BROWSER_CONTROL_PROTOCOL_VERSION,
        id,
        ok: false,
        error: { code, message: message.slice(0, 2_000) },
      });
    } catch {
      // A utility process may already be gone; cancellation remains complete.
    }
  }
}
