import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  BrowserWorkspaceStore,
  persistableBrowserUrl,
} from './browserWorkspaceStore.js';
import { BROWSER_BLANK_URL } from './protocol.js';

test('browser workspace store isolates files by opaque workspace identity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-workspace-store-'));
  try {
    const first = new BrowserWorkspaceStore(root, '/workspace/alpha');
    const second = new BrowserWorkspaceStore(root, '/workspace/beta');
    first.save({ version: 1, activeIndex: 0, tabs: [{ url: 'https://one.test/' }] });
    second.save({ version: 1, activeIndex: 0, tabs: [{ url: 'https://two.test/' }] });

    assert.equal(first.load()?.tabs[0]?.url, 'https://one.test/');
    assert.equal(second.load()?.tabs[0]?.url, 'https://two.test/');
    const names = fs.readdirSync(path.join(root, 'browser-tabs-v1'));
    assert.equal(names.length, 2);
    assert.ok(names.every((name) => /^[a-f0-9]{20}\.json$/.test(name)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('persistable browser URLs remove credentials, query text, and fragments', () => {
  assert.equal(
    persistableBrowserUrl('https://user:secret@example.test/path?q=sensitive#token'),
    'https://example.test/path',
  );
  assert.equal(persistableBrowserUrl('data:text/plain,secret'), BROWSER_BLANK_URL);
  assert.equal(persistableBrowserUrl('not a url'), BROWSER_BLANK_URL);
});

test('browser workspace store round-trips permission decisions and fails closed on corruption', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-workspace-store-'));
  try {
    const store = new BrowserWorkspaceStore(root, '/workspace/alpha');
    store.save({
      version: 1,
      activeIndex: 1,
      tabs: [{ url: 'https://one.test/' }, { url: 'https://two.test/' }],
      permissions: [{
        origin: 'https://one.test',
        permission: 'geolocation',
        decision: 'allow',
      }],
    });
    assert.deepEqual(store.load(), {
      version: 1,
      activeIndex: 1,
      tabs: [{ url: 'https://one.test/' }, { url: 'https://two.test/' }],
      permissions: [{
        origin: 'https://one.test',
        permission: 'geolocation',
        decision: 'allow',
      }],
    });

    const files = fs.readdirSync(path.join(root, 'browser-tabs-v1'));
    fs.writeFileSync(path.join(root, 'browser-tabs-v1', files[0]), '{broken');
    assert.equal(store.load(), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
