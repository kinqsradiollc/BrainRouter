import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCliKnobs } from '../config/config.js';
import { buildSearchProvider } from '../websearch/factory.js';
import { fetchAndExtract, clearCrawlerStateForTests } from '../websearch/crawler.js';
import { clearRobotsCacheForTests } from '../websearch/robots.js';

function response(body: string, init: ResponseInit = {}): Response {
  return new Response(body, init);
}

async function withMockFetch<T>(mock: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test('websearch config resolves safe defaults', () => {
  const knobs = resolveCliKnobs({ activeServer: '', servers: {}, cli: {} });
  assert.equal(knobs.webSearch.provider, 'google_pse');
  assert.equal(knobs.webSearch.maxResults, 5);
  assert.equal(knobs.webSearch.crawler.respectRobots, true);
  assert.equal(knobs.webSearch.crawler.maxContentChars, 15_000);
  // ADR-044 M4 — page persistence is opt-in (default off).
  assert.equal(knobs.webSearch.persistToMemory, false);
  assert.equal(
    resolveCliKnobs({ activeServer: '', servers: {}, cli: { webSearch: { persistToMemory: true } } }).webSearch.persistToMemory,
    true,
  );
  assert.equal(knobs.computerUse.enabled, false);
  assert.equal(knobs.computerUse.mode, 'smart_approve');
});

test('legacy DuckDuckGo config returns an actionable migration error', () => {
  const knobs = resolveCliKnobs({ activeServer: '', servers: {}, cli: { webSearch: { provider: 'duckduckgo' } } });
  assert.throws(() => buildSearchProvider(knobs), /duckduckgo.*no longer supported.*google_pse/i);
});

test('websearch factory reports exact missing secret fields', () => {
  const knobs = resolveCliKnobs({ activeServer: '', servers: {}, cli: { webSearch: { provider: 'serper' } } });
  assert.throws(() => buildSearchProvider(knobs), /cli\.webSearch\.serperApiKey/);
});

test('legacy custom endpoint remains the zero-config headless override', () => {
  const knobs = resolveCliKnobs({ activeServer: '', servers: {}, cli: { webSearchEndpoint: 'https://search.test/query' } });
  assert.equal(buildSearchProvider(knobs).id, 'custom_http');
});

test('websearch providers normalize backend-specific response shapes', async () => {
  await withMockFetch(async (url, init) => {
    const href = String(url);
    if (href.includes('serper')) {
      assert.equal((init?.headers as Record<string, string>)['X-API-KEY'], 'serper-key');
      return response(JSON.stringify({ organic: [{ title: 'A', link: 'https://a.test', snippet: 'Alpha', date: 'Today' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (href.includes('customsearch')) {
      return response(JSON.stringify({ items: [{ title: 'G', link: 'https://g.test', snippet: 'Gamma', pagemap: { metatags: [{ author: 'Ada', 'article:published_time': '2026-01-01' }] } }] }), { status: 200 });
    }
    if (href.includes('brave')) {
      return response(JSON.stringify({ web: { results: [{ title: 'B', url: 'https://b.test', description: 'Beta', age: '1 day ago' }] } }), { status: 200 });
    }
    return response(JSON.stringify({ results: [{ title: 'S', url: 'https://s.test', content: 'Sigma' }] }), { status: 200 });
  }, async () => {
    const serper = buildSearchProvider(resolveCliKnobs({ activeServer: '', servers: {}, cli: { webSearch: { provider: 'serper', serperApiKey: 'serper-key' } } }));
    assert.deepEqual(await serper.search('x', 5), [{ title: 'A', url: 'https://a.test', snippet: 'Alpha', publishedDate: 'Today' }]);

    const google = buildSearchProvider(resolveCliKnobs({ activeServer: '', servers: {}, cli: { webSearch: { provider: 'google_pse', google: { apiKey: 'g-key', cx: 'cx' } } } }));
    assert.deepEqual(await google.search('x', 5), [{ title: 'G', url: 'https://g.test', snippet: 'Gamma', author: 'Ada', publishedDate: '2026-01-01' }]);

    const brave = buildSearchProvider(resolveCliKnobs({ activeServer: '', servers: {}, cli: { webSearch: { provider: 'brave', braveApiKey: 'b-key' } } }));
    assert.deepEqual(await brave.search('x', 5), [{ title: 'B', url: 'https://b.test', snippet: 'Beta', publishedDate: '1 day ago' }]);

    const searxng = buildSearchProvider(resolveCliKnobs({ activeServer: '', servers: {}, cli: { webSearch: { provider: 'searxng', searxngBaseUrl: 'https://s.test' } } }));
    assert.deepEqual(await searxng.search('x', 5), [{ title: 'S', url: 'https://s.test', snippet: 'Sigma' }]);
  });
});

test('crawler extracts clean text, title, and strips non-content chrome', async () => {
  clearRobotsCacheForTests();
  clearCrawlerStateForTests();
  const fetches: string[] = [];
  const result = await fetchAndExtract('https://docs.test/page', {
    respectRobots: true,
    maxContentChars: 500,
    maxHtmlBytes: 10_000,
    timeoutMs: 5_000,
    ratePerHostMs: 0,
    userAgent: 'BrainRouterCrawler/0.4.16',
    fetchImpl: async (url) => {
      fetches.push(String(url));
      if (String(url).endsWith('/robots.txt')) return response('User-agent: *\nDisallow:\n', { status: 200 });
      return response('<html><head><title>Doc</title><style>x</style></head><body><nav>Skip</nav><h1>Head</h1><p>Hello <b>world</b>.</p><script>x</script><ul><li>One</li></ul></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html', 'content-length': '180' },
      });
    },
  });
  assert.equal(fetches[0], 'https://docs.test/robots.txt');
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.title, 'Doc');
    // ADR-044 M1: extraction is now structure-preserving markdown, not a flat
    // run of words — the heading carries its `#`, and inline emphasis survives.
    assert.match(result.text, /^# Head$/m);
    assert.match(result.text, /Hello \*\*world\*\*\./);
    assert.match(result.text, /^- One$/m);
    assert.doesNotMatch(result.text, /Skip|script|style/);
  }
});

test('crawler enforces robots and size failures with typed reasons', async () => {
  clearRobotsCacheForTests();
  clearCrawlerStateForTests();
  const blocked = await fetchAndExtract('https://blocked.test/private/page', {
    respectRobots: true,
    maxContentChars: 500,
    maxHtmlBytes: 10_000,
    timeoutMs: 5_000,
    ratePerHostMs: 0,
    userAgent: 'BrainRouterCrawler/0.4.16',
    fetchImpl: async () => response('User-agent: *\nDisallow: /private\n', { status: 200 }),
  });
  assert.deepEqual({ ok: blocked.ok, reason: blocked.ok ? undefined : blocked.reason }, { ok: false, reason: 'robots-blocked' });

  clearRobotsCacheForTests();
  clearCrawlerStateForTests();
  const oversized = await fetchAndExtract('https://large.test/page', {
    respectRobots: false,
    maxContentChars: 500,
    maxHtmlBytes: 4,
    timeoutMs: 5_000,
    ratePerHostMs: 0,
    userAgent: 'BrainRouterCrawler/0.4.16',
    fetchImpl: async () => response('12345', { status: 200, headers: { 'content-length': '5' } }),
  });
  assert.deepEqual({ ok: oversized.ok, reason: oversized.ok ? undefined : oversized.reason }, { ok: false, reason: 'oversized' });
});
