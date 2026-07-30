import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserPromptManager, type BrowserPromptManagerHost } from './browserPromptManager.js';
import type { BrowserEvent, BrowserTab } from './protocol.js';

function tab(id = 'tab-one'): BrowserTab {
  return {
    id,
    url: 'https://example.test/page',
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

function harness() {
  const activeTab = tab();
  const events: Array<BrowserEvent | 'state' | `select:${string}` | 'persist'> = [];
  const statuses: string[] = [];
  const host: BrowserPromptManagerHost = {
    tabForContents: (contentsId) => contentsId === 7 ? activeTab : null,
    selectTab: (tabId) => { events.push(`select:${tabId}`); },
    persist: () => { events.push('persist'); },
    emit: (event) => { events.push(event); },
    emitState: () => { events.push('state'); },
    setStatus: (_tab, text) => { statuses.push(text); },
  };
  return { activeTab, events, statuses, host };
}

test('browser prompt manager remembers reviewed geolocation decisions', () => {
  const { events, host } = harness();
  const manager = new BrowserPromptManager(host, 'window');
  const decisions: boolean[] = [];
  manager.requestPermission(
    7,
    'geolocation',
    ['geolocation'],
    'https://example.test/path',
    (allow) => decisions.push(allow),
  );
  const prompt = manager.getPermissionPrompt();
  assert.ok(prompt);
  manager.respondPermission(prompt.id, true);

  assert.deepEqual(decisions, [true]);
  assert.equal(manager.hasPermission('https://example.test/other', ['geolocation']), true);
  assert.deepEqual(manager.persistedPermissions(), [{
    origin: 'https://example.test',
    permission: 'geolocation',
    decision: 'allow',
  }]);
  assert.equal(events.filter((event) => event === 'persist').length, 1);

  manager.requestPermission(
    7,
    'geolocation',
    ['geolocation'],
    'https://example.test/again',
    (allow) => decisions.push(allow),
  );
  assert.deepEqual(decisions, [true, true]);
  assert.equal(manager.getPermissionPrompt(), null);
  manager.dispose();
});

test('browser permission prompting preserves select, event, and state order', () => {
  const { events, host } = harness();
  const manager = new BrowserPromptManager(host, 'window');
  manager.requestPermission(
    7,
    'camera',
    ['media'],
    'https://example.test/',
    () => {},
  );
  const prompt = manager.getPermissionPrompt();
  assert.ok(prompt);
  manager.respondPermission(prompt.id, false);

  assert.equal(events[0], 'select:tab-one');
  assert.deepEqual(events[1], { type: 'permission', prompt });
  assert.equal(events[2], 'state');
  assert.deepEqual(events[3], { type: 'permission', prompt: null });
  assert.equal(events[4], 'state');
  manager.dispose();
});

test('browser dialog responses are bounded and delivered exactly once', () => {
  const { activeTab, host } = harness();
  const manager = new BrowserPromptManager(host, 'window');
  const responses: Array<{ accept: boolean; value?: string }> = [];
  manager.presentDialog(
    activeTab,
    { kind: 'prompt', message: 'Value?', defaultValue: '' },
    (response) => responses.push(response),
  );
  const prompt = manager.getDialogPrompt();
  assert.ok(prompt);
  manager.respondDialog({
    op: 'respond-dialog',
    promptId: prompt.id,
    accept: true,
    value: 'x'.repeat(5_000),
  });

  assert.equal(responses.length, 1);
  assert.equal(responses[0].accept, true);
  assert.equal(responses[0].value?.length, 4_096);
  assert.equal(manager.getDialogPrompt(), null);
  manager.dispose();
});

test('browser prompt cancellation is scoped to its owning tab', () => {
  const { activeTab, host } = harness();
  const manager = new BrowserPromptManager(host, 'window');
  const responses: boolean[] = [];
  manager.presentDialog(
    activeTab,
    { kind: 'confirm', message: 'Continue?' },
    (response) => responses.push(response.accept),
  );
  manager.cancelForTab('another-tab');
  assert.equal(manager.getDialogPrompt()?.tabId, activeTab.id);
  manager.cancelForTab(activeTab.id);
  assert.deepEqual(responses, [false]);
  assert.equal(manager.getDialogPrompt(), null);
  manager.dispose();
});

test('stopping a tab remembers a denied geolocation decision', () => {
  const { activeTab, host } = harness();
  const manager = new BrowserPromptManager(host, 'window');
  const responses: boolean[] = [];
  manager.requestPermission(
    7,
    'geolocation',
    ['geolocation'],
    activeTab.url,
    (allow) => responses.push(allow),
  );
  manager.stopForTab(activeTab.id);

  assert.deepEqual(responses, [false]);
  assert.deepEqual(manager.persistedPermissions(), [{
    origin: 'https://example.test',
    permission: 'geolocation',
    decision: 'block',
  }]);
  manager.dispose();
});

test('browser dialogs fail closed when their bounded timeout expires', async () => {
  const { activeTab, host } = harness();
  const manager = new BrowserPromptManager(host, 'window', {
    dialogTimeoutMs: 5,
  });
  const responses: boolean[] = [];
  manager.presentDialog(
    activeTab,
    { kind: 'confirm', message: 'Continue?' },
    (response) => responses.push(response.accept),
  );
  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.deepEqual(responses, [false]);
  assert.equal(manager.getDialogPrompt(), null);
  manager.dispose();
});
