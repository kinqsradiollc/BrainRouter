import test from 'node:test';
import assert from 'node:assert/strict';
import type { ConnectorRecord } from '@kinqs/brainrouter-types';
import {
  extractSameOriginLinks,
  fetchWebClient,
  runWebConnectorCheckpoint,
  type WebConnectorClient,
  type WebConnectorPage,
} from '../connectors/sources/webConnector.js';

const NUL = String.fromCharCode(0);

function connector(overrides?: Partial<ConnectorRecord>): ConnectorRecord {
  return {
    id: 'conn_web',
    source: 'web',
    name: 'Web',
    status: 'active',
    config: { baseUrl: 'https://docs.test', mode: 'recursive', depth: 1 },
    credential: { mode: 'none' },
    flows: ['checkpoint'],
    workspaceRoot: '/tmp/workspace',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function site(pages: Record<string, Partial<WebConnectorPage>>): WebConnectorClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async fetchPage(url) {
      calls.push(url);
      const page = pages[url];
      if (!page) throw new Error(`no page for ${url}`);
      return { status: 200, contentType: 'text/html', body: '', links: [], ...page };
    },
  };
}

test('runWebConnectorCheckpoint crawls same-origin BFS, maps pages, and strips markup', async () => {
  const client = site({
    'https://docs.test/': {
      body: '<html><head><title>Docs Home</title><script>var hidden = 1;</script><style>.x{}</style></head><body><h1>Welcome</h1><p>Start here.</p></body></html>',
      links: ['/guide', 'https://docs.test/api#section', 'https://other.test/x', 'mailto:a@b.c', '#top'],
    },
    'https://docs.test/guide': { body: '<html><title>Guide</title><p>Guide body</p></html>' },
    'https://docs.test/api': { body: '<html><title>API</title><p>API body</p></html>' },
  });

  const result = await runWebConnectorCheckpoint(connector(), client, { now: '2026-01-05T00:00:00.000Z' });

  assert.deepEqual(client.calls, ['https://docs.test/', 'https://docs.test/guide', 'https://docs.test/api']);
  assert.equal(result.documents.length, 3);
  const [home, guide] = result.documents;
  assert.match(home.id, /^web:conn_web:[0-9a-f]{16}$/);
  assert.equal(home.kind, 'file');
  assert.equal(home.title, 'Docs Home');
  assert.equal(home.url, 'https://docs.test/');
  assert.equal(home.repository, 'https://docs.test');
  assert.equal(home.updatedAt, '2026-01-05T00:00:00.000Z');
  assert.ok(home.text.includes('Welcome'));
  assert.ok(home.text.includes('Start here.'));
  assert.ok(!home.text.includes('hidden'));
  assert.deepEqual(home.metadata, { url: 'https://docs.test/', depth: 0, status: 200, contentType: 'text/html' });
  assert.equal(guide.metadata.depth, 1);
  assert.deepEqual(new Set(result.documents.map((doc) => doc.id)).size, 3);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.checkpoint, {
    lastRunAt: '2026-01-05T00:00:00.000Z',
    baseUrl: 'https://docs.test/',
    completedAt: '2026-01-05T00:00:00.000Z',
    documentCount: 3,
    failureCount: 0,
    pagesFetched: 3,
  });
});

test('runWebConnectorCheckpoint clamps depth to 3 and honors single mode', async () => {
  const chain = site({
    'https://docs.test/': { body: '<html></html>', links: ['/d1'] },
    'https://docs.test/d1': { body: '<html></html>', links: ['/d2'] },
    'https://docs.test/d2': { body: '<html></html>', links: ['/d3'] },
    'https://docs.test/d3': { body: '<html></html>', links: ['/d4'] },
    'https://docs.test/d4': { body: '<html></html>' },
  });
  const deep = await runWebConnectorCheckpoint(connector({
    config: { baseUrl: 'https://docs.test', depth: 99 },
  }), chain, { now: '2026-01-05T00:00:00.000Z' });
  assert.deepEqual(chain.calls, ['https://docs.test/', 'https://docs.test/d1', 'https://docs.test/d2', 'https://docs.test/d3']);
  assert.deepEqual(deep.failures, []);

  const single = site({
    'https://docs.test/': { body: '<html></html>', links: ['/d1'] },
  });
  const result = await runWebConnectorCheckpoint(connector({
    config: { baseUrl: 'https://docs.test', mode: 'single', depth: 5 },
  }), single, { now: '2026-01-05T00:00:00.000Z' });
  assert.deepEqual(single.calls, ['https://docs.test/']);
  assert.equal(result.documents.length, 1);
});

test('runWebConnectorCheckpoint stops at maxPages and notes the unfetched queue', async () => {
  const pages: Record<string, Partial<WebConnectorPage>> = {
    'https://docs.test/': { body: '<html></html>', links: ['/p1', '/p2', '/p3', '/p4', '/p5'] },
  };
  for (let i = 1; i <= 5; i++) pages[`https://docs.test/p${i}`] = { body: '<html></html>' };
  const client = site(pages);

  const result = await runWebConnectorCheckpoint(connector(), client, { now: '2026-01-05T00:00:00.000Z', maxPages: 3 });

  assert.equal(client.calls.length, 3);
  assert.equal(result.documents.length, 3);
  assert.deepEqual(result.failures, ['Stopped after 3 pages; 3 discovered links were not fetched.']);
  assert.equal(result.checkpoint.pagesFetched, 3);
});

test('runWebConnectorCheckpoint records fetch errors and non-2xx statuses without emitting documents', async () => {
  const client = site({
    'https://docs.test/': { body: '<html></html>', links: ['/boom', '/missing'] },
    'https://docs.test/missing': { status: 404, body: '<html><a href="/never">x</a></html>', links: ['/never'] },
  });

  const result = await runWebConnectorCheckpoint(connector(), client, { now: '2026-01-05T00:00:00.000Z' });

  assert.deepEqual(result.documents.map((doc) => doc.url), ['https://docs.test/']);
  assert.deepEqual(result.failures, [
    'https://docs.test/boom: no page for https://docs.test/boom',
    'https://docs.test/missing: HTTP 404',
  ]);
  assert.ok(!client.calls.includes('https://docs.test/never'));
});

test('runWebConnectorCheckpoint indexes plain-text pages with url title and skips binary content', async () => {
  const client = site({
    'https://docs.test/': { body: '<html></html>', links: ['/notes.txt', '/blob', '/pic.png'] },
    'https://docs.test/notes.txt': { contentType: 'text/plain', body: 'hello   world', links: ['/ignored'] },
    'https://docs.test/blob': { contentType: '', body: `BIN${NUL}DATA` },
    'https://docs.test/pic.png': { contentType: 'image/png', body: 'PNG' },
  });

  const result = await runWebConnectorCheckpoint(connector(), client, { now: '2026-01-05T00:00:00.000Z' });

  const textDoc = result.documents.find((doc) => doc.url === 'https://docs.test/notes.txt');
  assert.ok(textDoc);
  assert.equal(textDoc.title, 'https://docs.test/notes.txt');
  assert.equal(textDoc.text, 'hello world');
  assert.ok(!client.calls.includes('https://docs.test/ignored'));
  assert.deepEqual(result.failures, [
    'https://docs.test/blob: binary content skipped.',
    'https://docs.test/pic.png: unsupported content type image/png.',
  ]);
});

test('runWebConnectorCheckpoint re-crawls every run with stable ids and no high watermark', async () => {
  const pages = {
    'https://docs.test/': { body: '<html><title>Home</title></html>' },
  };
  const first = await runWebConnectorCheckpoint(connector(), site(pages), { now: '2026-01-05T00:00:00.000Z' });
  const second = await runWebConnectorCheckpoint(
    connector({ checkpoint: first.checkpoint }),
    site(pages),
    { now: '2026-01-06T00:00:00.000Z' },
  );

  assert.deepEqual(second.documents.map((doc) => doc.id), first.documents.map((doc) => doc.id));
  assert.equal(second.documents.length, 1);
  assert.ok(!('highWatermark' in second.checkpoint));
  assert.equal(second.checkpoint.lastRunAt, '2026-01-06T00:00:00.000Z');
});

test('runWebConnectorCheckpoint validates source and baseUrl', async () => {
  const client = {} as WebConnectorClient;
  await assert.rejects(
    () => runWebConnectorCheckpoint(connector({ source: 'slack' as never }), client),
    /not web/,
  );
  await assert.rejects(
    () => runWebConnectorCheckpoint(connector({ config: { baseUrl: '' } }), client),
    /baseUrl/,
  );
  await assert.rejects(
    () => runWebConnectorCheckpoint(connector({ config: { baseUrl: 'ftp://docs.test' } }), client),
    /baseUrl/,
  );
});

test('extractSameOriginLinks resolves relative hrefs, drops cross-origin, and strips fragments', () => {
  const html = '<a href="/a">A</a><a href=\'b/c\'>B</a><a href="https://other.test/x">X</a><a href="page#frag">C</a><a href="mailto:a@b.c">M</a><a href="/a">dup</a>';
  assert.deepEqual(extractSameOriginLinks(html, 'https://docs.test/root/'), [
    'https://docs.test/a',
    'https://docs.test/root/b/c',
    'https://docs.test/root/page',
  ]);
  assert.deepEqual(extractSameOriginLinks('<a href="/a">A</a>', 'not a url'), []);
});

test('fetchWebClient fetches with header token and extracts same-origin links offline', async () => {
  const captured: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    captured.push({ url: String(input), init: init ?? {} });
    return new Response('<html><a href="/a">A</a><a href="https://other.test/b">B</a></html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }) as typeof fetch;

  const client = fetchWebClient({ headerToken: 'tok', fetchImpl });
  const page = await client.fetchPage('https://docs.test/root/');

  assert.equal(page.status, 200);
  assert.equal(page.contentType, 'text/html; charset=utf-8');
  assert.ok(page.body.includes('href="/a"'));
  assert.deepEqual(page.links, ['https://docs.test/a']);
  assert.equal(captured.length, 1);
  const headers = captured[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer tok');
  assert.equal(headers['User-Agent'], 'brainrouter-web-connector');
});
