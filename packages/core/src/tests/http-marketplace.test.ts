/**
 * ADR-053 P1/P3 — the HTTP (tarball-over-HTTPS) marketplace fetch: SSRF guard,
 * bounded download, real tar extraction (via an injected local tarball), and the
 * ADR-052 P4.6 `headersHelper` auth. All exercised with an injected fetch — no
 * network, no real registry.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fetchHttpMarketplace, buildMarketplaceHeaders } from '../plugin/httpMarketplace.js';
import type { MarketplaceSource } from '../config/configTypes.js';

/** Build a real .tgz containing a marketplace manifest, return its bytes. */
function makeCatalogTarball(): Buffer {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-src-'));
  fs.writeFileSync(path.join(src, 'brainrouter-marketplace.json'), JSON.stringify({ name: 'acme', plugins: [{ name: 'p1', source: './p1' }] }));
  const tgz = path.join(src, 'out.tgz');
  const r = spawnSync('tar', ['-czf', tgz, '-C', src, 'brainrouter-marketplace.json'], { encoding: 'utf8' });
  assert.equal(r.status, 0, 'tar czf succeeded');
  const bytes = fs.readFileSync(tgz);
  fs.rmSync(src, { recursive: true, force: true });
  return bytes;
}

const httpEntry = (extra: Partial<MarketplaceSource> = {}): MarketplaceSource =>
  ({ name: 'acme-http', sourceType: 'http', source: 'https://cdn.example.com/catalog.tgz', ...extra });

test('fetchHttpMarketplace downloads, extracts, and returns a dir with the manifest', async () => {
  const bytes = makeCatalogTarball();
  const res = await fetchHttpMarketplace(httpEntry(), {
    validateUrl: async () => {}, // allow (SSRF gate tested separately)
    fetchImpl: (async () => new Response(new Uint8Array(bytes), { status: 200 })) as unknown as typeof fetch,
  });
  assert.ok(res.ok, `fetch ok: ${res.ok ? '' : res.error}`);
  if (res.ok) {
    assert.ok(fs.existsSync(path.join(res.fetched.dir, 'brainrouter-marketplace.json')), 'the manifest was extracted');
    assert.ok(!fs.existsSync(path.join(res.fetched.dir, 'catalog.tgz')), 'the tarball was cleaned up');
    res.fetched.cleanup?.();
    assert.ok(!fs.existsSync(res.fetched.dir), 'cleanup removed the staging dir');
  }
});

test('a blocked origin is a NAMED error, never a silent fetch', async () => {
  let fetched = false;
  const res = await fetchHttpMarketplace(httpEntry({ source: 'http://169.254.169.254/x.tgz' }), {
    validateUrl: async () => { throw new Error('Cloud metadata targets are never valid upstreams.'); },
    fetchImpl: (async () => { fetched = true; return new Response(new Uint8Array()); }) as unknown as typeof fetch,
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /blocked HTTP marketplace "acme-http".*metadata/);
  assert.equal(fetched, false, 'the fetch never ran for a blocked origin');
});

test('a tarball over the byte cap is refused, not written', async () => {
  const big = Buffer.alloc(5000);
  const res = await fetchHttpMarketplace(httpEntry(), {
    validateUrl: async () => {},
    maxBytes: 1024,
    fetchImpl: (async () => new Response(new Uint8Array(big), { status: 200 })) as unknown as typeof fetch,
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /exceeds 1024 bytes/);
});

test('headersHelper mints request headers that reach the fetch (P4.6)', async () => {
  const bytes = makeCatalogTarball();
  let seenAuth: string | undefined;
  const res = await fetchHttpMarketplace(httpEntry({ headersHelper: 'echo-token' }), {
    validateUrl: async () => {},
    runHeadersHelper: () => ({ ok: true, headers: { Authorization: 'Bearer minted-123' } }),
    fetchImpl: (async (_u: string, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      seenAuth = h.get('authorization') ?? undefined;
      return new Response(new Uint8Array(bytes), { status: 200 });
    }) as unknown as typeof fetch,
  });
  assert.ok(res.ok);
  assert.equal(seenAuth, 'Bearer minted-123', 'the minted token reached the request');
  if (res.ok) res.fetched.cleanup?.();
});

test('buildMarketplaceHeaders: absent helper ⇒ no headers; a failing helper ⇒ error', () => {
  assert.deepEqual(buildMarketplaceHeaders(httpEntry()), { ok: true, headers: {} });
  const failed = buildMarketplaceHeaders(httpEntry({ headersHelper: 'x' }), { runHeadersHelper: () => ({ ok: false, error: 'boom' }) });
  assert.deepEqual(failed, { ok: false, error: 'boom' });
});

// ADR-053 P3 — the async install seam: updateMarketplaceIn drives an http catalog
// through fetchMarketplaceAsync exactly like a git one.
test('updateMarketplaceIn refreshes an http marketplace via the async seam', async () => {
  const { updateMarketplaceIn } = await import('../plugin/marketplace.js');
  const bytes = makeCatalogTarball();
  const cfg: any = { activeServer: '', servers: {}, cli: { plugins: { marketplaces: [httpEntry()] } } };
  const res = await updateMarketplaceIn(cfg, 'acme-http', {
    validateUrl: async () => {},
    fetchImpl: (async () => new Response(new Uint8Array(bytes), { status: 200 })) as unknown as typeof fetch,
  });
  assert.ok(res.ok, `http marketplace update ok: ${res.ok ? '' : res.error}`);
  if (res.ok) assert.equal(res.plugins, 1, 'the catalog manifest (1 plugin) was read from the extracted tarball');
});
