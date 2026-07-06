import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildAppJwt,
  resolveInstallationId,
  mintInstallationToken,
  createInstallationTokenCache,
  loadGithubAppCredentials,
} from '../track/githubSync/githubApp.js';

// One 2048-bit RSA keypair for all signing tests (PKCS#8 PEM, as GitHub issues).
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const CREDS = { appId: '123456', privateKey };

function decodeSeg(seg: string): any {
  return JSON.parse(Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

/** A fetch-like mock that returns queued JSON responses and counts calls. */
function fakeFetch(responses: Array<{ ok?: boolean; status?: number; body: unknown }>): {
  impl: any; calls: Array<{ url: string; init?: any }>;
} {
  const calls: Array<{ url: string; init?: any }> = [];
  let i = 0;
  const impl = async (url: string, init?: any) => {
    calls.push({ url, init });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return { ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.body, text: async () => JSON.stringify(r.body) };
  };
  return { impl, calls };
}

test('GH-APP buildAppJwt: RS256 header, iss=appId, iat backdated, exp≤10min, verifiable signature', () => {
  const now = 1_800_000_000;
  const jwt = buildAppJwt(CREDS, now);
  const [h, p, s] = jwt.split('.');
  const header = decodeSeg(h);
  const payload = decodeSeg(p);
  assert.equal(header.alg, 'RS256');
  assert.equal(header.typ, 'JWT');
  assert.equal(payload.iss, '123456');
  assert.equal(payload.iat, now - 60, 'iat backdated 60s for clock skew');
  assert.ok(payload.exp - payload.iat <= 10 * 60, 'exp within GitHub 10-min cap');
  assert.ok(payload.exp > now, 'not already expired');
  // The signature verifies against the public key over `${h}.${p}`.
  const ok = crypto.createVerify('RSA-SHA256').update(`${h}.${p}`).verify(
    publicKey,
    Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
  );
  assert.equal(ok, true, 'signature verifies with the App public key');
});

test('GH-APP resolveInstallationId: fixed id short-circuits (no fetch); else resolves per repo', async () => {
  const now = () => 1_800_000_000;
  // Fixed installation id → no network.
  const fixed = fakeFetch([{ body: {} }]);
  const id = await resolveInstallationId({ ...CREDS, installationId: '42' }, { owner: 'acme', repo: 'core' }, { fetchImpl: fixed.impl, nowSec: now });
  assert.equal(id, '42');
  assert.equal(fixed.calls.length, 0, 'no fetch when installationId is fixed');
  // No fixed id → GET /repos/{owner}/{repo}/installation.
  const resolved = fakeFetch([{ body: { id: 99 } }]);
  const id2 = await resolveInstallationId(CREDS, { owner: 'acme', repo: 'core' }, { fetchImpl: resolved.impl, nowSec: now });
  assert.equal(id2, '99');
  assert.match(resolved.calls[0].url, /\/repos\/acme\/core\/installation$/);
});

test('GH-APP mintInstallationToken: POSTs access_tokens, returns token + expiry', async () => {
  const now = () => 1_800_000_000;
  const f = fakeFetch([{ body: { token: 'ghs_abc', expires_at: '2030-01-01T00:00:00Z' } }]);
  const out = await mintInstallationToken(CREDS, '42', { fetchImpl: f.impl, nowSec: now });
  assert.equal(out.token, 'ghs_abc');
  assert.equal(out.expiresAt, '2030-01-01T00:00:00Z');
  assert.equal(out.installationId, '42');
  assert.equal(f.calls[0].init.method, 'POST');
  assert.match(f.calls[0].url, /\/app\/installations\/42\/access_tokens$/);
});

test('GH-APP token cache: mints once, reuses while fresh, refreshes near expiry', async () => {
  let nowSec = 1_800_000_000;
  const iso = (sec: number): string => new Date(sec * 1000).toISOString();
  // Every mint returns a token expiring 1h out from "now".
  const f = {
    calls: 0,
    impl: async (url: string, init?: any) => {
      const isMint = /access_tokens$/.test(url);
      if (isMint) f.calls += 1;
      return {
        ok: true, status: 200,
        json: async () => isMint ? { token: `tok${f.calls}`, expires_at: iso(nowSec + 3600) } : { id: 7 },
        text: async () => '',
      };
    },
  };
  const cache = createInstallationTokenCache({ fetchImpl: f.impl as any, nowSec: () => nowSec });
  const t1 = await cache.getToken(CREDS, { owner: 'acme', repo: 'core' });
  const t2 = await cache.getToken(CREDS, { owner: 'acme', repo: 'core' });
  assert.equal(t1, 'tok1');
  assert.equal(t2, 'tok1', 'second call reuses the cached token');
  assert.equal(f.calls, 1, 'only one mint while fresh');
  // Advance to within the 5-min refresh window of expiry → refresh.
  nowSec += 3600 - 60;
  const t3 = await cache.getToken(CREDS, { owner: 'acme', repo: 'core' });
  assert.equal(t3, 'tok2', 'refreshed near expiry');
  assert.equal(f.calls, 2);
});

test('GH-APP loadGithubAppCredentials: needs appId + a key source; reads privateKeyPath', () => {
  assert.equal(loadGithubAppCredentials({}), undefined, 'no appId → undefined');
  assert.equal(loadGithubAppCredentials({ appId: '1' }), undefined, 'appId but no key → undefined');
  const inline = loadGithubAppCredentials({ appId: '1', privateKey });
  assert.ok(inline);
  assert.equal(inline!.appId, '1');
  // privateKeyPath is read from disk.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghapp-'));
  try {
    const keyPath = path.join(dir, 'app.pem');
    fs.writeFileSync(keyPath, privateKey, 'utf8');
    const fromPath = loadGithubAppCredentials({ appId: '2', privateKeyPath: keyPath, installationId: '9' });
    assert.ok(fromPath);
    assert.ok(fromPath!.privateKey.includes('PRIVATE KEY'));
    assert.equal(fromPath!.installationId, '9');
    // Unreadable path → undefined (never throws → PAT fallback).
    assert.equal(loadGithubAppCredentials({ appId: '3', privateKeyPath: path.join(dir, 'nope.pem') }), undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
