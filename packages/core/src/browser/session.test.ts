import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getUiTestSession, readManifestFromDisk, manifestPathFor, __resetUiTestSessionsForTests } from './session.js';
import type { UiMap } from './types.js';

const MANIFEST: UiMap = {
  version: 1,
  generatedAt: 'x',
  screens: [
    {
      id: 'login',
      title: 'Login',
      platform: 'web',
      route: '/login',
      elements: [{ id: 'login-submit', testID: 'login-submit', type: 'button', action: 'tap' }],
    },
  ],
};

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'uitest-sess-'));
}

test('getUiTestSession is a per-root singleton', () => {
  __resetUiTestSessionsForTests();
  const a = getUiTestSession('C:/ws/one');
  const b = getUiTestSession('C:/ws/one');
  const c = getUiTestSession('C:/ws/two');
  assert.equal(a, b);
  assert.notEqual(a, c);
  __resetUiTestSessionsForTests();
});

test('baseUrl and in-memory manifest are shared through the session', () => {
  __resetUiTestSessionsForTests();
  const s = getUiTestSession('C:/ws/mem');
  s.baseUrl = '  http://localhost:5173  ';
  s.setManifest(MANIFEST);
  assert.equal(s.baseUrl, 'http://localhost:5173'); // trimmed
  assert.equal(s.manifest()?.screens[0].id, 'login');
  // the shared command layer reads the same manifest
  assert.deepEqual(s.layer.listScreens().map((x) => x.id), ['login']);
  __resetUiTestSessionsForTests();
});

test('manifest() falls back to ui-map.json on disk', () => {
  __resetUiTestSessionsForTests();
  const root = tmpRoot();
  const p = manifestPathFor(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(MANIFEST), 'utf8');
  assert.equal(readManifestFromDisk(root)?.screens[0].title, 'Login');
  const s = getUiTestSession(root);
  assert.equal(s.manifest()?.screens[0].title, 'Login'); // no in-memory set → disk
  __resetUiTestSessionsForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

test('navigate through the shared layer produces an absolute URL from the base', async () => {
  __resetUiTestSessionsForTests();
  const s = getUiTestSession('C:/ws/nav');
  s.baseUrl = 'http://localhost:3000';
  s.setManifest(MANIFEST);
  // Swap in a recording backend so we observe the command without a browser.
  const calls: unknown[] = [];
  (s.driver as unknown as { perform: (c: unknown) => Promise<unknown> }).perform = async (c) => {
    calls.push(c);
    return { ok: true, status: 'ok', command: 'navigate', durationMs: 1 };
  };
  await s.layer.navigate('login');
  assert.deepEqual(calls[0], { kind: 'navigate', screen: 'login', url: 'http://localhost:3000/login' });
  __resetUiTestSessionsForTests();
});
