import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  BrowserWorkspacePersistenceQueue,
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

test('browser workspace persistence coalesces event bursts and flushes lifecycle writes', () => {
  const timer = { pending: null as (() => void) | null };
  let clears = 0;
  let writes = 0;
  const queue = new BrowserWorkspacePersistenceQueue(
    () => { writes += 1; },
    50,
    {
      set: (callback) => {
        timer.pending = callback;
        return callback;
      },
      clear: () => {
        clears += 1;
        timer.pending = null;
      },
    },
  );

  queue.schedule();
  queue.schedule();
  assert.equal(writes, 0);
  timer.pending?.();
  assert.equal(writes, 1, 'one delayed write represents the whole event burst');

  queue.schedule();
  queue.flush();
  assert.equal(clears, 1);
  assert.equal(writes, 2, 'flush persists once and cancels the delayed duplicate');
  assert.equal(timer.pending, null);
});

// ── ADR-055 P9 — bookmarks, history, and omnibox autocomplete ──────────────
import {
  recordBrowserVisit,
  addBrowserBookmark,
  removeBrowserBookmark,
  isBookmarked,
  omniboxSuggest,
  MAX_BROWSER_HISTORY,
  type BrowserHistoryEntry,
} from './browserWorkspaceStore.js';

test('P9 recordBrowserVisit dedupes by url, counts revisits, and is newest-first', () => {
  let h = recordBrowserVisit([], { url: 'https://a.example/', title: 'A', at: 1 });
  h = recordBrowserVisit(h, { url: 'https://b.example/', title: 'B', at: 2 });
  assert.deepEqual(h.map((e) => e.url), ['https://b.example/', 'https://a.example/']);

  h = recordBrowserVisit(h, { url: 'https://a.example/', title: 'A again', at: 3 });
  assert.equal(h.length, 2, 'a revisit does not add a row');
  assert.equal(h[0].url, 'https://a.example/', 'the revisit moves to the front');
  assert.equal(h[0].visits, 2);
  assert.equal(h[0].visitedAt, 3);
  assert.equal(h[0].title, 'A again');
});

test('P9 recordBrowserVisit never records a blank page and strips query/credentials', () => {
  assert.deepEqual(recordBrowserVisit([], { url: 'about:blank', title: '', at: 1 }), []);
  assert.deepEqual(recordBrowserVisit([], { url: '', title: '', at: 1 }), []);
  const h = recordBrowserVisit([], { url: 'https://u:p@x.example/path?token=secret#frag', title: 'X', at: 1 });
  assert.equal(h[0].url, 'https://x.example/path', 'query, hash and credentials are stripped before persisting');
});

test('P9 history is bounded', () => {
  let h: BrowserHistoryEntry[] = [];
  for (let i = 0; i < MAX_BROWSER_HISTORY + 25; i += 1) {
    h = recordBrowserVisit(h, { url: `https://e.example/${i}`, title: `t${i}`, at: i });
  }
  assert.equal(h.length, MAX_BROWSER_HISTORY);
});

test('P9 bookmarks dedupe, remove, and report membership', () => {
  let b = addBrowserBookmark([], { url: 'https://a.example/', title: 'A', at: 1 });
  b = addBrowserBookmark(b, { url: 'https://b.example/', title: 'B', at: 2 });
  b = addBrowserBookmark(b, { url: 'https://a.example/', title: 'A2', at: 3 });
  assert.equal(b.length, 2, 're-adding refreshes rather than duplicating');
  assert.equal(b[0].title, 'A2');
  assert.equal(isBookmarked(b, 'https://a.example/'), true);
  b = removeBrowserBookmark(b, 'https://a.example/');
  assert.equal(isBookmarked(b, 'https://a.example/'), false);
  assert.equal(b.length, 1);
  // A blank page is never bookmarkable.
  assert.equal(addBrowserBookmark([], { url: 'about:blank', title: '', at: 1 }).length, 0);
});

test('P9 omniboxSuggest ranks bookmarks first, then prefix, then visit count — local only', () => {
  const bookmarks = [{ url: 'https://docs.example/guide', title: 'Guide', addedAt: 1 }];
  const history = [
    { url: 'https://other.example/docs', title: 'Other docs', visitedAt: 5, visits: 1 },
    { url: 'https://docs.example/api', title: 'API', visitedAt: 4, visits: 9 },
  ];
  const out = omniboxSuggest('docs', { bookmarks, history });
  assert.equal(out[0].url, 'https://docs.example/guide', 'the bookmark outranks history');
  assert.equal(out[0].source, 'bookmark');
  // Both history rows match; the more-visited prefix match outranks the substring match.
  assert.deepEqual(out.slice(1).map((s) => s.url), ['https://docs.example/api', 'https://other.example/docs']);

  assert.deepEqual(omniboxSuggest('', { bookmarks, history }), [], 'an empty query suggests nothing');
  assert.deepEqual(omniboxSuggest('nomatch', { bookmarks, history }), []);
  assert.equal(omniboxSuggest('docs', { bookmarks, history, limit: 1 }).length, 1);
  // Title matches count too, case-insensitively.
  assert.equal(omniboxSuggest('GUIDE', { bookmarks, history })[0].url, 'https://docs.example/guide');
});
