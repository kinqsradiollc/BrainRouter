import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  buildHttpAuthPromptHtml,
  createHttpAuthPromptBroker,
  normalizeHttpAuthDisplayDetails,
  type HttpAuthPromptRuntime,
  type HttpAuthPromptWindow,
} from './httpAuthPrompt.js';

test('HTTP auth display details expose only a bounded origin and escaped realm text', () => {
  const details = normalizeHttpAuthDisplayDetails({
    origin: 'https://user:password@example.com/private?token=secret#fragment',
    realm: `<img src=x onerror=alert(1)>${'x'.repeat(400)}`,
  });

  assert.equal(details.origin, 'https://example.com');
  assert.equal(details.realm.length, 200);
  assert.match(details.realm, /^<img src=x onerror=alert\(1\)>/);
  assert.equal(normalizeHttpAuthDisplayDetails({ origin: 'not a URL' }).origin, 'this site');
});

test('HTTP auth prompt HTML has a closed CSP and treats server text as text', () => {
  const html = buildHttpAuthPromptHtml({
    origin: 'https://example.com',
    realm: '<script>steal()</script>',
  });

  assert.match(html, /default-src &#39;none&#39;/);
  assert.match(html, /script-src &#39;none&#39;/);
  assert.doesNotMatch(html, /<script>steal\(\)<\/script>/);
  assert.match(html, /&lt;script&gt;steal\(\)&lt;\/script&gt;/);
  assert.match(html, /type="password"/);
  assert.match(html, /autocomplete="current-password"/);
});

test('dedicated auth preload exposes no application-renderer capability surface', () => {
  const testDirectory = dirname(fileURLToPath(import.meta.url));
  const preloadPath = ['httpAuthPromptPreload.cts', 'httpAuthPromptPreload.cjs']
    .map((name) => join(testDirectory, name))
    .find(existsSync);
  assert.ok(preloadPath);
  const source = readFileSync(preloadPath, 'utf8');
  assert.match(source, /authIpcRenderer\.send\(channel/);
  assert.match(source, /validChannel && validToken/);
  assert.doesNotMatch(source, /contextBridge|exposeInMainWorld|agent-command|browser:command/);
  assert.doesNotMatch(source, /console\.|localStorage|sessionStorage/);
});

class FakePromptWebContents extends EventEmitter {
  readonly id = 42;
  readonly mainFrame = {};
  windowOpenHandler: (() => { action: 'deny' }) | null = null;

  setWindowOpenHandler(handler: () => { action: 'deny' }): void {
    this.windowOpenHandler = handler;
  }
}

class FakePromptWindow extends EventEmitter {
  readonly webContents = new FakePromptWebContents();
  destroyed = false;
  shown = false;
  loadedUrl = '';

  async loadURL(url: string): Promise<void> { this.loadedUrl = url; }
  show(): void { this.shown = true; }
  focus(): void { /* no-op */ }
  isDestroyed(): boolean { return this.destroyed; }
  setMenuBarVisibility(_visible: boolean): void { /* no-op */ }
  setMenu(_menu: null): void { /* no-op */ }
  close(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('closed');
  }
}

class FakeParentWindow extends EventEmitter {
  destroyed = false;
  isDestroyed(): boolean { return this.destroyed; }
}

function createHarness() {
  const listeners = new Map<string, Parameters<HttpAuthPromptRuntime['onIpc']>[1]>();
  let promptWindow: FakePromptWindow | null = null;
  let windowOptions: Parameters<HttpAuthPromptRuntime['createWindow']>[0] | null = null;
  let timeout: (() => void) | null = null;
  const runtime: HttpAuthPromptRuntime = {
    preloadPath: '/app/httpAuthPromptPreload.cjs',
    createPromptId: () => '00000000-0000-4000-8000-000000000001',
    createToken: () => 'a'.repeat(64),
    createWindow(options) {
      windowOptions = options;
      promptWindow = new FakePromptWindow();
      return promptWindow as unknown as HttpAuthPromptWindow;
    },
    onIpc(channel, listener) { listeners.set(channel, listener); },
    removeIpcListener(channel, listener) {
      if (listeners.get(channel) === listener) listeners.delete(channel);
    },
    scheduleTimeout(handler) {
      timeout = handler;
      return () => { timeout = null; };
    },
  };
  return {
    broker: createHttpAuthPromptBroker(runtime),
    parent: new FakeParentWindow(),
    getWindow: () => promptWindow,
    getWindowOptions: () => windowOptions,
    getTimeout: () => timeout,
    listeners,
  };
}

test('HTTP auth broker creates an isolated modal and accepts one sender-bound response', async () => {
  const harness = createHarness();
  const result = harness.broker(
    harness.parent as never,
    { origin: 'https://example.com/private', realm: 'Members' },
  );
  const promptWindow = harness.getWindow();
  const options = harness.getWindowOptions();
  assert.ok(promptWindow);
  assert.ok(options);
  assert.equal(options.parent, harness.parent);
  assert.equal(options.modal, true);
  assert.equal(options.show, false);
  assert.equal(options.webPreferences?.sandbox, true);
  assert.equal(options.webPreferences?.contextIsolation, true);
  assert.equal(options.webPreferences?.nodeIntegration, false);
  assert.equal(options.webPreferences?.webSecurity, true);
  assert.equal(options.webPreferences?.devTools, false);
  assert.equal(options.webPreferences?.preload, '/app/httpAuthPromptPreload.cjs');
  assert.deepEqual(options.webPreferences?.additionalArguments, [
    '--brainrouter-http-auth-channel=brainrouter:http-auth:00000000-0000-4000-8000-000000000001',
    `--brainrouter-http-auth-token=${'a'.repeat(64)}`,
  ]);
  assert.deepEqual(promptWindow.webContents.windowOpenHandler?.(), { action: 'deny' });

  const [channel, listener] = [...harness.listeners.entries()][0] ?? [];
  assert.ok(channel);
  assert.ok(listener);
  listener({ sender: {}, senderFrame: {} }, {
    token: 'a'.repeat(64), action: 'submit', username: 'wrong', password: 'sender',
  });
  assert.equal(promptWindow.destroyed, false);
  listener({ sender: promptWindow.webContents, senderFrame: promptWindow.webContents.mainFrame }, {
    token: 'a'.repeat(64), action: 'submit', username: 'alice', password: 'correct horse',
  });

  assert.deepEqual(await result, { username: 'alice', password: 'correct horse' });
  assert.equal(promptWindow.destroyed, true);
  assert.equal(harness.listeners.size, 0);
});

test('HTTP auth broker fails closed on abort, window close, and timeout', async () => {
  for (const cancel of ['abort', 'parent-close', 'prompt-close', 'timeout'] as const) {
    const harness = createHarness();
    const controller = new AbortController();
    const result = harness.broker(
      harness.parent as never,
      { origin: 'https://example.com' },
      { signal: controller.signal },
    );
    if (cancel === 'abort') controller.abort();
    if (cancel === 'parent-close') harness.parent.emit('closed');
    if (cancel === 'prompt-close') harness.getWindow()?.close();
    if (cancel === 'timeout') harness.getTimeout()?.();
    assert.equal(await result, null, cancel);
    assert.equal(harness.getWindow()?.destroyed, true, cancel);
    assert.equal(harness.listeners.size, 0, cancel);
  }
});
