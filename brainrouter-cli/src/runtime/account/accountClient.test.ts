import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AccountApiHttpError,
  accountApiRequest,
} from './accountClient.js';

test('shared CLI account transport preserves bearer and JSON request behavior', async () => {
  let request: { url: string; method?: string; authorization: string | null; body?: unknown } | undefined;
  const result = await accountApiRequest<{ ok: boolean }>(
    { baseUrl: 'https://brain.example', apiKey: 'secret' },
    'POST',
    '/api/example',
    { value: 1 },
    async (input, init) => {
      request = {
        url: String(input),
        method: init?.method,
        authorization: new Headers(init?.headers).get('authorization'),
        body: JSON.parse(String(init?.body)),
      };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  );
  assert.deepEqual(request, {
    url: 'https://brain.example/api/example',
    method: 'POST',
    authorization: 'Bearer secret',
    body: { value: 1 },
  });
  assert.deepEqual(result, { ok: true });
});

test('shared CLI account transport retains status and server error text', async () => {
  await assert.rejects(
    accountApiRequest(
      { baseUrl: 'https://brain.example', apiKey: 'secret' },
      'GET',
      '/api/example',
      undefined,
      async () => new Response(JSON.stringify({ error: 'Denied' }), { status: 403 }),
    ),
    (error: unknown) => error instanceof AccountApiHttpError
      && error.status === 403
      && error.message === 'Denied',
  );
});
