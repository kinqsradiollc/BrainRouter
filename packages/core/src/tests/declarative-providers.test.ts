/**
 * ADR-047 D1 — a provider you add with DATA routes a turn.
 *
 * The acceptance criterion is concrete: add a new OpenAI-compatible vendor with
 * zero code changes, and it resolves the same way a built-in does — by id
 * (`PROVIDER_REGISTRY.get`) and by endpoint (`findProviderByEndpoint`). The
 * failure policy is the other half: malformation is loud, a built-in collision
 * is a quiet, reported yield.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  registerDeclarativeProviders,
  declarativeToDefinition,
  _resetDeclarativeProvidersForTests,
} from '../provider/providers/declarative.js';
import { STARTER_DECLARATIVE_PROVIDERS } from '../provider/providers/declarative-starter.js';
import { PROVIDER_REGISTRY, findProviderByEndpoint } from '../provider/providers/index.js';
import { registerDeclarativeProviders as barrelRegister } from '../provider/index.js';
import type { DeclarativeProviderEntry } from '../config/configTypes.js';

// The CLI imports the registrar from the provider barrel; assert the barrel
// re-export is the very same function the rest of this suite drives directly.
assert.equal(barrelRegister, registerDeclarativeProviders);

test.afterEach(() => _resetDeclarativeProvidersForTests());

test('a data-only vendor becomes resolvable by id and by endpoint', () => {
  const entry: DeclarativeProviderEntry = {
    id: 'acme-ai',
    label: 'Acme AI',
    endpoint: 'https://api.acme-ai.test/v1',
    envKey: 'ACME_API_KEY',
  };
  const result = registerDeclarativeProviders([entry]);
  assert.ok(result.registered.includes('acme-ai'));

  const byId = PROVIDER_REGISTRY.get('acme-ai');
  assert.ok(byId, 'registered by id');
  assert.equal(byId!.label, 'Acme AI');
  assert.equal(byId!.envKey, 'ACME_API_KEY');

  // Endpoint resolution matches the base URL and the /chat/completions form.
  assert.equal(findProviderByEndpoint('https://api.acme-ai.test/v1')?.id, 'acme-ai');
  assert.equal(findProviderByEndpoint('https://api.acme-ai.test/v1/chat/completions')?.id, 'acme-ai');
});

test('the packaged starter set registers without a user config', () => {
  const result = registerDeclarativeProviders();
  for (const starter of STARTER_DECLARATIVE_PROVIDERS) {
    assert.ok(result.registered.includes(starter.id), `${starter.id} registered`);
    assert.equal(PROVIDER_REGISTRY.get(starter.id)?.id, starter.id);
  }
});

test('a user entry overrides a starter entry of the same id (last wins)', () => {
  const override: DeclarativeProviderEntry = {
    id: 'together',
    endpoint: 'https://gateway.internal.test/v1',
    envKey: 'INTERNAL_KEY',
  };
  registerDeclarativeProviders([override]);
  assert.equal(PROVIDER_REGISTRY.get('together')?.endpoint, 'https://gateway.internal.test/v1');
  assert.equal(PROVIDER_REGISTRY.get('together')?.envKey, 'INTERNAL_KEY');
});

test('an id that collides with a built-in is skipped, not registered', () => {
  const result = registerDeclarativeProviders([
    { id: 'openai', endpoint: 'https://evil.test/v1' },
  ]);
  assert.ok(!result.registered.includes('openai'));
  assert.ok(result.skipped.some((s) => s.id === 'openai'));
  // The built-in openai definition is untouched.
  assert.notEqual(PROVIDER_REGISTRY.get('openai')?.endpoint, 'https://evil.test/v1');
});

test('malformation is LOUD — a bad entry throws and registers nothing', () => {
  assert.throws(
    () => registerDeclarativeProviders([{ id: 'bad id!', endpoint: 'https://x.test/v1' }]),
    /not a valid id/,
  );
  assert.throws(
    () => registerDeclarativeProviders([{ id: 'noproto', endpoint: 'ftp://x.test/v1' }]),
    /must be http/,
  );
  assert.throws(
    () => registerDeclarativeProviders([{ id: 'nourl', endpoint: 'not a url' }]),
    /invalid endpoint URL/,
  );
  // Atomic: after the throw, the bad ids are absent from the registry.
  assert.equal(PROVIDER_REGISTRY.get('noproto'), undefined);
});

test('an unknown wire format is rejected with its field named', () => {
  assert.throws(
    () => declarativeToDefinition({ id: 'x', endpoint: 'https://x.test/v1', requestFormat: 'grpc' as never }),
    /unknown requestFormat/,
  );
});

test('re-registering disposes the prior set (idempotent reload)', () => {
  registerDeclarativeProviders([{ id: 'first', endpoint: 'https://first.test/v1' }]);
  assert.ok(PROVIDER_REGISTRY.get('first'));
  registerDeclarativeProviders([{ id: 'second', endpoint: 'https://second.test/v1' }]);
  assert.equal(PROVIDER_REGISTRY.get('first'), undefined, 'the first set was disposed');
  assert.ok(PROVIDER_REGISTRY.get('second'));
});

test('defaults fill in: label from id, envKey to OPENAI_API_KEY, pickerVisible true', () => {
  const def = declarativeToDefinition({ id: 'minimal', endpoint: 'https://minimal.test/v1' });
  assert.equal(def.label, 'minimal');
  assert.equal(def.envKey, 'OPENAI_API_KEY');
  assert.equal(def.pickerVisible, true);
  assert.equal(def.local, false);
});
