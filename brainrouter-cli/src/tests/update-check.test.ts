import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareSemver, formatUpdateBanner, isCacheFresh, checkForUpdate } from '../runtime/updateCheck.js';

test('CLI-22 compareSemver: numeric dotted compare, pre-release tag ignored', () => {
  assert.equal(compareSemver('0.4.4', '0.4.5'), -1);
  assert.equal(compareSemver('0.4.5', '0.4.4'), 1);
  assert.equal(compareSemver('0.4.4', '0.4.4'), 0);
  assert.equal(compareSemver('1.0.0', '0.9.9'), 1);
  assert.equal(compareSemver('0.4.4-beta.1', '0.4.4'), 0); // tag ignored
  assert.equal(compareSemver('v0.4.4', '0.4.4'), 0); // leading v ok
});

test('CLI-22 formatUpdateBanner: empty when current >= latest, message when behind', () => {
  assert.equal(formatUpdateBanner('0.4.4', '0.4.4', 'cmd'), '');
  assert.equal(formatUpdateBanner('0.5.0', '0.4.4', 'cmd'), '');
  const b = formatUpdateBanner('0.4.4', '0.5.0', 'npm i -g x@latest');
  assert.match(b, /0\.5\.0 is available/);
  assert.match(b, /you have 0\.4\.4/);
  assert.match(b, /npm i -g x@latest/);
});

test('CLI-22 isCacheFresh: within window fresh, beyond stale, missing stale', () => {
  const now = Date.parse('2026-05-31T12:00:00.000Z');
  assert.equal(isCacheFresh('2026-05-31T11:00:00.000Z', now, 24 * 3600_000), true);
  assert.equal(isCacheFresh('2026-05-29T11:00:00.000Z', now, 24 * 3600_000), false);
  assert.equal(isCacheFresh(undefined, now, 24 * 3600_000), false);
});

test('CLI-22 checkForUpdate: uses injected fetcher, writes cache, then serves from fresh cache (no re-fetch)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-'));
  const cacheFile = path.join(dir, 'update-check.json');
  const now = Date.parse('2026-05-31T12:00:00.000Z');
  try {
    let fetches = 0;
    const fetchLatest = async () => { fetches++; return '0.5.0'; };
    const r1 = await checkForUpdate({ current: '0.4.4', nowMs: now, cacheFile, fetchLatest });
    assert.ok(r1 && r1.behind && r1.latest === '0.5.0');
    assert.equal(fetches, 1);
    assert.ok(fs.existsSync(cacheFile), 'cache written');

    // Within the window → served from cache, fetcher NOT called again.
    const r2 = await checkForUpdate({ current: '0.4.4', nowMs: now + 3600_000, cacheFile, fetchLatest });
    assert.ok(r2 && r2.latest === '0.5.0');
    assert.equal(fetches, 1, 'throttled — no second fetch within the window');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI-22 checkForUpdate: offline (fetcher returns null) with no cache → null', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-off-'));
  try {
    const r = await checkForUpdate({ current: '0.4.4', cacheFile: path.join(dir, 'c.json'), fetchLatest: async () => null });
    assert.equal(r, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
