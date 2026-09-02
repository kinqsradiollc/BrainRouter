/**
 * A25-6b5 — authority and lifecycle fixtures for agent-controlled browser work.
 *
 * The fakes model the two different completion boundaries: the bounded command
 * result may cancel immediately while the raw Chromium operation settles later.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BROWSER_CONTROL_PROTOCOL_VERSION,
  type BrowserControlCommand,
  type BrowserControlRequestMessage,
} from '@kinqs/brainrouter-core/browser';
import {
  BrowserAgentControlManager,
  type BrowserAgentControlBrowser,
  type BrowserAgentControlHost,
  type BrowserAgentControlWindow,
} from './browserAgentControlManager.js';
import {
  BROWSER_PROTOCOL_VERSION,
  type BrowserCommandRequest,
  type BrowserCommandResult,
  type BrowserState,
  type BrowserTab,
} from './protocol.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function tab(id: string, title = id): BrowserTab {
  return {
    id,
    title,
    url: `https://example.test/${id}`,
    faviconUrl: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    crashed: false,
    audible: false,
    muted: false,
    zoomFactor: 1,
    revision: 1,
    lastAccessedAt: 1,
  };
}

function browserState(): BrowserState {
  return {
    version: BROWSER_PROTOCOL_VERSION,
    activeTabId: 'tab-user',
    tabs: [tab('tab-user', 'User tab')],
    closedTabCount: 0,
    surface: { x: 0, y: 0, width: 800, height: 600, visible: true },
    downloads: [],
    permissionPrompt: null,
    dialogPrompt: null,
    bookmarks: [],
    fullscreenTabId: null,
    capabilities: {
      nativeTabs: true,
      sameVisibleTabAutomation: true,
      downloads: true,
      permissions: true,
      semanticSnapshot: true,
      maxTabs: 50,
    },
  };
}

class FakeHost implements BrowserAgentControlHost {
  readonly messages: Array<Record<string, unknown>> = [];
  postMessage(message: unknown): void {
    this.messages.push(message as Record<string, unknown>);
  }
}

class FakeBrowser implements BrowserAgentControlBrowser {
  state = browserState();
  visibleTabId = 'tab-user';
  readonly calls: BrowserCommandRequest[] = [];
  readonly pins: string[] = [];
  readonly releases: string[] = [];
  readonly blocked = new Map<string, Deferred<void>>();
  private nextTab = 1;

  getState(): BrowserState {
    return {
      ...this.state,
      tabs: this.state.tabs.map((row) => ({ ...row })),
    };
  }

  block(requestId: string): Deferred<void> {
    const settlement = deferred<void>();
    this.blocked.set(requestId, settlement);
    return settlement;
  }

  async execute(
    request: BrowserCommandRequest,
    signal?: AbortSignal,
  ): Promise<BrowserCommandResult> {
    this.calls.push(request);
    const blocked = this.blocked.get(request.id);
    if (blocked) {
      if (!signal?.aborted) {
        await new Promise<void>((resolve) => {
          const onAbort = (): void => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
          };
          signal?.addEventListener('abort', onAbort, { once: true });
        });
      }
      return {
        ok: false,
        requestId: request.id,
        code: 'CANCELLED',
        error: 'Browser command was cancelled.',
        tabId: request.tabId,
        revision: 1,
      };
    }
    if (request.command.op === 'create-tab') {
      const opened = tab(`tab-agent-${this.nextTab++}`);
      this.state.tabs.push(opened);
      if (request.command.active !== false) {
        this.state.activeTabId = opened.id;
        this.visibleTabId = opened.id;
      }
      return {
        ok: true,
        requestId: request.id,
        tabId: this.state.activeTabId,
        revision: this.state.tabs.find((row) => row.id === this.state.activeTabId)?.revision ?? 1,
        value: { ...opened },
      };
    }
    if (request.command.op === 'close-tab') {
      const closing = request.command.tabId ?? request.tabId;
      this.state.tabs = this.state.tabs.filter((row) => row.id !== closing);
      if (this.state.activeTabId === closing) {
        this.state.activeTabId = this.state.tabs[0]?.id ?? '';
        this.visibleTabId = this.state.activeTabId;
      }
    }
    const current = this.state.tabs.find((row) => row.id === (request.tabId ?? this.state.activeTabId));
    return current
      ? {
          ok: true,
          requestId: request.id,
          tabId: current.id,
          revision: current.revision,
          value: { ok: true },
        }
      : {
          ok: false,
          requestId: request.id,
          code: 'TAB_NOT_FOUND',
          error: 'Browser tab was not found.',
        };
  }

  pinVisibleTab(tabId: string): () => void {
    this.pins.push(tabId);
    this.visibleTabId = tabId;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.releases.push(tabId);
    };
  }

  isTabVisible(tabId: string): boolean {
    return this.visibleTabId === tabId;
  }

  async waitForRequestSettlement(requestId: string): Promise<void> {
    await (this.blocked.get(requestId)?.promise ?? Promise.resolve());
  }
}

interface Harness {
  control: BrowserAgentControlManager;
  browser: FakeBrowser;
  window: BrowserAgentControlWindow & {
    surfaceRequests: Array<{ command: string; generation: number }>;
  };
  host: FakeHost;
  otherHost: FakeHost;
  setActive(root: string, host: BrowserAgentControlHost): void;
}

function harness(): Harness {
  const browser = new FakeBrowser();
  const host = new FakeHost();
  const otherHost = new FakeHost();
  let activeRoot = '/workspace/a';
  let activeHost: BrowserAgentControlHost = host;
  let control!: BrowserAgentControlManager;
  const window = {
    surfaceRequests: [] as Array<{ command: string; generation: number }>,
    isDestroyed: () => false,
    isVisible: () => true,
    show: () => undefined,
    focus: () => undefined,
    requestSurface(command: string, generation: number): void {
      this.surfaceRequests.push({ command, generation });
      queueMicrotask(() => control.acknowledgeSurface(generation, true));
    },
  };
  control = new BrowserAgentControlManager({
    browser,
    window,
    isWorkspaceOwner: (candidate, root) => candidate === activeHost && root === activeRoot,
    surfaceTimeoutMs: 100,
  });
  return {
    control,
    browser,
    window,
    host,
    otherHost,
    setActive: (root, owner) => {
      activeRoot = root;
      activeHost = owner;
    },
  };
}

function request(
  id: string,
  sessionKey: string,
  command: BrowserControlCommand,
): BrowserControlRequestMessage {
  return {
    kind: 'browser-command-request',
    version: BROWSER_CONTROL_PROTOCOL_VERSION,
    id,
    sessionKey,
    command,
  };
}

function response(host: FakeHost, id: string): Record<string, unknown> {
  const found = host.messages.find((message) => message.id === id);
  assert.ok(found, `response ${id} must be published`);
  return found;
}

async function openOwnedTab(
  harnessValue: Harness,
  id: string,
  sessionKey: string,
  workspaceRoot = '/workspace/a',
): Promise<string> {
  await harnessValue.control.handleRequest(
    harnessValue.host,
    workspaceRoot,
    request(id, sessionKey, {
      kind: 'tabs.open',
      url: 'https://example.test/agent',
      activate: false,
    }),
  );
  const envelope = response(harnessValue.host, id);
  assert.equal(envelope.ok, true);
  const result = envelope.result as { tabId?: string };
  assert.match(result.tabId ?? '', /^tab-agent-/);
  return result.tabId!;
}

test('A25-6b5 keeps inactive agent tabs owned by their workspace and chat only', async () => {
  const h = harness();
  const owned = await openOwnedTab(h, 'open-a', 'session-a');
  assert.equal(h.browser.state.activeTabId, 'tab-user', 'background creation preserves the user active tab');

  await h.control.handleRequest(
    h.host,
    '/workspace/a',
    request('other-chat', 'session-b', { kind: 'page.state', tabId: owned }),
  );
  assert.equal(response(h.host, 'other-chat').ok, false);
  assert.equal((response(h.host, 'other-chat').error as { code: string }).code, 'ownership_mismatch');

  await h.control.handleRequest(
    h.host,
    '/workspace/a',
    request('user-tab', 'session-a', { kind: 'page.state', tabId: 'tab-user' }),
  );
  assert.equal(response(h.host, 'user-tab').ok, false);
  assert.equal((response(h.host, 'user-tab').error as { code: string }).code, 'ownership_mismatch');

  h.control.invalidateWorkspace();
  h.setActive('/workspace/b', h.otherHost);
  await h.control.handleRequest(
    h.otherHost,
    '/workspace/b',
    request('other-workspace', 'session-a', { kind: 'page.state', tabId: owned }),
  );
  assert.equal(response(h.otherHost, 'other-workspace').ok, false);
});

test('A25-6b5 rejects duplicate in-flight request ids without replacing cancellation authority', async () => {
  const h = harness();
  const owned = await openOwnedTab(h, 'open-duplicate', 'session-a');
  const settlement = h.browser.block('duplicate');
  const first = h.control.handleRequest(
    h.host,
    '/workspace/a',
    request('duplicate', 'session-a', { kind: 'page.snapshot', tabId: owned }),
  );
  await Promise.resolve();
  await h.control.handleRequest(
    h.host,
    '/workspace/a',
    request('duplicate', 'session-a', { kind: 'page.snapshot', tabId: owned }),
  );
  const duplicate = h.host.messages.find(
    (message) => message.id === 'duplicate' && message.ok === false,
  );
  assert.equal((duplicate?.error as { code?: string } | undefined)?.code, 'invalid_request');
  h.control.cancelRequest(h.host, 'duplicate');
  settlement.resolve();
  await first;
});

test('A25-6b5 holds the exact visible pin and FIFO until cancelled raw work settles', async () => {
  const h = harness();
  const owned = await openOwnedTab(h, 'open-visible', 'session-a');
  const firstSettlement = h.browser.block('click-first');
  const first = h.control.handleRequest(
    h.host,
    '/workspace/a',
    request('click-first', 'session-a', {
      kind: 'page.click',
      tabId: owned,
      testId: 'first',
      pageRevision: 1,
    }),
  );
  const second = h.control.handleRequest(
    h.host,
    '/workspace/a',
    request('click-second', 'session-a', {
      kind: 'page.click',
      tabId: owned,
      testId: 'second',
      pageRevision: 1,
    }),
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    h.browser.calls.filter((call) => call.command.op === 'click').map((call) => call.id),
    ['click-first'],
  );
  h.control.cancelRequest(h.host, 'click-first');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(h.browser.releases, [], 'pin remains held while raw work is unsettled');
  assert.deepEqual(
    h.browser.calls.filter((call) => call.command.op === 'click').map((call) => call.id),
    ['click-first'],
    'the next visible operation remains queued',
  );

  firstSettlement.resolve();
  await first;
  await second;
  assert.deepEqual(
    h.browser.calls.filter((call) => call.command.op === 'click').map((call) => call.id),
    ['click-first', 'click-second'],
  );
  assert.deepEqual(h.browser.pins, [owned, owned]);
  assert.deepEqual(h.browser.releases, [owned, owned]);
});

test('A25-6b5 user takeover aborts both the active lease and queued visible work', async () => {
  const h = harness();
  const owned = await openOwnedTab(h, 'open-takeover', 'session-a');
  const settlement = h.browser.block('takeover-active');
  const active = h.control.handleRequest(
    h.host,
    '/workspace/a',
    request('takeover-active', 'session-a', {
      kind: 'page.click',
      tabId: owned,
      testId: 'active',
      pageRevision: 1,
    }),
  );
  const queued = h.control.handleRequest(
    h.host,
    '/workspace/a',
    request('takeover-queued', 'session-a', {
      kind: 'page.click',
      tabId: owned,
      testId: 'queued',
      pageRevision: 1,
    }),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  h.control.handleUserTakeover();
  settlement.resolve();
  await active;
  await queued;
  assert.deepEqual(
    h.browser.calls.filter((call) => call.command.op === 'click').map((call) => call.id),
    ['takeover-active'],
    'queued work is cancelled before it can emit input',
  );
  assert.equal(response(h.host, 'takeover-queued').ok, false);
});

test('A25-6b5 workspace invalidation cancels late work and never publishes a stale success', async () => {
  const h = harness();
  const owned = await openOwnedTab(h, 'open-late', 'session-a');
  const settlement = h.browser.block('late');
  const pending = h.control.handleRequest(
    h.host,
    '/workspace/a',
    request('late', 'session-a', { kind: 'page.snapshot', tabId: owned }),
  );
  await Promise.resolve();
  h.control.invalidateWorkspace();
  h.setActive('/workspace/b', h.otherHost);
  settlement.resolve();
  await pending;
  const late = response(h.host, 'late');
  assert.equal(late.ok, false);
  assert.notEqual((late.error as { code: string }).code, 'internal');
});

test('A25-6b5 background observations do not request or occupy the visible surface', async () => {
  const h = harness();
  const owned = await openOwnedTab(h, 'open-background', 'session-a');
  const surfaceCount = h.window.surfaceRequests.length;
  await h.control.handleRequest(
    h.host,
    '/workspace/a',
    request('snapshot-background', 'session-a', {
      kind: 'page.snapshot',
      tabId: owned,
    }),
  );
  assert.equal(response(h.host, 'snapshot-background').ok, true);
  assert.equal(h.window.surfaceRequests.length, surfaceCount);
});
