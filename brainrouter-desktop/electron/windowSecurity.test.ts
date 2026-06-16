import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedNavigation, allowedOriginFor } from './windowSecurity.js';

const DEV = 'http://localhost:5199';

test('the packaged file:// load is always allowed', () => {
  assert.equal(isAllowedNavigation('file:///Applications/BrainRouter.app/dist/index.html', null), true);
  assert.equal(isAllowedNavigation('file:///x/index.html', DEV), true);
});

test('the dev origin is allowed only when set', () => {
  assert.equal(isAllowedNavigation('http://localhost:5199/index.html', DEV), true);
  assert.equal(isAllowedNavigation('http://localhost:5199/x', null), false, 'packaged build has no dev origin');
});

test('off-origin http navigation is denied (phishing)', () => {
  assert.equal(isAllowedNavigation('https://evil.example.com/login', DEV), false);
  assert.equal(isAllowedNavigation('http://localhost:6006/', DEV), false, 'different port = different origin');
});

test('data: and javascript: payloads are denied', () => {
  assert.equal(isAllowedNavigation('data:text/html,<script>alert(1)</script>', DEV), false);
  assert.equal(isAllowedNavigation('javascript:alert(1)', DEV), false);
});

test('malformed URLs are denied (fail closed)', () => {
  assert.equal(isAllowedNavigation('not a url', DEV), false);
  assert.equal(isAllowedNavigation('', null), false);
});

test('allowedOriginFor derives the dev origin, or null when packaged/invalid', () => {
  assert.equal(allowedOriginFor('http://localhost:5199'), 'http://localhost:5199');
  assert.equal(allowedOriginFor('http://localhost:5199/some/path'), 'http://localhost:5199');
  assert.equal(allowedOriginFor(undefined), null);
  assert.equal(allowedOriginFor('garbage'), null);
});
