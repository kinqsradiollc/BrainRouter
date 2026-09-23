/**
 * fetch_url's browser-first path (fetchViaInAppBrowser): drives a stub
 * browser-control port and asserts it reads clean page.text, falls back to the
 * semantic snapshot when page.text is empty, always closes the tab, and returns
 * null on any failure so fetch_url falls back to the HTTP crawler.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchHtmlViaInAppBrowser, fetchViaInAppBrowser, looksLikeConsentWall } from '../websearch/inAppBrowser.js';

function stubPort(handlers: Record<string, (cmd: any) => any>) {
  const calls: string[] = [];
  return {
    calls,
    request: async (command: any) => {
      const kind = command?.kind;
      calls.push(kind);
      const h = handlers[kind];
      return h ? h(command) : { ok: true };
    },
  };
}

test('reads clean page.text and closes the tab', async () => {
  const port = stubPort({
    'tabs.open': () => ({ ok: true, tabId: 'tab_1' }),
    'page.wait': () => ({ ok: true }),
    'page.text': () => ({ ok: true, data: { url: 'https://x.test/final', title: 'Hello', text: 'Line one.\n\nLine two.' } }),
    'tabs.close': () => ({ ok: true }),
  });
  const out = await fetchViaInAppBrowser(port as any, 'https://x.test', 5000);
  assert.ok(out);
  assert.equal(out!.title, 'Hello');
  assert.equal(out!.url, 'https://x.test/final');
  assert.equal(out!.text, 'Line one.\n\nLine two.');
  assert.ok(!port.calls.includes('page.snapshot'), 'snapshot not needed when page.text has content');
  assert.ok(port.calls.includes('tabs.close'), 'tab is always closed');
});

test('falls back to the semantic snapshot when page.text is empty', async () => {
  const port = stubPort({
    'tabs.open': () => ({ ok: true, tabId: 'tab_2' }),
    'page.wait': () => ({ ok: true }),
    'page.text': () => ({ ok: true, data: { text: '' } }),
    'page.snapshot': () => ({ ok: true, data: { url: 'https://x.test', title: 'Snap', nodes: [{ name: 'First' }, { value: 'Second' }] } }),
    'tabs.close': () => ({ ok: true }),
  });
  const out = await fetchViaInAppBrowser(port as any, 'https://x.test', 5000, undefined, { readinessPollMs: 0 });
  assert.ok(out);
  assert.equal(out!.text, 'First\nSecond');
  assert.equal(out!.title, 'Snap');
});

test('ADR-044 M2 — an empty first render is RE-READ, and the fuller render is kept', async () => {
  // page.text returns nothing on load (JS still rendering), then the article.
  let reads = 0;
  const port = stubPort({
    'tabs.open': () => ({ ok: true, tabId: 'tab_r' }),
    'page.wait': () => ({ ok: true }),
    'page.text': () => ({ ok: true, data: { url: 'https://x.test', title: 'Doc', text: (reads++ === 0 ? '' : 'The article rendered after load.') } }),
    'tabs.close': () => ({ ok: true }),
  });
  const out = await fetchViaInAppBrowser(port as any, 'https://x.test', 5000, undefined, { readinessPollMs: 0 });
  assert.ok(out);
  assert.equal(out!.text, 'The article rendered after load.', 'the re-read content is kept');
  assert.ok(!port.calls.includes('page.snapshot'), 'a successful re-read never needs the snapshot');
  assert.ok(port.calls.filter((c) => c === 'page.text').length >= 2, 'it re-read after the empty first render');
});

test('ADR-044 M2 — a consent wall is NOT re-read (waiting does not dismiss it)', async () => {
  let reads = 0;
  const port = stubPort({
    'tabs.open': () => ({ ok: true, tabId: 'tab_c' }),
    'page.wait': () => ({ ok: true }),
    'page.text': () => { reads++; return ({ ok: true, data: { text: 'We use cookies. Accept all cookies to continue.' } }); },
    'tabs.close': () => ({ ok: true }),
  });
  const out = await fetchViaInAppBrowser(port as any, 'https://x.test', 5000, undefined, { readinessPollMs: 0 });
  // The consent text is still returned (better than nothing), but it was read ONCE — no wasted re-reads.
  assert.ok(out && /cookies/i.test(out.text));
  assert.equal(reads, 1, 'a consent wall short-circuits the readiness loop');
});

test('ADR-044 M2 — looksLikeConsentWall flags short consent text, not long articles', () => {
  assert.equal(looksLikeConsentWall('We use cookies — accept all cookies?'), true);
  assert.equal(looksLikeConsentWall('Manage your preferences'), true);
  assert.equal(looksLikeConsentWall('A normal short sentence about otters.'), false);
  assert.equal(looksLikeConsentWall('consent '.repeat(200)), false, 'a long page is never a wall');
});

test('returns null when the tab fails to open (→ crawler fallback), no read attempted', async () => {
  const port = stubPort({ 'tabs.open': () => ({ ok: false }) });
  const out = await fetchViaInAppBrowser(port as any, 'https://x.test', 5000);
  assert.equal(out, null);
  assert.ok(!port.calls.includes('page.text') && !port.calls.includes('page.snapshot'));
});

test('returns null and STILL closes the tab when both reads fail', async () => {
  const port = stubPort({
    'tabs.open': () => ({ ok: true, tabId: 'tab_3' }),
    'page.wait': () => ({ ok: true }),
    'page.text': () => ({ ok: false }),
    'page.snapshot': () => ({ ok: false }),
    'tabs.close': () => ({ ok: true }),
  });
  const out = await fetchViaInAppBrowser(port as any, 'https://x.test', 5000, undefined, { readinessPollMs: 0 });
  assert.equal(out, null);
  assert.ok(port.calls.includes('tabs.close'), 'tab is closed even on failure');
});

test('returns null when the port throws (→ crawler fallback)', async () => {
  const port = { calls: [], request: async () => { throw new Error('bridge down'); } };
  const out = await fetchViaInAppBrowser(port as any, 'https://x.test', 5000);
  assert.equal(out, null);
});

test('rendered HTML search uses a background tab and closes it after extraction', async () => {
  const port = recordingPort({
    'tabs.open': () => ({ ok: true, tabId: 'search_1' }),
    'page.html': () => ({ ok: true, data: { html: `<html><body>${'result '.repeat(30)}</body></html>` } }),
    'tabs.close': () => ({ ok: true }),
  });
  const html = await fetchHtmlViaInAppBrowser(port as any, 'https://www.google.com/search?q=x', 5_000);
  assert.match(html ?? '', /result/);
  assert.equal(port.cmds.find((command) => command.kind === 'tabs.open')?.activate, false, 'agent search must not steal human focus');
  assert.ok(port.cmds.some((command) => command.kind === 'tabs.close' && command.tabId === 'search_1'), 'search tab closes after extraction');
});

// Live mode: the fetch is WATCHABLE — it opens/reuses a single VISIBLE research
// tab and leaves it open so the user sees the agent navigate.
function recordingPort(handlers: Record<string, (cmd: any) => any>) {
  const cmds: any[] = [];
  return { cmds, request: async (command: any) => { cmds.push(command); const h = handlers[command?.kind]; return h ? h(command) : { ok: true }; } };
}

test('live mode opens a VISIBLE tab, keeps it open, and records the reused tab id', async () => {
  const port = recordingPort({
    'tabs.open': () => ({ ok: true, tabId: 'live_1' }),
    'page.text': () => ({ ok: true, data: { text: 'Body' } }),
  });
  const tabRef: { id?: string } = {};
  const out = await fetchViaInAppBrowser(port as any, 'https://x.test', 5000, undefined, { live: true, tabRef });
  assert.equal(out!.text, 'Body');
  assert.equal(tabRef.id, 'live_1', 'records the tab id for reuse');
  assert.equal(port.cmds.find((c) => c.kind === 'tabs.open')!.activate, true, 'live mode activates (shows) the tab');
  assert.ok(!port.cmds.some((c) => c.kind === 'tabs.close'), 'live mode keeps the tab open');
});

test('live mode reuses the research tab (navigate + select), no new open, no close', async () => {
  const port = recordingPort({
    'page.navigate': () => ({ ok: true }),
    'page.text': () => ({ ok: true, data: { text: 'Reused' } }),
  });
  const tabRef: { id?: string } = { id: 'live_1' };
  const out = await fetchViaInAppBrowser(port as any, 'https://y.test', 5000, undefined, { live: true, tabRef });
  assert.equal(out!.text, 'Reused');
  assert.ok(port.cmds.some((c) => c.kind === 'page.navigate' && c.tabId === 'live_1'), 'navigates the reused tab');
  assert.ok(port.cmds.some((c) => c.kind === 'tabs.select' && c.tabId === 'live_1'), 're-activates it so the user watches');
  assert.ok(!port.cmds.some((c) => c.kind === 'tabs.open'), 'no new tab opened');
  assert.ok(!port.cmds.some((c) => c.kind === 'tabs.close'), 'reused tab stays open');
});

test('live mode: a stale/closed research tab falls back to opening a fresh one', async () => {
  const port = recordingPort({
    'page.navigate': () => ({ ok: false }), // tab is gone
    'tabs.open': () => ({ ok: true, tabId: 'live_2' }),
    'page.text': () => ({ ok: true, data: { text: 'Fresh' } }),
  });
  const tabRef: { id?: string } = { id: 'dead' };
  const out = await fetchViaInAppBrowser(port as any, 'https://z.test', 5000, undefined, { live: true, tabRef });
  assert.equal(out!.text, 'Fresh');
  assert.equal(tabRef.id, 'live_2', 'stale id is replaced with the fresh tab');
});
