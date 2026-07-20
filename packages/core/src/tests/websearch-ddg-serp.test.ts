/**
 * DuckDuckGo SERP parsing (the real-web-results fix — the default web_search
 * provider now scrapes the results pages instead of the Instant-Answer API) and
 * fetch_url's structured-URL heuristic (JSON/API endpoints skip the browser).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDuckDuckGoHtml, parseDuckDuckGoLite, unwrapDuckDuckGoUrl } from '../websearch/providers/duckduckgo.js';
import { looksStructuredUrl, fetchHtmlViaInAppBrowser } from '../extension/builtin/runtime.js';

test('unwrapDuckDuckGoUrl decodes the uddg redirect wrapper', () => {
  assert.equal(
    unwrapDuckDuckGoUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fnews%2Fitem&rut=abc'),
    'https://example.com/news/item',
  );
  assert.equal(unwrapDuckDuckGoUrl('https://plain.example.com/x'), 'https://plain.example.com/x');
});

test('parseDuckDuckGoHtml extracts ranked results with titles, real URLs, and snippets', () => {
  const html = `
    <div class="result results_links web-result"><div class="links_main">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnews.example%2Fa">First Story</a>
      <a class="result__snippet" href="#">Breaking coverage of the first story.</a>
    </div></div>
    <div class="result web-result"><div class="links_main">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnews.example%2Fb">Second Story</a>
      <a class="result__snippet">Analysis of the second story.</a>
    </div></div>`;
  const out = parseDuckDuckGoHtml(html, 10);
  assert.equal(out.length, 2);
  assert.equal(out[0].title, 'First Story');
  assert.equal(out[0].url, 'https://news.example/a');
  assert.equal(out[0].snippet, 'Breaking coverage of the first story.');
  assert.equal(out[1].url, 'https://news.example/b');
});

test('parseDuckDuckGoHtml respects the result limit', () => {
  const block = (i: number) => `<div class="result"><a class="result__a" href="https://e.test/${i}">T${i}</a><a class="result__snippet">s${i}</a></div>`;
  const html = Array.from({ length: 8 }, (_v, i) => block(i)).join('');
  assert.equal(parseDuckDuckGoHtml(html, 3).length, 3);
});

test('parseDuckDuckGoLite extracts results and filters out ad / internal links', () => {
  const html = `<table>
    <tr><td><a class="result-link" href="https://duckduckgo.com/y.js?ad_domain=pega.com">Pega Ad</a></td></tr>
    <tr><td class="result-snippet">sponsored.</td></tr>
    <tr><td><a class="result-link" href="https://lite.example/a">Lite A</a></td></tr>
    <tr><td class="result-snippet">Snippet A.</td></tr>
    <tr><td><a class="result-link" href="https://lite.example/b">Lite B</a></td></tr>
    <tr><td class="result-snippet">Snippet B.</td></tr>
  </table>`;
  const out = parseDuckDuckGoLite(html, 10);
  assert.equal(out.length, 2, 'ad row dropped');
  assert.equal(out[0].title, 'Lite A');
  assert.equal(out[0].url, 'https://lite.example/a');
  assert.equal(out[0].snippet, 'Snippet A.');
  assert.ok(!out.some((r) => r.url.includes('duckduckgo.com')), 'no duckduckgo internal/ad URLs');
});

test('parseDuckDuckGoHtml filters ads whose href stays on duckduckgo.com', () => {
  const html = `
    <div class="result"><a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=x.com">Ad</a><a class="result__snippet">ad</a></div>
    <div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.example%2Fp">Real</a><a class="result__snippet">real</a></div>`;
  const out = parseDuckDuckGoHtml(html, 10);
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://real.example/p');
});

test('fetchHtmlViaInAppBrowser reads rendered page.html and closes the tab (web_search path)', async () => {
  const serpHtml = `<table><tr><td><a class="result-link" href="https://real.example/x">Real X</a></td></tr><tr><td class="result-snippet">snip x that is long enough to pass</td></tr></table>`;
  const calls: string[] = [];
  const port = {
    request: async (cmd: any) => {
      calls.push(cmd.kind);
      if (cmd.kind === 'tabs.open') return { ok: true, tabId: 't1' };
      if (cmd.kind === 'page.html') return { ok: true, data: { url: 'https://lite.duckduckgo.com/lite/', html: serpHtml } };
      return { ok: true };
    },
  };
  const html = await fetchHtmlViaInAppBrowser(port as any, 'https://lite.duckduckgo.com/lite/?q=x', 5000);
  assert.ok(html && html.includes('result-link'));
  // and the DDG parser turns that rendered HTML into structured results
  const results = parseDuckDuckGoLite(html!, 5);
  assert.equal(results[0].url, 'https://real.example/x');
  assert.ok(calls.includes('tabs.close'), 'tab always closed');
});

test('fetchHtmlViaInAppBrowser returns null (→ HTTP fallback) when page.html fails', async () => {
  const port = { request: async (cmd: any) => (cmd.kind === 'tabs.open' ? { ok: true, tabId: 't2' } : cmd.kind === 'page.html' ? { ok: false } : { ok: true }) };
  assert.equal(await fetchHtmlViaInAppBrowser(port as any, 'https://x.test', 5000), null);
});

test('fetchHtmlViaInAppBrowser live mode reuses one VISIBLE research tab across engines (Google→DDG)', async () => {
  const serp = `<table><tr><td><a class="result-link" href="https://real.example/x">Real X</a></td></tr><tr><td class="result-snippet">snip x that is long enough to pass</td></tr></table>${'y'.repeat(120)}`;
  const cmds: any[] = [];
  const port = { request: async (cmd: any) => { cmds.push(cmd); if (cmd.kind === 'tabs.open') return { ok: true, tabId: 'srp' }; if (cmd.kind === 'page.html') return { ok: true, data: { html: serp } }; return { ok: true }; } };
  const tabRef: { id?: string } = {};
  // First engine opens the visible tab...
  const h1 = await fetchHtmlViaInAppBrowser(port as any, 'https://www.google.com/search?q=x', 5000, undefined, { live: true, tabRef });
  assert.ok(h1);
  assert.equal(tabRef.id, 'srp');
  // ...second engine reuses the SAME tab (navigate), so the user watches one tab.
  const h2 = await fetchHtmlViaInAppBrowser(port as any, 'https://lite.duckduckgo.com/lite/?q=x', 5000, undefined, { live: true, tabRef });
  assert.ok(h2);
  assert.equal(cmds.filter((c) => c.kind === 'tabs.open').length, 1, 'only one tab ever opened');
  assert.ok(cmds.some((c) => c.kind === 'page.navigate' && c.tabId === 'srp'), 'second engine navigates the reused tab');
  assert.ok(!cmds.some((c) => c.kind === 'tabs.close'), 'the visible research tab is never closed in live mode');
});

test('looksStructuredUrl routes JSON/API/feed URLs away from the browser', () => {
  for (const u of [
    'https://hn.algolia.com/api/v1/search?tags=front_page',
    'https://api.github.com/repos/x/y',
    'https://example.com/data.json',
    'https://example.com/feed.xml',
    'https://data.example.com/export',
    'https://example.com/v2/items',
  ]) {
    assert.equal(looksStructuredUrl(u), true, u);
  }
  for (const u of [
    'https://www.google.com/search?q=news',
    'https://en.wikipedia.org/wiki/Thing',
    'https://example.com/articles/how-to',
    'not a url',
  ]) {
    assert.equal(looksStructuredUrl(u), false, u);
  }
});
