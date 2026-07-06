/**
 * Schema contract tests — the manifest and the command result are the spine of
 * the whole system, so we pin both the accept and the reject paths (AC2: every
 * written manifest validates; AC5: malformed driver output is rejected, never
 * surfaced raw).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UiMapSchema, UiCommandResultSchema, CommandSchema, DeviceSchema } from './schema.js';

const validManifest = {
  version: 1,
  generatedAt: '2026-06-29T00:00:00.000Z',
  screens: [
    {
      id: 'login',
      title: 'Login',
      platform: 'web',
      route: '/login',
      filePath: 'src/pages/Login.tsx',
      elements: [
        { id: 'email-field', testID: 'email-field', type: 'input', action: 'type', line: 12 },
        { id: 'login-submit', testID: 'login-submit', type: 'button', action: 'tap', line: 20 },
      ],
    },
  ],
};

test('UiMapSchema accepts a valid manifest', () => {
  const parsed = UiMapSchema.parse(validManifest);
  assert.equal(parsed.screens.length, 1);
  assert.equal(parsed.screens[0].elements[0].action, 'type');
});

test('UiMapSchema applies the default platform', () => {
  const noPlatform = {
    version: 1,
    generatedAt: '2026-06-29T00:00:00.000Z',
    screens: [{ id: 's', title: 'S', elements: [] }],
  };
  const parsed = UiMapSchema.parse(noPlatform);
  assert.equal(parsed.screens[0].platform, 'web');
});

test('UiMapSchema rejects a bad version', () => {
  const r = UiMapSchema.safeParse({ ...validManifest, version: 2 });
  assert.equal(r.success, false);
});

test('UiMapSchema rejects an element missing its testID', () => {
  const bad = {
    version: 1,
    generatedAt: 'x',
    screens: [{ id: 's', title: 'S', elements: [{ id: 'a', type: 'button', action: 'tap' }] }],
  };
  const r = UiMapSchema.safeParse(bad);
  assert.equal(r.success, false);
});

test('UiMapSchema rejects an unknown element type', () => {
  const bad = {
    version: 1,
    generatedAt: 'x',
    screens: [{ id: 's', title: 'S', elements: [{ id: 'a', testID: 'a', type: 'widget', action: 'tap' }] }],
  };
  const r = UiMapSchema.safeParse(bad);
  assert.equal(r.success, false);
});

test('CommandSchema discriminates each command kind', () => {
  assert.equal(CommandSchema.parse({ kind: 'tap', testID: 'x' }).kind, 'tap');
  assert.equal(CommandSchema.parse({ kind: 'type', testID: 'x', text: 'hi' }).kind, 'type');
  assert.equal(CommandSchema.parse({ kind: 'navigate', screen: 'login' }).kind, 'navigate');
  assert.equal(
    CommandSchema.parse({ kind: 'setDevice', device: { name: 'iPhone', width: 390, height: 844 } }).kind,
    'setDevice',
  );
});

test('CommandSchema rejects an unknown kind and a type-command missing text', () => {
  assert.equal(CommandSchema.safeParse({ kind: 'frobnicate' }).success, false);
  assert.equal(CommandSchema.safeParse({ kind: 'type', testID: 'x' }).success, false);
});

test('DeviceSchema requires name + positive integer width/height (agent set-device gate)', () => {
  assert.equal(DeviceSchema.safeParse({ name: 'iPhone', width: 390, height: 844 }).success, true);
  assert.equal(DeviceSchema.safeParse({ name: 'x', width: 390 }).success, false, 'missing height');
  assert.equal(DeviceSchema.safeParse({ name: 'x', width: -1, height: 100 }).success, false, 'non-positive');
  assert.equal(DeviceSchema.safeParse({ name: 'x', width: 1.5, height: 100 }).success, false, 'non-integer');
  assert.equal(DeviceSchema.safeParse({ width: 390, height: 844 }).success, false, 'missing name');
});

test('UiCommandResultSchema accepts a normalized result', () => {
  const r = UiCommandResultSchema.parse({
    ok: true,
    status: 'ok',
    command: 'tap',
    testID: 'login-submit',
    durationMs: 142,
    screenshot: 'runs/login-submit.png',
    a11y: { role: 'button', name: 'Log in' },
    error: null,
    artifacts: { screenshots: ['a.png'], videos: [], logs: [], other: [] },
  });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'ok');
});

test('UiCommandResultSchema rejects a missing durationMs and a bad status', () => {
  assert.equal(UiCommandResultSchema.safeParse({ ok: true, status: 'ok', command: 'tap' }).success, false);
  assert.equal(
    UiCommandResultSchema.safeParse({ ok: false, status: 'kaput', command: 'tap', durationMs: 1 }).success,
    false,
  );
});
