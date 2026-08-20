import test from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDER_CATALOG } from '../provider/catalog.js';
import { BUILTIN_PROVIDERS, findProviderByEndpoint, withApiVersion } from '../provider/providers/index.js';

// 0.4.17 — Onyx-parity expanded provider list. These five branded providers were
// added as code modules (endpoint identity + wire only; no model catalogs).
const NEW = [
  { id: 'anthropic',  endpoint: 'https://api.anthropic.com/v1',                         envKey: 'ANTHROPIC_API_KEY' },
  { id: 'gemini',     endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai', envKey: 'GEMINI_API_KEY' },
  { id: 'openrouter', endpoint: 'https://openrouter.ai/api/v1',                          envKey: 'OPENROUTER_API_KEY' },
  { id: 'zenmux',     endpoint: 'https://zenmux.ai/api/v1',                              envKey: 'ZENMUX_API_KEY' },
  { id: 'groq',       endpoint: 'https://api.groq.com/openai/v1',                        envKey: 'GROQ_API_KEY' },
  { id: 'azure',      endpoint: '',                                                      envKey: 'AZURE_OPENAI_API_KEY' },
] as const;

test('PROVIDER_CATALOG exposes the new branded providers (picker-visible) with the right endpoints/envKeys', () => {
  for (const want of NEW) {
    const got = PROVIDER_CATALOG.find((p) => p.id === want.id);
    assert.ok(got, `catalog missing ${want.id}`);
    assert.equal(got!.endpoint, want.endpoint, `${want.id} endpoint`);
    assert.equal(got!.envKey, want.envKey, `${want.id} envKey`);
    assert.equal(got!.local, false, `${want.id} is a cloud provider`);
  }
});

test('builtin modules describe identity only — no model catalogs leak into providers', () => {
  for (const want of NEW) {
    const def = BUILTIN_PROVIDERS.find((p) => p.id === want.id);
    assert.ok(def, `builtin missing ${want.id}`);
    assert.equal(def!.pickerVisible, true, `${want.id} should be picker-visible`);
    assert.equal((def as { models?: unknown }).models, undefined, `${want.id} must NOT own a model catalog`);
  }
});

test('findProviderByEndpoint resolves the new cloud providers by their endpoint', () => {
  assert.equal(findProviderByEndpoint('https://api.groq.com/openai/v1')?.id, 'groq');
  assert.equal(findProviderByEndpoint('https://api.anthropic.com/v1')?.id, 'anthropic');
  assert.equal(findProviderByEndpoint('https://openrouter.ai/api/v1')?.id, 'openrouter');
  assert.equal(findProviderByEndpoint('https://generativelanguage.googleapis.com/v1beta/openai')?.id, 'gemini');
  // trailing slash / bare-host shapes still normalize to the same provider.
  assert.equal(findProviderByEndpoint('https://api.groq.com/openai/v1/')?.id, 'groq');
});

test('ADR-043: the activated cloud providers declare the edge-egress tunnel capability', () => {
  // The gateway reads egress config via findProviderByEndpoint — so activation is
  // proven by the def it resolves declaring clientTunnel in a tunnelling mode.
  for (const endpoint of ['https://api.openai.com/v1', 'https://api.anthropic.com/v1']) {
    const def = findProviderByEndpoint(endpoint);
    assert.equal(def?.egressCapabilities?.clientTunnel, true, `${endpoint} must declare clientTunnel`);
    assert.equal(def?.egressMode, 'auto', `${endpoint} must be egressMode 'auto'`);
  }
  // A provider that has NOT been activated stays server-only (no accidental tunnelling).
  assert.equal(findProviderByEndpoint('https://api.groq.com/openai/v1')?.egressCapabilities?.clientTunnel, undefined);
});

test('azure (empty endpoint) is NOT endpoint-matchable — it resolves by provider id only', () => {
  assert.equal(findProviderByEndpoint(''), undefined);
  assert.equal(findProviderByEndpoint(undefined), undefined);
});

test('deepseek stays hidden from the picker (reached endpoint-aware via OpenAI-compatible)', () => {
  assert.equal(PROVIDER_CATALOG.some((p) => p.id === 'deepseek'), false, 'deepseek must not appear in the picker catalog');
  assert.equal(BUILTIN_PROVIDERS.find((p) => p.id === 'deepseek')?.pickerVisible, false);
});

test('withApiVersion: blank/absent ⇒ URL unchanged; set ⇒ appended with the right separator', () => {
  const base = 'https://x.openai.azure.com/openai/v1/chat/completions';
  assert.equal(withApiVersion(base, undefined), base, 'absent ⇒ unchanged');
  assert.equal(withApiVersion(base, '   '), base, 'blank ⇒ unchanged');
  assert.equal(withApiVersion(base, '2024-02-01'), base + '?api-version=2024-02-01', 'no query ⇒ ?');
  assert.equal(withApiVersion(base + '?foo=1', '2024-02-01'), base + '?foo=1&api-version=2024-02-01', 'existing query ⇒ &');
  assert.equal(withApiVersion(base, 'a b'), base + '?api-version=a%20b', 'value is url-encoded');
});
