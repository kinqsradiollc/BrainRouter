import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { STEALTH_INIT_SCRIPT } from './browserStealth.js';

test('STEALTH_INIT_SCRIPT is syntactically valid JS', () => {
  assert.doesNotThrow(() => new vm.Script(STEALTH_INIT_SCRIPT));
});

test('covers the key automation-fingerprint tells', () => {
  for (const marker of ['webdriver', 'languages', 'window.chrome', 'plugins', 'permissions', 'getParameter', 'hardwareConcurrency']) {
    assert.ok(STEALTH_INIT_SCRIPT.includes(marker), `missing patch: ${marker}`);
  }
});

test('never throws into the page: patches navigator.webdriver to false and survives a hostile globalThis', () => {
  // Run the script against a minimal browser-like sandbox; it must not throw and
  // must leave navigator.webdriver === false.
  const navigator: Record<string, unknown> = { webdriver: true, permissions: { query: () => Promise.resolve({}) } };
  const sandbox: Record<string, unknown> = {
    Navigator: function () {},
    navigator,
    window: {},
    Notification: { permission: 'default' },
    WebGLRenderingContext: undefined,
    WebGL2RenderingContext: undefined,
  };
  (sandbox.Navigator as { prototype: Record<string, unknown> }).prototype = navigator;
  const context = vm.createContext(sandbox);
  assert.doesNotThrow(() => new vm.Script(STEALTH_INIT_SCRIPT).runInContext(context));
  assert.equal(navigator.webdriver, false);
});

test('does NOT implement CAPTCHA/anti-abuse defeat (scope guard)', () => {
  const lower = STEALTH_INIT_SCRIPT.toLowerCase();
  for (const forbidden of ['captcha', 'turnstile', 'recaptcha', 'humanize']) {
    assert.ok(!lower.includes(forbidden), `stealth script must not reference ${forbidden}`);
  }
});
