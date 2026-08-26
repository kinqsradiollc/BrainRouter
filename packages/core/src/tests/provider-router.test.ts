import test from 'node:test';
import assert from 'node:assert/strict';
import type { LLMConfig } from '../config/config.js';
import { resolveCliKnobs } from '../config/config.js';
import {
  aggregateCatalog,
  buildModelRegistry,
  classifyRouterFailure,
  resolveRoutes,
  RouterPolicy,
} from '../provider/routing/index.js';
import { resolveAgentLlm, resolveCriticLlm } from '../provider/agentModels.js';

const openai: LLMConfig = {
  provider: 'openai',
  apiKey: 'openai-key',
  model: 'gpt-5.3',
  endpoint: 'https://api.openai.com/v1',
  cachedModels: ['gpt-5.3', 'gpt-5.3-mini', 'shared-model'],
  cachedAt: '2026-07-05T00:00:00.000Z',
};

const groq: LLMConfig = {
  provider: 'groq',
  apiKey: 'groq-key',
  model: 'llama-3.3-70b',
  endpoint: 'https://api.groq.com/openai/v1',
  cachedModels: ['llama-3.3-70b', 'shared-model'],
  free: true,
};

test('a model YOU configured is offered even when /models never listed it', () => {
  // The reported bug, and this test used to pin it: the configured list was
  // INTERSECTED with the fetched catalog, so anything the endpoint did not
  // advertise vanished — every fine-tune, every self-hosted deployment, every
  // model newer than the last catalog fetch. The symptom was "only models
  // added on the backend work".
  //
  // A discovery list is not an allowlist. Typing a name into your own config is
  // an assertion that it exists, and a wrong one fails at the provider with a
  // clear error — far better than the model quietly not being there.
  const registry = buildModelRegistry({
    openai,
    mine: {
      ...openai, provider: 'openai',
      models: ['my-finetune-v3'],
      cachedModels: ['gpt-5.3', 'gpt-5.3-mini'],
    },
  });
  const mine = registry.entries.filter((e) => e.provider === 'mine').map((e) => e.model);
  assert.ok(mine.includes('my-finetune-v3'), 'the model you added must be there');
  // Discovered models stay available too — adding one is not a filter.
  assert.ok(mine.includes('gpt-5.3'));
  // Configured first: chosen deliberately, where the discovered ones merely exist.
  assert.equal(mine[0], 'my-finetune-v3');
  assert.equal(new Set(mine).size, mine.length, 'no duplicates when both lists overlap');
});

test('a configured model that IS in the catalog appears once', () => {
  const registry = buildModelRegistry({
    both: { ...openai, provider: 'openai', models: ['gpt-5.3'], cachedModels: ['gpt-5.3', 'gpt-5.3-mini'] },
  });
  const models = registry.entries.filter((e) => e.provider === 'both').map((e) => e.model);
  assert.deepEqual(models, ['gpt-5.3', 'gpt-5.3-mini']);
});

test('buildModelRegistry enforces availableModels against catalog entries', () => {
  const registry = buildModelRegistry(
    { openai, groq },
    { availableModels: ['openai/gpt-5.3', 'shared-model'], enforceAvailableModels: true },
  );
  assert.deepEqual(registry.entries.map((entry) => entry.slug), [
    'openai/gpt-5.3',
    'openai/shared-model',
    'groq/shared-model',
  ]);
});

test('resolveRoutes supports slug, alias, tier alias, unique bare, ambiguous bare, and primary chain', () => {
  const registry = buildModelRegistry(
    { openai, groq },
    {
      aliases: { fast: 'groq/llama-3.3-70b', 'tier:pro': 'openai/gpt-5.3' },
      chain: ['fast', 'gpt-5.3-mini'],
      order: ['groq', 'openai'],
    },
  );
  assert.deepEqual(resolveRoutes(registry, 'groq/llama-3.3-70b').map((r) => r.slug), ['groq/llama-3.3-70b']);
  assert.deepEqual(resolveRoutes(registry, 'fast').map((r) => r.slug), ['groq/llama-3.3-70b']);
  assert.deepEqual(resolveRoutes(registry, 'tier:pro').map((r) => r.slug), ['openai/gpt-5.3']);
  assert.deepEqual(resolveRoutes(registry, 'gpt-5.3-mini').map((r) => r.slug), ['openai/gpt-5.3-mini']);
  assert.deepEqual(resolveRoutes(registry, 'shared-model').map((r) => r.slug), ['groq/shared-model', 'openai/shared-model']);
  assert.deepEqual(resolveRoutes(registry, '').map((r) => r.slug), ['groq/llama-3.3-70b', 'openai/gpt-5.3-mini']);
});

test('resolveRoutes appends primary chain when requested with fallbacks', () => {
  const registry = buildModelRegistry({ openai, groq }, { aliases: { fast: 'groq/llama-3.3-70b' }, chain: ['fast'] });
  assert.deepEqual(resolveRoutes(registry, 'openai/gpt-5.3', { withFallbacks: true }).map((r) => r.slug), [
    'openai/gpt-5.3',
    'groq/llama-3.3-70b',
  ]);
});

test('resolveRoutes sends unknown models to a single passthroughUnknown provider', () => {
  const registry = buildModelRegistry({
    openrouter: {
      provider: 'openrouter',
      apiKey: 'or-key',
      model: 'openai/gpt-5.3',
      endpoint: 'https://openrouter.ai/api/v1',
      passthroughUnknown: true,
    },
  });
  const route = resolveRoutes(registry, 'vendor/new-model')[0];
  assert.equal(route.slug, 'openrouter/vendor/new-model');
  assert.equal(route.llm.model, 'vendor/new-model');
});

test('passthrough falls through to other upstream providers when fallbacks are allowed', () => {
  const registry = buildModelRegistry({
    orca: { provider: 'openai', apiKey: 'k', model: 'm', endpoint: 'https://api.orcarouter.ai/v1', passthroughUnknown: true, cachedModels: ['m'] },
    openrouter: { provider: 'openrouter', apiKey: 'k2', model: 'stealth/ox-alpha', endpoint: 'https://openrouter.ai/api/v1', cachedModels: ['stealth/ox-alpha'] },
  });
  // A model in NO catalog: passthrough (orca) FIRST, then the other configured
  // upstream as a fallback, so a capacity/not-found failure does not dead-end.
  const withFb = resolveRoutes(registry, 'vendor/unknown', { withFallbacks: true });
  assert.deepEqual(withFb.map((r) => r.provider), ['orca', 'openrouter']);
  assert.ok(withFb.every((r) => r.llm.model === 'vendor/unknown'), 'the bare unknown model on each route');
  // Without fallbacks (the primary-chain pass): only the passthrough route.
  assert.deepEqual(resolveRoutes(registry, 'vendor/unknown', { withFallbacks: false }).map((r) => r.provider), ['orca']);
});

test('passthrough fallthrough never targets the local router gateway (no loop)', () => {
  const registry = buildModelRegistry({
    orca: { provider: 'openai', apiKey: 'k', model: 'm', endpoint: 'https://api.orcarouter.ai/v1', passthroughUnknown: true, cachedModels: ['m'] },
    localgw: { provider: 'brainrouter', apiKey: 'k2', model: 'big-pickle', endpoint: 'http://localhost:3747/v1/chat/completions', cachedModels: ['big-pickle'] },
    openrouter: { provider: 'openrouter', apiKey: 'k3', model: 'x', endpoint: 'https://openrouter.ai/api/v1', cachedModels: ['x'] },
  });
  // orca (passthrough) + openrouter (upstream fallback); the brainrouter-kind
  // gateway is excluded so an unknown model is never routed back into itself.
  assert.deepEqual(resolveRoutes(registry, 'vendor/unknown', { withFallbacks: true }).map((r) => r.provider), ['orca', 'openrouter']);
});

test('multiple passthroughUnknown providers each get a route (was capped at exactly one)', () => {
  const registry = buildModelRegistry({
    orca: { provider: 'openai', apiKey: 'k', model: 'm', endpoint: 'https://api.orcarouter.ai/v1', passthroughUnknown: true, cachedModels: ['m'] },
    openrouter: { provider: 'openrouter', apiKey: 'k2', model: 'x', endpoint: 'https://openrouter.ai/api/v1', passthroughUnknown: true, cachedModels: ['x'] },
  });
  assert.deepEqual(resolveRoutes(registry, 'vendor/unknown', { withFallbacks: false }).map((r) => r.provider), ['orca', 'openrouter']);
});

test('resolveRoutes applies requireTools and minContext constraints when metadata is known', () => {
  const registry = buildModelRegistry({ openai, groq }, { chain: ['gpt-5.3', 'llama-3.3-70b'] });
  const openaiRoute = registry.bySlug.get('openai/gpt-5.3')!;
  const groqRoute = registry.bySlug.get('groq/llama-3.3-70b')!;
  openaiRoute.providerDef = { ...(openaiRoute.providerDef as any), supportsTools: false, contextWindow: 200_000 } as any;
  groqRoute.providerDef = { ...(groqRoute.providerDef as any), contextWindow: 8_000 } as any;
  assert.deepEqual(resolveRoutes(registry, '', { requireTools: true }).map((r) => r.slug), ['groq/llama-3.3-70b']);
  assert.deepEqual(resolveRoutes(registry, '', { minContext: 100_000 }).map((r) => r.slug), ['openai/gpt-5.3']);
});

test('aggregateCatalog supports canonical, bare, alias, and query modes', () => {
  const registry = buildModelRegistry({ openai, groq }, { aliases: { fast: 'groq/llama-3.3-70b' } });
  assert.ok(aggregateCatalog(registry, { prefix: 'canonical' }).some((item) => item.id === 'openai/gpt-5.3'));
  assert.deepEqual(
    aggregateCatalog(registry, { prefix: 'bare', query: 'shared' }).map((item) => [item.id, item.providers]),
    [['shared-model', ['openai', 'groq']]],
  );
  assert.deepEqual(aggregateCatalog(registry, { prefix: 'alias' })[0], {
    id: 'fast',
    alias: 'fast',
    target: 'groq/llama-3.3-70b',
    model: 'fast',
    providers: ['groq'],
  });
});

test('RouterPolicy classifies failures, cools provider/model scopes, and keeps least-cooled route', () => {
  let now = 1_000;
  const policy = new RouterPolicy({ now: () => now, cooldownBaseMs: 1_000, cooldownMaxMs: 10_000 });
  const registry = buildModelRegistry({ openai, groq }, { chain: ['gpt-5.3', 'llama-3.3-70b'] });
  const [first, second] = resolveRoutes(registry, '');
  policy.markFailure(first, classifyRouterFailure(Object.assign(new Error('rate limited'), { status: 429 })));
  assert.equal(policy.pickRoute([first, second])?.slug, second.slug);
  policy.markFailure(second, classifyRouterFailure(Object.assign(new Error('model does not exist'), { status: 404 })));
  assert.equal(policy.pickRoute([first, second])?.slug, first.slug, 'all cooled falls back to least-cooled');
  now += 2_000;
  assert.equal(policy.pickRoute([first, second])?.slug, first.slug);
});

test('classifyRouterFailure does not retry after streaming content has started', () => {
  const failure = classifyRouterFailure(Object.assign(new Error('stream interrupted'), {
    status: 500,
    brainrouterStreamStarted: true,
  }));
  assert.equal(failure.retryable, false);
  assert.equal(failure.kind, 'non_retryable');
});

test('resolveCliKnobs resolves router defaults and sanitizes malformed input', () => {
  const knobs = resolveCliKnobs({
    activeServer: 's',
    servers: {},
    cli: {
      router: {
        enabled: true,
        passThrough: false,
        chain: [' fast ', '', 'fast'],
        strategy: 'free-first',
        order: [' groq ', ''],
        aliases: { fast: 'groq/llama-3.3-70b', 'bad/slash': 'x', empty: '' },
        cooldownBaseMs: 50,
        cooldownMaxMs: 100,
        serve: true,
        serveHost: ' 127.0.0.1 ',
        servePort: 999_999,
        serveKey: 'secret',
      },
    },
  });
  assert.deepEqual(knobs.router, {
    enabled: true,
    passThrough: false,
    chain: ['fast'],
    strategy: 'free-first',
    order: ['groq'],
    aliases: { fast: 'groq/llama-3.3-70b' },
    cooldownBaseMs: 500,
    cooldownMaxMs: 500,
    sessionAffinity: true,
    serve: true,
    serveHost: '127.0.0.1',
    servePort: 65_535,
    serveKey: 'secret',
  });
});

test('resolveAgentLlm uses provider router for role model requests when enabled', () => {
  const cfg = {
    activeServer: 's',
    servers: {},
    providers: { openai, groq },
    agentModels: { worker: { model: 'shared-model' } },
    cli: { router: { enabled: true, order: ['groq', 'openai'] } },
  };
  const llm = resolveAgentLlm(cfg, openai, 'worker');
  assert.equal(llm.endpoint, groq.endpoint);
  assert.equal(llm.model, 'shared-model');
});

test('resolveAgentLlm routes role models through the always-on router', () => {
  // Router-first architecture: routing is always on (no `enabled` gate). A bare
  // role model available from multiple providers is resolved through the router,
  // honoring `order` — here `shared-model` exists on both, so groq wins.
  const cfg = {
    activeServer: 's',
    servers: {},
    providers: { openai, groq },
    agentModels: { worker: { model: 'shared-model' } },
    cli: { router: { order: ['groq', 'openai'] } },
  };
  const llm = resolveAgentLlm(cfg, openai, 'worker');
  assert.equal(llm.endpoint, groq.endpoint);
  assert.equal(llm.model, 'shared-model');
});

test('resolveCriticLlm routes cli.critic.model through the provider router', () => {
  const cfg = {
    activeServer: 's',
    servers: {},
    providers: { openai, groq },
    agentModels: { reviewer: { provider: 'openai', model: 'gpt-5.3-mini' } },
    cli: { critic: { model: 'shared-model' }, router: { enabled: true, order: ['groq', 'openai'] } },
  };
  const llm = resolveCriticLlm(cfg, openai);
  assert.equal(llm.endpoint, groq.endpoint);
  assert.equal(llm.model, 'shared-model');
});
