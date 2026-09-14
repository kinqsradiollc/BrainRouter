import test from 'node:test';
import assert from 'node:assert/strict';
import { getCliKnobs, resolveCliKnobs } from '../config/config.js';
import { websearchHandlers } from '../extension/builtin/handlers/websearch.js';

// web_search's HTTP provider is a fallback the person has to OPT INTO. With
// nothing configured, the built-in browser IS the search: a headless context or
// a browser search that found nothing must say so — never surface the default
// provider's "cli.webSearch.google.apiKey is required", which read as a broken
// setup when the real cause was a consent wall or a server/CLI context.

const base = { activeServer: '', servers: {} };

test('explicitlyConfigured: false with nothing set; true for a provider name or any credential/endpoint', () => {
  assert.equal(resolveCliKnobs({ ...base }).webSearch.explicitlyConfigured, false);
  assert.equal(resolveCliKnobs({ ...base, cli: { webSearch: {} } }).webSearch.explicitlyConfigured, false);
  assert.equal(resolveCliKnobs({ ...base, cli: { webSearch: { provider: 'brave' } } }).webSearch.explicitlyConfigured, true);
  assert.equal(resolveCliKnobs({ ...base, cli: { webSearch: { google: { apiKey: 'k' } } } }).webSearch.explicitlyConfigured, true);
  assert.equal(resolveCliKnobs({ ...base, cli: { webSearch: { searxngBaseUrl: 'https://s.example' } } }).webSearch.explicitlyConfigured, true);
  // The default provider name alone does NOT count as configuration.
  assert.equal(resolveCliKnobs({ ...base }).webSearch.provider, 'google_pse');
});

function host(overrides: Record<string, unknown> = {}) {
  return { pentestMode: false, silent: false, browserControlPort: undefined, turnAbort: undefined, ...overrides } as never;
}

test('web_search with no browser and nothing configured explains the context instead of demanding an API key', async (t) => {
  if (getCliKnobs().webSearch.explicitlyConfigured) return t.skip('a real cli.webSearch is configured in this environment');
  const out = String(await websearchHandlers.web_search({ args: { query: 'brainrouter' }, host: host() } as never));
  assert.match(out, /no built-in browser is available in this context/);
  assert.match(out, /cli\.webSearch/);
  assert.doesNotMatch(out, /apiKey is required/);
});

test('web_search when the built-in browser searched but found nothing says so — no provider error', async (t) => {
  if (getCliKnobs().webSearch.explicitlyConfigured) return t.skip('a real cli.webSearch is configured in this environment');
  const port = { request: async () => { throw new Error('consent wall'); } };
  const out = String(await websearchHandlers.web_search({ args: { query: 'brainrouter' }, host: host({ browserControlPort: port }) } as never));
  assert.match(out, /built-in browser ran the search but found no parseable results/);
  assert.match(out, /fetch_url/);
  assert.doesNotMatch(out, /apiKey is required/);
});

test('a provider the person DID configure still reports its own missing field (real misconfiguration)', () => {
  // Pure factory check — no network: brave chosen, key absent.
  const knobs = resolveCliKnobs({ ...base, cli: { webSearch: { provider: 'brave' } } });
  assert.equal(knobs.webSearch.explicitlyConfigured, true);
  assert.equal(knobs.webSearch.provider, 'brave');
});
