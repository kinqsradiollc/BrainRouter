/**
 * ADR-053 D1/D3 — fetch an HTTP (tarball-over-HTTPS) plugin marketplace, and mint
 * the private-catalog auth headers (ADR-052 P4.6). Kept separate from the sync
 * `fetchMarketplace` so the async download + extraction path unit-tests directly
 * with an injected fetch and a local tarball — no network, no real registry.
 *
 * Safety: the URL passes ADR-039's `validateUpstreamTarget` (HTTPS + the upstream
 * allowlist; a blocked origin returns a NAMED error, never a silent fetch); the
 * download is byte-bounded so a hostile URL can't exhaust disk; the tarball is
 * DATA — extracted and read, never executed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { validateUpstreamTarget } from '../provider/routing/transport.js';
import { stagingDir } from './paths.js';
import type { MarketplaceSource } from '../config/configTypes.js';
import type { FetchMarketplaceResult } from './marketplace.js';

/** 64 MB is a generous ceiling for a plugin catalog tarball; a hostile URL can't grow it. */
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

export interface HttpMarketplaceDeps {
  /** Injected for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injected SSRF gate; defaults to ADR-039's `validateUpstreamTarget`. */
  validateUrl?: (url: string) => Promise<void>;
  /** Injected extractor; defaults to `tar -xzf <tarball> -C <destDir>`. */
  extract?: (tarball: string, destDir: string) => { ok: boolean; error?: string };
  /** Injected header-helper runner; defaults to a spawned command whose stdout is a JSON header map. */
  runHeadersHelper?: (command: string) => { ok: boolean; headers?: Record<string, string>; error?: string };
  /** Download byte ceiling. */
  maxBytes?: number;
}

function rmrf(target: string): void {
  try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
}

function defaultExtract(tarball: string, destDir: string): { ok: boolean; error?: string } {
  const r = spawnSync('tar', ['-xzf', tarball, '-C', destDir], { encoding: 'utf8' });
  if (r.status !== 0) return { ok: false, error: `tar extraction failed: ${(r.stderr || '').trim() || `exit ${r.status}`}` };
  return { ok: true };
}

function defaultRunHeadersHelper(command: string): { ok: boolean; headers?: Record<string, string>; error?: string } {
  const r = spawnSync(command, { shell: true, encoding: 'utf8', timeout: 15_000 });
  if (r.status !== 0) return { ok: false, error: `headersHelper failed: ${(r.stderr || '').trim() || `exit ${r.status}`}` };
  try {
    const parsed = JSON.parse(r.stdout || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: 'headersHelper stdout is not a JSON header object' };
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof k === 'string' && typeof v === 'string') headers[k] = v;
    }
    return { ok: true, headers };
  } catch {
    return { ok: false, error: 'headersHelper stdout is not valid JSON' };
  }
}

/**
 * ADR-052 P4.6 — resolve the request headers for a marketplace fetch. A
 * `headersHelper` (a command minting e.g. a short-lived bearer token) runs before
 * the fetch; its secret lives in Settings, never in `config.json`. Absent ⇒ an
 * unauthenticated fetch (a public catalog).
 */
export function buildMarketplaceHeaders(
  entry: MarketplaceSource,
  deps: HttpMarketplaceDeps = {},
): { ok: true; headers: Record<string, string> } | { ok: false; error: string } {
  const helper = (entry as { headersHelper?: unknown }).headersHelper;
  if (typeof helper !== 'string' || !helper.trim()) return { ok: true, headers: {} };
  const run = deps.runHeadersHelper ?? defaultRunHeadersHelper;
  const r = run(helper.trim());
  if (!r.ok) return { ok: false, error: r.error ?? 'headersHelper failed' };
  return { ok: true, headers: r.headers ?? {} };
}

/** Read a fetch Response body into a Buffer, refusing once it exceeds `maxBytes`. */
async function readBounded(res: Response, maxBytes: number): Promise<{ ok: true; bytes: Buffer } | { ok: false; error: string }> {
  const reader = res.body?.getReader();
  if (!reader) {
    const ab = await res.arrayBuffer();
    if (ab.byteLength > maxBytes) return { ok: false, error: `marketplace tarball exceeds ${maxBytes} bytes` };
    return { ok: true, bytes: Buffer.from(ab) };
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { try { await reader.cancel(); } catch { /* already done */ } return { ok: false, error: `marketplace tarball exceeds ${maxBytes} bytes` }; }
    chunks.push(Buffer.from(value));
  }
  return { ok: true, bytes: Buffer.concat(chunks) };
}

/**
 * Fetch an `http` marketplace: SSRF-validate → (auth headers) → download (bounded)
 * → extract → return the staging dir, same shape as the git path.
 */
export async function fetchHttpMarketplace(
  entry: MarketplaceSource,
  deps: HttpMarketplaceDeps = {},
): Promise<FetchMarketplaceResult> {
  const url = entry.source;

  // SSRF guard (ADR-039). A blocked origin is a NAMED error, never a silent fetch.
  const validate = deps.validateUrl ?? (async (u: string) => { await validateUpstreamTarget(u); });
  try {
    await validate(url);
  } catch (err) {
    return { ok: false, error: `blocked HTTP marketplace "${entry.name}": ${err instanceof Error ? err.message : String(err)}` };
  }

  const headers = buildMarketplaceHeaders(entry, deps);
  if (!headers.ok) return { ok: false, error: headers.error };

  const fetchImpl = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: headers.headers, redirect: 'follow' });
  } catch (err) {
    return { ok: false, error: `fetching ${url} failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!res.ok) return { ok: false, error: `HTTP ${res.status} fetching ${url}` };

  const read = await readBounded(res, deps.maxBytes ?? DEFAULT_MAX_BYTES);
  if (!read.ok) return { ok: false, error: read.error };

  const dir = path.join(stagingDir(), `market-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  const tarPath = path.join(dir, 'catalog.tgz');
  try {
    fs.writeFileSync(tarPath, read.bytes);
    const extract = deps.extract ?? defaultExtract;
    const ex = extract(tarPath, dir);
    if (!ex.ok) { rmrf(dir); return { ok: false, error: ex.error ?? 'extraction failed' }; }
    fs.rmSync(tarPath, { force: true });
  } catch (err) {
    rmrf(dir);
    return { ok: false, error: `staging ${entry.name} failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true, fetched: { dir, cleanup: () => rmrf(dir) } };
}
