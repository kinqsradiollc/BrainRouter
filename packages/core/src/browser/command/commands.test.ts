import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommandLayer } from './commands.js';
import { StubBackend } from './backend.js';
import type { UiMap } from '../types.js';

const MANIFEST: UiMap = {
  version: 1,
  generatedAt: 'x',
  screens: [
    {
      id: 'login',
      title: 'Login',
      platform: 'web',
      route: '/login',
      elements: [
        { id: 'email-field', testID: 'email-field', type: 'input', action: 'type', label: 'Email' },
        { id: 'login-submit', testID: 'login-submit', type: 'button', action: 'tap' },
      ],
    },
    {
      id: 'home',
      title: 'Home',
      platform: 'web',
      route: '/',
      elements: [{ id: 'logout', testID: 'logout', type: 'button', action: 'tap' }],
    },
  ],
};

const layerWith = (backend: StubBackend) => new CommandLayer(backend, () => MANIFEST);

test('tap routes to the backend with the resolved testID + screen', async () => {
  const be = new StubBackend();
  const r = await layerWith(be).tap('login-submit');
  assert.equal(r.ok, true);
  assert.deepEqual(be.calls, [{ kind: 'tap', testID: 'login-submit', screen: 'login' }]);
});

test('type forwards the text', async () => {
  const be = new StubBackend();
  await layerWith(be).type('email-field', 'me@x.com');
  assert.deepEqual(be.calls[0], { kind: 'type', testID: 'email-field', text: 'me@x.com', screen: 'login' });
});

test('tap on an unknown element errors without calling the backend', async () => {
  const be = new StubBackend();
  const r = await layerWith(be).tap('nope');
  assert.equal(r.ok, false);
  assert.equal(r.status, 'error');
  assert.match(r.error ?? '', /unknown element/);
  assert.equal(be.calls.length, 0);
});

test('navigate resolves the screen route into the command', async () => {
  const be = new StubBackend();
  await layerWith(be).navigate('login');
  assert.deepEqual(be.calls[0], { kind: 'navigate', screen: 'login', url: '/login' });
});

test('navigate to an unknown screen errors without the backend', async () => {
  const be = new StubBackend();
  const r = await layerWith(be).navigate('ghost');
  assert.equal(r.ok, false);
  assert.equal(be.calls.length, 0);
});

test('a backend exception becomes an error result', async () => {
  const be = new StubBackend(() => {
    throw new Error('driver crashed');
  });
  const r = await layerWith(be).tap('login-submit');
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /driver crashed/);
});

test('query helpers read only the manifest', () => {
  const layer = layerWith(new StubBackend());
  assert.deepEqual(
    layer.listScreens(),
    [
      { id: 'login', title: 'Login', route: '/login', elementCount: 2 },
      { id: 'home', title: 'Home', route: '/', elementCount: 1 },
    ],
  );
  assert.equal(layer.getScreen('home')?.elements[0].testID, 'logout');
  const hits = layer.findElement('login');
  assert.deepEqual(hits.map((h) => h.testID), ['login-submit']);
  // label is searchable too
  assert.deepEqual(layer.findElement('email').map((h) => h.testID), ['email-field']);
});
