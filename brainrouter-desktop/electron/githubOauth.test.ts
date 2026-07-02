import test from 'node:test';
import assert from 'node:assert/strict';
import { requestDeviceCode, pollOnce, GITHUB_OAUTH_SCOPE } from './githubOauth.js';

type Resp = { ok: boolean; status: number; json: () => Promise<unknown> };
const resp = (status: number, body: unknown): Resp => ({ ok: status < 400, status, json: async () => body });

/** A scripted fetch: pops one queued response per call, records request bodies. */
function scriptedFetch(queue: Resp[]) {
  const calls: Array<{ url: string; body?: unknown }> = [];
  const fetchImpl = async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    const next = queue.shift();
    if (!next) throw new Error('no scripted response left');
    return next;
  };
  return { fetchImpl, calls };
}

test('requestDeviceCode maps the grant + defaults', async () => {
  const { fetchImpl, calls } = scriptedFetch([
    resp(200, { device_code: 'dev-1', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', interval: 5, expires_in: 900 }),
  ]);
  const grant = await requestDeviceCode('client-1', { fetchImpl, nowMs: 1_000_000 });
  assert.equal(grant.deviceCode, 'dev-1');
  assert.equal(grant.userCode, 'ABCD-1234');
  assert.equal(grant.intervalSec, 5);
  assert.equal(grant.expiresAtMs, 1_000_000 + 900_000);
  assert.equal((calls[0].body as { scope: string }).scope, GITHUB_OAUTH_SCOPE);
});

test('requestDeviceCode surfaces endpoint errors', async () => {
  const { fetchImpl } = scriptedFetch([resp(422, { error: 'unauthorized_client', error_description: 'bad client id' })]);
  await assert.rejects(() => requestDeviceCode('nope', { fetchImpl }), /bad client id/);
});

test('pollOnce: authorization_pending keeps the cadence', async () => {
  const { fetchImpl } = scriptedFetch([resp(200, { error: 'authorization_pending' })]);
  const r = await pollOnce('c', { deviceCode: 'd', intervalSec: 5, expiresAtMs: Date.now() + 60_000 }, { fetchImpl });
  assert.deepEqual(r, { status: 'pending', nextIntervalSec: 5 });
});

test('pollOnce: slow_down grows the interval by 5s (RFC 8628)', async () => {
  const { fetchImpl } = scriptedFetch([resp(200, { error: 'slow_down' })]);
  const r = await pollOnce('c', { deviceCode: 'd', intervalSec: 5, expiresAtMs: Date.now() + 60_000 }, { fetchImpl });
  assert.deepEqual(r, { status: 'pending', nextIntervalSec: 10 });
});

test('pollOnce: success returns the token payload', async () => {
  const { fetchImpl, calls } = scriptedFetch([resp(200, { access_token: 'gho_x', scope: 'repo,read:org', token_type: 'bearer' })]);
  const r = await pollOnce('c', { deviceCode: 'd', intervalSec: 5, expiresAtMs: Date.now() + 60_000 }, { fetchImpl });
  assert.equal(r.status, 'authorized');
  assert.equal((r as { accessToken: string }).accessToken, 'gho_x');
  assert.equal((calls[0].body as { grant_type: string }).grant_type, 'urn:ietf:params:oauth:grant-type:device_code');
});

test('pollOnce: expired_token / access_denied are terminal; local expiry short-circuits', async () => {
  const expired = await pollOnce('c', { deviceCode: 'd', intervalSec: 5, expiresAtMs: 10 }, { nowMs: 20, fetchImpl: scriptedFetch([]).fetchImpl });
  assert.deepEqual(expired, { status: 'expired' });
  const { fetchImpl: f1 } = scriptedFetch([resp(200, { error: 'expired_token' })]);
  assert.deepEqual(await pollOnce('c', { deviceCode: 'd', intervalSec: 5, expiresAtMs: Date.now() + 60_000 }, { fetchImpl: f1 }), { status: 'expired' });
  const { fetchImpl: f2 } = scriptedFetch([resp(200, { error: 'access_denied' })]);
  assert.deepEqual(await pollOnce('c', { deviceCode: 'd', intervalSec: 5, expiresAtMs: Date.now() + 60_000 }, { fetchImpl: f2 }), { status: 'denied' });
});

test('pollOnce: a network blip stays pending (retryable)', async () => {
  const fetchImpl = async () => { throw new Error('ECONNRESET'); };
  const r = await pollOnce('c', { deviceCode: 'd', intervalSec: 7, expiresAtMs: Date.now() + 60_000 }, { fetchImpl: fetchImpl as never });
  assert.deepEqual(r, { status: 'pending', nextIntervalSec: 7 });
});
