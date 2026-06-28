import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRequestFormat } from '../agent/agent.js';
import {
  _resetCliKnobsCache,
  resolveCliKnobs,
  setCliKnobOverride,
} from '../config/config.js';

// Fixtures.
const CANONICAL_OPENAI = 'https://api.openai.com/v1';
const OPENROUTER = 'https://openrouter.ai/api/v1';
const CUSTOM_GATEWAY = 'https://gateway.example/v1';
const LMSTUDIO = 'http://localhost:1234/v1';

test.beforeEach(() => {
  _resetCliKnobsCache();
  setCliKnobOverride({ providerRequestFormat: {} });
});

test.after(() => {
  _resetCliKnobsCache();
});

test('resolveRequestFormat: defaults are unchanged — canonical OpenAI uses Responses, others stay on chat-completions', () => {
  assert.equal(
    resolveRequestFormat({ provider: 'openai', apiKey: 'k', model: 'gpt-5', endpoint: CANONICAL_OPENAI }),
    'responses',
  );
  // Built-in default gates endpoint: openrouter with provider:'openai' must NOT
  // misroute to /responses (no override → safety gate stays).
  assert.equal(
    resolveRequestFormat({ provider: 'openai', apiKey: 'k', model: 'gpt-5', endpoint: OPENROUTER }),
    'chat-completions',
  );
  // Non-OpenAI providers default to chat-completions even when model + endpoint
  // would otherwise support Responses.
  assert.equal(
    resolveRequestFormat({ provider: 'lmstudio', apiKey: '', model: 'gpt-oss:20b', endpoint: LMSTUDIO }),
    'chat-completions',
  );
  // The earlier `openai-compatible` + canonical-OpenAI test from the existing
  // agent-runtime suite is preserved: endpoint normalization is what makes
  // the openai-compatible provider with api.openai.com resolve to the openai
  // definition (built-in Responses default).
  assert.equal(
    resolveRequestFormat({ provider: 'openai-compatible', apiKey: 'k', model: 'gpt-5', endpoint: CANONICAL_OPENAI }),
    'responses',
  );
});

test('resolveRequestFormat: per-provider CLI override flips chat-completions → responses for non-canonical endpoint', () => {
  setCliKnobOverride({ providerRequestFormat: { lmstudio: 'responses' } });
  // LM Studio now opts into Responses — even though built-in default would
  // be chat-completions — so a user with a custom gateway-style Responses
  // server at the LM Studio port can opt in.
  assert.equal(
    resolveRequestFormat({ provider: 'lmstudio', apiKey: '', model: 'gpt-4.1', endpoint: LMSTUDIO }),
    'responses',
  );
});

test('resolveRequestFormat: per-provider override bypasses canonical-endpoint guard (user assertion wins)', () => {
  // Without an override, `provider:'openai'` + a non-canonical, unregistered
  // gateway endpoint would be demoted to chat-completions by the canonical-
  // endpoint guard. With an explicit override, the user is asserting their
  // endpoint accepts Responses, so the resolver trusts it. (Uses CUSTOM_GATEWAY
  // rather than openrouter.ai, which is now a registered provider endpoint that
  // activeProviderDef resolves away from provider:'openai'.)
  setCliKnobOverride({ providerRequestFormat: { openai: 'responses' } });
  assert.equal(
    resolveRequestFormat({ provider: 'openai', apiKey: 'k', model: 'gpt-5', endpoint: CUSTOM_GATEWAY }),
    'responses',
  );
  // The same override also unlocks openai-compatible with a custom gateway.
  setCliKnobOverride({ providerRequestFormat: { 'openai-compatible': 'responses' } });
  assert.equal(
    resolveRequestFormat({ provider: 'openai-compatible', apiKey: 'k', model: 'gpt-5', endpoint: CUSTOM_GATEWAY }),
    'responses',
  );
});

test('resolveRequestFormat: explicit Responses override accepts non-OpenAI model ids used by Responses gateways', () => {
  setCliKnobOverride({ providerRequestFormat: { 'openai-compatible': 'responses' } });
  assert.equal(
    resolveRequestFormat({ provider: 'openai-compatible', apiKey: 'k', model: 'google/gemma-4-12b', endpoint: CUSTOM_GATEWAY }),
    'responses',
  );
});

test('resolveRequestFormat: per-provider override that FLIPS responses → chat-completions wins over built-in', () => {
  // Canonical OpenAI's built-in default is responses; user explicitly forces
  // chat-completions to e.g. compare shapes during a regression chase.
  setCliKnobOverride({ providerRequestFormat: { openai: 'chat-completions' } });
  assert.equal(
    resolveRequestFormat({ provider: 'openai', apiKey: 'k', model: 'gpt-5', endpoint: CANONICAL_OPENAI }),
    'chat-completions',
  );
});

test('resolveRequestFormat: built-in Responses default still model-gates canonical OpenAI', () => {
  // Built-in defaults stay conservative: without an explicit user override,
  // a non-OpenAI model id does not inherit OpenAI's native Responses route.
  assert.equal(
    resolveRequestFormat({ provider: 'openai', apiKey: 'k', model: 'google/gemma-4-12b', endpoint: CANONICAL_OPENAI }),
    'chat-completions',
  );
});

test('resolveRequestFormat: providerId lookup is case-insensitive (resolver lowercases providerId before lookup)', () => {
  // The resolver lowercases both `config.provider` and the resolved
  // `def.id` (`activeProviderDef` is endpoint-aware) before consulting the
  // override map. So the user's LLMConfig value (uppercase OR lowercase)
  // matches a lowercase-stored key. The test scope is the resolver, not
  // setCliKnobOverride's surface (the latter is operator-facing and does NOT
  // lowercase keys; config-file authoring via `resolveCliKnobs` IS lowercased).
  setCliKnobOverride({ providerRequestFormat: { lmstudio: 'responses' } });
  assert.equal(
    resolveRequestFormat({ provider: 'LMStudio', apiKey: '', model: 'gpt-4.1', endpoint: LMSTUDIO }),
    'responses',
  );
});

test('resolveRequestFormat: provider with no built-in endpoint + no override falls back to chat-completions (no default-OpenAI leak)', () => {
  // The endpoint-fallback chain in resolveRequestFormat hardcodes OpenAI's
  // canonical base URL when the active provider and config supply no
  // endpoint. Without a built-in def.endpoint (e.g. openai-compatible) AND
  // no override, this would silently POST /chat/completions to a non-OpenAI
  // gateway; with a built-in def.endpoint (e.g. lmstudio) the request goes
  // to the local server. This test pins the chat-completions default for a
  // provider that supplies a built-in endpoint but no override.
  assert.equal(
    resolveRequestFormat({ provider: 'lmstudio', apiKey: '', model: 'gpt-4.1' }),
    'chat-completions',
  );
});

test('resolveCliKnobs: providerRequestFormat drops typos and unknown-value entries (fail-safe)', () => {
  const resolved = resolveCliKnobs({
    activeServer: '',
    servers: {},
    cli: {
      providerRequestFormat: {
        openai: 'responses',
        lmstudio: 'chat-completions',
        badKey: 'response',       // typo: missing terminal 's' → dropped
        another: 'Responses',     // wrong case → dropped
        garbage: 42,              // non-literal → dropped
        opencode: undefined,      // undefined → dropped
        '  spaced  ': 'chat-completions', // whitespace-trimmed key, value kept
      } as any,
    },
  });
  assert.deepEqual(resolved.providerRequestFormat, {
    openai: 'responses',
    lmstudio: 'chat-completions',
    spaced: 'chat-completions',
  });
});

test('resolveCliKnobs: providerRequestFormat is always a record (object input falls back to {})', () => {
  // Malformed/array/non-object input must not crash — every other knob
  // falls back to its safe default, this one falls back to {}.
  for (const bad of [undefined, null, 'responses', 42, []]) {
    const resolved = resolveCliKnobs({
      activeServer: '',
      servers: {},
      cli: { providerRequestFormat: bad as any },
    });
    assert.deepEqual(resolved.providerRequestFormat, {}, `bad input: ${JSON.stringify(bad)}`);
  }
});

test('resolveRequestFormat: per-provider override does NOT affect OTHER providers (each provider reads its own key)', () => {
  // Setting only `lmstudio: 'responses'` must NOT promote canonical OpenAI
  // or any non-mentioned provider to responses.
  setCliKnobOverride({ providerRequestFormat: { lmstudio: 'responses' } });
  // OpenAI unchanged.
  assert.equal(
    resolveRequestFormat({ provider: 'openai', apiKey: 'k', model: 'gpt-5', endpoint: CANONICAL_OPENAI }),
    'responses',
  );
  // openai-compatible unchanged.
  assert.equal(
    resolveRequestFormat({ provider: 'openai-compatible', apiKey: 'k', model: 'gpt-5', endpoint: CANONICAL_OPENAI }),
    'responses',
  );
  // Ollama unchanged (no override, no built-in).
  assert.equal(
    resolveRequestFormat({ provider: 'ollama', apiKey: '', model: 'gpt-oss:20b', endpoint: 'http://localhost:11434/v1' }),
    'chat-completions',
  );
});

test('resolveRequestFormat: when override is set per provider, gpt-4.1 model id still matches Responses shape', () => {
  // Regression guard for the user's Responses API example: the explicit
  // override path still sends a regular OpenAI model id through Responses.
  setCliKnobOverride({ providerRequestFormat: { openai: 'responses' } });
  assert.equal(
    resolveRequestFormat({ provider: 'openai', apiKey: 'k', model: 'gpt-4.1', endpoint: CANONICAL_OPENAI }),
    'responses',
  );
});
