/**
 * ADR-028 D11 — the planner transport's URL guard.
 *
 * `brainUrl` comes from config rather than the web, so this is defence in
 * depth — but the Electron MAIN process issuing GET/POST with planner content
 * is exactly the sink SSRF is about.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedBrainUrl, createPlannerTransport } from './plannerTransport.js';

test('plain http is allowed ONLY for the machine you are on', () => {
  for (const ok of ['http://localhost:3747', 'http://127.0.0.1:3747', 'http://[::1]:3747']) {
    assert.equal(isAllowedBrainUrl(ok), true, ok);
  }
  // The cases that motivate the check: cloud metadata, an internal admin panel.
  for (const bad of ['http://169.254.169.254/', 'http://10.0.0.5:8080', 'http://admin.internal']) {
    assert.equal(isAllowedBrainUrl(bad), false, bad);
  }
});

test('https is allowed anywhere — that is the deployed case', () => {
  assert.equal(isAllowedBrainUrl('https://brain.example.com'), true);
});

test('a non-http scheme is refused', () => {
  for (const bad of ['file:///etc/passwd', 'ftp://host/', 'not a url', '']) {
    assert.equal(isAllowedBrainUrl(bad), false, bad);
  }
});

test('constructing a transport for a refused URL THROWS rather than sending', () => {
  // Refusing at construction means no code path can hold a transport that
  // points somewhere it should not.
  assert.throws(
    () => createPlannerTransport({ baseUrl: 'http://169.254.169.254/' }),
    /Refusing to sync/,
  );
});

test('authenticated Planner sync keeps the account bearer in the main process request', async () => {
  const originalFetch = globalThis.fetch;
  let authorization: string | null = null;
  let organization: string | null = null;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    authorization = headers.get('authorization');
    organization = headers.get('x-brainrouter-org');
    return new Response(JSON.stringify({ items: [], blocks: [], cursor: '0' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    await createPlannerTransport({
      baseUrl: 'https://brain.example.test',
      token: 'desktop-session-token',
      orgId: 'org-desktop',
    }).pull(undefined);
    assert.equal(authorization, 'Bearer desktop-session-token');
    assert.equal(organization, 'org-desktop');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
