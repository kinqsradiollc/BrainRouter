/**
 * Browser destination-policy fixtures.
 *
 * A25-6a: pins human and agent authority, metadata denial, DNS rebinding
 * defenses, and fail-closed resolver behavior independently of Electron.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvedBrowserDestinationAllowed } from './browserDestinationPolicy.js';

test('human navigation may use private origins while agent navigation requires an exact trust grant', async () => {
  assert.equal(await resolvedBrowserDestinationAllowed('http://localhost:5173'), true);
  assert.equal(await resolvedBrowserDestinationAllowed('http://localhost:5173', {}), false);
  assert.equal(await resolvedBrowserDestinationAllowed(
    'http://localhost:5173',
    { allowedPrivateOrigin: 'http://localhost:5173' },
  ), true);
  assert.equal(await resolvedBrowserDestinationAllowed(
    'http://localhost:5173',
    { allowedPrivateOrigin: 'http://localhost:3000' },
  ), false);
});

test('metadata and link-local destinations always fail closed', async () => {
  for (const target of [
    'http://169.254.169.254/latest/meta-data',
    'http://[fe80::1]/',
  ]) {
    assert.equal(await resolvedBrowserDestinationAllowed(target), false, target);
    assert.equal(await resolvedBrowserDestinationAllowed(
      target,
      { allowedPrivateOrigin: new URL(target).origin },
    ), false, target);
  }
});

test('DNS results must all remain inside the selected authority', async () => {
  const publicResolver = async () => ['203.0.113.10'];
  const mixedResolver = async () => ['203.0.113.10', '10.0.0.2'];
  const privateResolver = async () => ['10.0.0.2'];

  assert.equal(await resolvedBrowserDestinationAllowed(
    'https://example.test',
    {},
    publicResolver,
  ), true);
  assert.equal(await resolvedBrowserDestinationAllowed(
    'https://example.test',
    {},
    mixedResolver,
  ), false);
  assert.equal(await resolvedBrowserDestinationAllowed(
    'https://internal.test',
    { allowedPrivateOrigin: 'https://internal.test' },
    privateResolver,
  ), true);
});

test('invalid URLs, empty DNS results, and resolver failures fail closed', async () => {
  assert.equal(await resolvedBrowserDestinationAllowed('not a url'), false);
  assert.equal(await resolvedBrowserDestinationAllowed(
    'https://example.test',
    {},
    async () => [],
  ), false);
  assert.equal(await resolvedBrowserDestinationAllowed(
    'https://example.test',
    {},
    async () => { throw new Error('dns unavailable'); },
  ), false);
});
