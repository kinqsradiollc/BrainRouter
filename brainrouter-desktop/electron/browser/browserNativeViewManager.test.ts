import assert from 'node:assert/strict';
import test from 'node:test';
import type { WebContents, WebContentsView } from 'electron';
import {
  BrowserNativeViewManager,
  type BrowserNativeViewHost,
} from './browserNativeViewManager.js';
import type { BrowserTab } from './protocol.js';

interface FakeContents {
  id: number;
  destroyed: boolean;
  listeners: Map<string, Array<(...args: unknown[]) => void>>;
  debugger: {
    listeners: Map<string, Array<(...args: unknown[]) => void>>;
    on(event: string, listener: (...args: unknown[]) => void): void;
    emit(event: string, ...args: unknown[]): void;
  };
  windowOpenHandler?: (details: unknown) => unknown;
  close(): void;
  emit(event: string, ...args: unknown[]): void;
  isDestroyed(): boolean;
  on(event: string, listener: (...args: unknown[]) => void): void;
  setWindowOpenHandler(handler: (details: unknown) => unknown): void;
}

interface FakeView {
  webContents: FakeContents;
  backgrounds: string[];
  bounds: Array<{ x: number; y: number; width: number; height: number }>;
  setBackgroundColor(value: string): void;
  setBounds(value: { x: number; y: number; width: number; height: number }): void;
}

function fakeTab(id: string): BrowserTab {
  return {
    id,
    url: 'https://example.test/',
    title: 'Example',
    faviconUrl: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    crashed: false,
    audible: false,
    muted: false,
    zoomFactor: 1,
    revision: 0,
    lastAccessedAt: 1,
  };
}

function fixture(): {
  manager: BrowserNativeViewManager;
  views: FakeView[];
  attached: FakeView[];
  detached: FakeView[];
} {
  const views: FakeView[] = [];
  const attached: FakeView[] = [];
  const detached: FakeView[] = [];
  const host: BrowserNativeViewHost = {
    createView: () => {
      const debuggerListeners = new Map<
        string,
        Array<(...args: unknown[]) => void>
      >();
      const contents: FakeContents = {
        id: views.length + 1,
        destroyed: false,
        listeners: new Map(),
        debugger: {
          listeners: debuggerListeners,
          on(event, listener) {
            const rows = debuggerListeners.get(event) ?? [];
            rows.push(listener);
            debuggerListeners.set(event, rows);
          },
          emit(event, ...args) {
            for (const listener of debuggerListeners.get(event) ?? []) {
              listener(...args);
            }
          },
        },
        close() { this.destroyed = true; },
        emit(event, ...args) {
          for (const listener of this.listeners.get(event) ?? []) {
            listener(...args);
          }
        },
        isDestroyed() { return this.destroyed; },
        on(event, listener) {
          const rows = this.listeners.get(event) ?? [];
          rows.push(listener);
          this.listeners.set(event, rows);
        },
        setWindowOpenHandler(handler) {
          this.windowOpenHandler = handler;
        },
      };
      const view: FakeView = {
        webContents: contents,
        backgrounds: [],
        bounds: [],
        setBackgroundColor(value) { this.backgrounds.push(value); },
        setBounds(value) { this.bounds.push(value); },
      };
      views.push(view);
      return view as unknown as WebContentsView;
    },
    attachView: (view) => { attached.push(view as unknown as FakeView); },
    detachView: (view) => { detached.push(view as unknown as FakeView); },
  };
  return {
    manager: new BrowserNativeViewManager(host),
    views,
    attached,
    detached,
  };
}

test('native view manager owns allocation, registration, and console bounds', () => {
  const { manager, views } = fixture();
  const created = manager.create('persist:workspace', () => fakeTab('tab-1'));

  assert.equal(created.contents.id, 1);
  assert.equal(manager.requireContents('tab-1').id, 1);
  assert.equal(manager.tabIdForContents(1), 'tab-1');
  assert.deepEqual(views[0].backgrounds, ['#ffffff']);

  for (let index = 0; index < 305; index += 1) {
    manager.recordConsole('tab-1', {
      level: 'info',
      text: String(index),
      source: '',
      line: 0,
      at: index,
    });
  }
  const rows = manager.consoleEntries('tab-1');
  assert.equal(rows.length, 300);
  assert.equal(rows[0]?.text, '5');
  manager.clearConsole('tab-1');
  assert.deepEqual(manager.consoleEntries('tab-1'), []);
});

test('native attachment reuses the active view and detaches only on change', () => {
  const { manager, views, attached, detached } = fixture();
  manager.create('persist:workspace', () => fakeTab('tab-1'));
  manager.create('persist:workspace', () => fakeTab('tab-2'));
  const surface = { x: 10, y: 20, width: 800, height: 600, visible: true };

  manager.attach('tab-1', surface);
  manager.attach('tab-1', { ...surface, width: 700 });
  assert.equal(attached.length, 1);
  assert.equal(detached.length, 0);
  assert.equal(views[0].bounds.length, 2);

  manager.attach('tab-2', surface);
  assert.equal(attached.length, 2);
  assert.deepEqual(detached, [views[0]]);

  manager.attach('tab-2', { ...surface, visible: false });
  assert.deepEqual(detached, [views[0], views[1]]);
});

test('native event wiring preserves host callback order and popup policy', () => {
  const { manager, views } = fixture();
  manager.create('persist:workspace', () => fakeTab('tab-1'));
  const calls: string[] = [];
  manager.wire('tab-1', {
    gate: (_event, url) => { calls.push(`gate:${url}`); },
    updateNavigation: () => { calls.push('navigate'); },
    startLoading: () => { calls.push('loading'); },
    stopLoading: () => { calls.push('loaded'); },
    updateTitle: (title) => { calls.push(`title:${title}`); },
    updateFavicons: () => undefined,
    mediaStarted: () => undefined,
    enterHtmlFullScreen: () => {},
    leaveHtmlFullScreen: () => {},
    mediaPaused: () => undefined,
    renderProcessGone: () => undefined,
    loadFailed: () => undefined,
    consoleMessage: () => undefined,
    beforeInput: () => { calls.push('input'); },
    beforeMouse: () => undefined,
    contextMenu: () => undefined,
    login: () => undefined,
    certificateError: () => undefined,
    debuggerMessage: (method) => { calls.push(`debugger:${method}`); },
    initializeDebugger: () => { calls.push('initialize-debugger'); },
    openWindow: (details) => {
      calls.push(`popup:${details.url}`);
      return { action: 'deny' };
    },
  });

  const contents = views[0].webContents;
  const event = { preventDefault() {} };
  contents.emit('will-navigate', event, 'https://next.test/');
  contents.emit('did-navigate', event);
  contents.emit('did-start-loading');
  contents.emit('page-title-updated', event, 'Next');
  contents.emit('before-input-event', event, {});
  contents.debugger.emit('message', event, 'Page.dialog', {});
  contents.windowOpenHandler?.({ url: 'https://popup.test/' });

  assert.deepEqual(calls, [
    'initialize-debugger',
    'gate:https://next.test/',
    'navigate',
    'loading',
    'title:Next',
    'input',
    'debugger:Page.dialog',
    'popup:https://popup.test/',
  ]);
});

test('native destruction invokes cleanup before closing and removes lookup state', () => {
  const { manager, views } = fixture();
  manager.create('persist:workspace', () => fakeTab('tab-1'));
  const order: string[] = [];

  manager.destroy('tab-1', (contents: WebContents) => {
    order.push(contents.isDestroyed() ? 'closed' : 'cleanup');
  });
  order.push(views[0].webContents.destroyed ? 'closed' : 'open');

  assert.deepEqual(order, ['cleanup', 'closed']);
  assert.equal(manager.contents('tab-1'), null);
  assert.equal(manager.tabIdForContents(1), null);
});

test('failed tab registration closes the allocated native view', () => {
  const { manager, views } = fixture();
  assert.throws(
    () => manager.create('persist:workspace', () => {
      throw new Error('tab state rejected');
    }),
    /tab state rejected/,
  );
  assert.equal(views[0].webContents.destroyed, true);
  assert.equal(manager.tabIdForContents(1), null);
});
