// ADR-041 A41-9 — session-scoped BYOK providers: the ProviderRegistry session
// overlay (isolation), the derive/register service, and the resolveSessionLlmConfig
// consumer that stamps sessionKey only for a genuine BYOK session.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProviderRegistry } from '../provider/providers/providerRegistry.js';
import { PROVIDER_REGISTRY } from '../provider/providers/index.js';
import { sessionByokEntry } from '../provider/providers/sessionScopedProvider.js';
import { setSessionRuntime, clearSessionRuntime, resolveSessionLlmConfig } from '../session/state/sessionRuntimeStore.js';
import type { ProviderDefinition } from '../provider/providers/definition.js';
import type { LLMConfig } from '../config/configTypes.js';

const def = (id: string, endpoint = 'https://x/v1'): ProviderDefinition =>
  ({ id, label: id, hint: '', endpoint, envKey: 'K', local: false, pickerVisible: false });

test('A41-9 — a session-scoped provider is resolvable only by its own session', () => {
  const reg = new ProviderRegistry([def('builtin')]);
  const handle = reg.registerForSession('A', def('adhoc'));
  assert.equal(reg.get('adhoc', 'A')?.id, 'adhoc'); // the owning session resolves it
  assert.equal(reg.get('adhoc', 'B'), undefined);    // another session cannot (isolation)
  assert.equal(reg.get('adhoc'), undefined);         // the global path cannot
  assert.equal(reg.has('adhoc', 'A'), true);
  assert.equal(reg.has('adhoc', 'B'), false);
  assert.equal(reg.has('adhoc'), false);
  handle.dispose();
  assert.equal(reg.get('adhoc', 'A'), undefined);    // disposed
});

test('A41-9 — a builtin id is never shadowed by a session provider', () => {
  const reg = new ProviderRegistry([def('openai', 'https://api.openai.com/v1')]);
  reg.registerForSession('A', def('openai', 'https://evil/v1'));
  assert.equal(reg.get('openai', 'A')?.endpoint, 'https://api.openai.com/v1'); // builtin wins
});

test('A41-9 — disposeSession removes every scoped provider for exactly one session', () => {
  const reg = new ProviderRegistry([]);
  reg.registerForSession('A', def('a1'));
  reg.registerForSession('A', def('a2'));
  reg.registerForSession('B', def('b1'));
  reg.disposeSession('A');
  assert.equal(reg.get('a1', 'A'), undefined);
  assert.equal(reg.get('a2', 'A'), undefined);
  assert.equal(reg.get('b1', 'B')?.id, 'b1'); // B untouched
});

test('A41-9 — get(id) with no sessionKey is the exact global path (byte-neutral)', () => {
  const reg = new ProviderRegistry([def('builtin')]);
  reg.registerForSession('A', def('adhoc'));
  // No sessionKey → session overlay is never consulted.
  assert.equal(reg.get('adhoc'), undefined);
  assert.equal(reg.get('builtin')?.id, 'builtin');
});

test('A41-9 — sessionByokEntry only for a custom provider+endpoint, not a known one', () => {
  assert.equal(sessionByokEntry(undefined), null);
  assert.equal(sessionByokEntry({ provider: 'myco' }), null); // no endpoint
  assert.equal(sessionByokEntry({ endpoint: 'https://x/v1' }), null); // no provider
  const entry = sessionByokEntry({ provider: 'myco', endpoint: 'https://api.myco.test/v1', requestFormat: 'anthropic-messages' });
  assert.ok(entry);
  assert.equal(entry!.id, 'myco');
  assert.equal(entry!.requestFormat, 'anthropic-messages');
  assert.equal(entry!.pickerVisible, false);
  // A known/builtin id yields no BYOK entry (the catalog definition is used).
  const known = [...PROVIDER_REGISTRY.values()][0]?.id;
  if (known) assert.equal(sessionByokEntry({ provider: known, endpoint: 'https://x/v1' }), null);
});

test('A41-9 — resolveSessionLlmConfig stamps sessionKey + registers only for a BYOK session', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'a41-9-'));
  const base = { provider: 'openai', apiKey: 'k', model: 'gpt', endpoint: 'https://api.openai.com/v1' } as LLMConfig;
  try {
    // An ordinary session (no custom endpoint) is byte-neutral — no sessionKey stamped.
    const normal = resolveSessionLlmConfig(base, ws, 'S-normal');
    assert.equal(normal.sessionKey, undefined);
    assert.equal(PROVIDER_REGISTRY.get('myco', 'S-normal'), undefined);

    // A BYOK session — custom provider+endpoint → registered scoped + sessionKey stamped.
    setSessionRuntime(ws, 'S-byok', {
      provider: 'myco',
      endpoint: 'https://api.myco.test/v1',
      byokRequestFormat: 'anthropic-messages',
    });
    const byok = resolveSessionLlmConfig(base, ws, 'S-byok');
    assert.equal(byok.sessionKey, 'S-byok');
    assert.equal(byok.provider, 'myco');
    assert.equal(PROVIDER_REGISTRY.get('myco', 'S-byok')?.id, 'myco'); // its own session resolves it
    assert.equal(PROVIDER_REGISTRY.get('myco'), undefined);            // never globally
    assert.equal(PROVIDER_REGISTRY.get('myco', 'S-other'), undefined); // never another session

    // Clearing the session runtime disposes the scoped provider.
    clearSessionRuntime(ws, 'S-byok');
    assert.equal(PROVIDER_REGISTRY.get('myco', 'S-byok'), undefined);
  } finally {
    clearSessionRuntime(ws, 'S-byok');
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
