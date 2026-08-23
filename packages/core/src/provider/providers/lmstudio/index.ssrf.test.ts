import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchLmStudioModels, deriveLmStudioModelsUrl } from './index.js';

// ADR-039 — the LM Studio native enrichment was the "fourth path": a bare fetch
// over a BYOK baseUrl, bypassing the DNS-pinned upstream policy the three other
// probe paths use. It now takes an injected fetch so modelProbe can bind it to
// the policy.
test('ADR-039: fetchLmStudioModels uses the injected fetch and targets the derived native URL', async () => {
  const endpoint = 'http://127.0.0.1:1234/v1';
  const expected = deriveLmStudioModelsUrl(endpoint);
  const calls: string[] = [];
  const spyFetch = async (url: string, _init: RequestInit): Promise<Response> => {
    calls.push(url);
    return new Response(JSON.stringify({ models: [] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  const result = await fetchLmStudioModels(endpoint, spyFetch);
  assert.deepEqual(calls, [expected], 'the injected (policy-bound) fetch must receive the derived URL');
  assert.deepEqual(result, []);
});

test('ADR-039: a policy that refuses an internal target blocks the SSRF (nothing escapes / is read)', async () => {
  // Mirrors upstreamProbePolicy refusing loopback/metadata in hosted mode: the
  // injected fetch throws before any body is read; fetchLmStudioModels returns null.
  const refusing = async (): Promise<Response> => { throw new Error('Upstream target refused by policy'); };
  const exploit = 'http://127.0.0.1@169.254.169.254/v1'; // userinfo defeats the convenience regex; host is metadata
  const result = await fetchLmStudioModels(exploit, refusing);
  assert.equal(result, null);
});
