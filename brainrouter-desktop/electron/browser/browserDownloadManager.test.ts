import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  availableDownloadPath,
  BrowserDownloadManager,
  safeDownloadName,
  type BrowserDownloadHost,
  type BrowserDownloadItem,
} from './browserDownloadManager.js';
import type { BrowserEvent, BrowserTab } from './protocol.js';

class FakeItem implements BrowserDownloadItem {
  cancelled = false;
  paused = false;
  resumed = false;
  savePath = '';
  received = 0;
  private updated?: (_event: unknown, state: string) => void;
  private done?: (_event: unknown, state: string) => void;

  getFilename(): string { return '../report.txt'; }
  getURL(): string { return 'https://example.test/report.txt'; }
  getTotalBytes(): number { return 20; }
  getReceivedBytes(): number { return this.received; }
  setSavePath(savePath: string): void { this.savePath = savePath; }
  cancel(): void { this.cancelled = true; }
  pause(): void { this.paused = true; }
  resume(): void { this.resumed = true; }
  on(_event: 'updated', listener: (_event: unknown, state: string) => void): void {
    this.updated = listener;
  }
  once(_event: 'done', listener: (_event: unknown, state: string) => void): void {
    this.done = listener;
  }
  update(received: number, state = 'progressing'): void {
    this.received = received;
    this.updated?.({}, state);
  }
  complete(state = 'completed'): void {
    this.received = 20;
    this.done?.({}, state);
  }
}

function tab(): BrowserTab {
  return {
    id: 'tab-one',
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

function harness(agentControlled = true) {
  let listener: Parameters<BrowserDownloadHost['listen']>[1] | undefined;
  let detachCount = 0;
  const events: BrowserEvent[] = [];
  const host: BrowserDownloadHost = {
    listen: (_partition, next) => {
      listener = next;
      return () => {
        detachCount += 1;
        listener = undefined;
      };
    },
    prepareSavePath: (filename) => `/downloads/${filename}`,
    showItemInFolder: () => {},
    openPath: async () => '',
  };
  const manager = new BrowserDownloadManager(host, {
    tabForContents: (contentsId) => contentsId === 7 ? tab() : null,
    isAgentControlled: () => agentControlled,
    emit: (event) => events.push(event),
    emitState: () => {},
  }, 'window', '/workspace/one', 'partition-one');
  return {
    manager,
    events,
    getListener: () => listener,
    getDetachCount: () => detachCount,
  };
}

test('agent downloads fail closed without a recent interaction lease', () => {
  const { manager, events, getListener } = harness(true);
  const item = new FakeItem();
  let prevented = false;
  getListener()?.({ preventDefault: () => { prevented = true; } }, item, 7);

  assert.equal(prevented, true);
  assert.equal(item.cancelled, true);
  assert.equal(item.savePath, '');
  assert.equal(manager.list()[0]?.state, 'cancelled');
  assert.equal(events[0]?.type, 'download');
  manager.dispose();
});

test('one agent interaction lease allows one download and preserves progress order', () => {
  const { manager, events, getListener } = harness(true);
  manager.allowAgentInteraction('tab-one', Date.now() + 1_000);
  const first = new FakeItem();
  getListener()?.({ preventDefault: () => assert.fail('allowed download') }, first, 7);
  first.update(10);
  first.complete();

  assert.equal(first.savePath, '/downloads/report.txt');
  assert.deepEqual(
    events.filter((event) => event.type === 'download')
      .map((event) => event.type === 'download' ? event.download.state : ''),
    ['progressing', 'progressing', 'completed'],
  );

  const second = new FakeItem();
  getListener()?.({ preventDefault: () => {} }, second, 7);
  assert.equal(second.cancelled, true);
  manager.dispose();
});

test('workspace rotation detaches the old listener and hides old downloads', () => {
  const { manager, getListener, getDetachCount } = harness(false);
  const item = new FakeItem();
  getListener()?.({ preventDefault: () => {} }, item, 7);
  assert.equal(manager.list().length, 1);

  manager.setWorkspace('/workspace/two', 'partition-two');
  assert.equal(getDetachCount(), 1);
  assert.equal(manager.list().length, 0);
  manager.dispose();
  assert.equal(getDetachCount(), 2);
});

test('download filenames and collision paths stay bounded inside the chosen directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-downloads-'));
  try {
    fs.writeFileSync(path.join(root, 'report.txt'), 'one');
    assert.equal(safeDownloadName('../report.txt'), 'report.txt');
    assert.equal(
      availableDownloadPath(root, 'report.txt'),
      path.join(root, 'report (1).txt'),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
