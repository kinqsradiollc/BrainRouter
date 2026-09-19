/**
 * ADR-061 D3.3 — the route choice, and the equivalence that makes it landable.
 *
 * The router is ALWAYS ON. A tier that can re-head its chain has to prove, not
 * assert, that it changes nothing until a knob says otherwise — so the first
 * test compares by IDENTITY, not by value.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecisionPort, type DecisionProvider } from '../decision/port.js';
import {
  ROUTE_CHOICE_DEFAULT_MAX_CANDIDATES,
  chooseStartingRoute,
  describeRoute,
  routeDecisionState,
} from '../provider/routing/routeDecision.js';
import type { ModelRegistryEntry } from '../provider/routing/types.js';

function route(
  slug: string,
  extra: { free?: boolean; local?: boolean; contextWindow?: number; supportsTools?: boolean } = {},
): ModelRegistryEntry {
  const [provider, model] = slug.split('/') as [string, string];
  const { free, ...def } = extra;
  return {
    slug,
    provider,
    model,
    label: model,
    llm: { provider, model, ...(free ? { free: true } : {}) } as ModelRegistryEntry['llm'],
    ...(Object.keys(def).length ? { providerDef: def as ModelRegistryEntry['providerDef'] } : {}),
  };
}

const picks = (slug: string): DecisionProvider => ({
  name: 'stub',
  async answer(_state, questions) {
    return Object.fromEntries(Object.keys(questions).map((id) => [id, { kind: 'choice' as const, value: slug }]));
  },
});

const CHAIN = [
  route('openai/gpt-5', { contextWindow: 400_000, supportsTools: true }),
  route('lmstudio/qwen3-8b', { local: true, contextWindow: 32_000 }),
  route('groq/llama-3.3-70b', { free: true, contextWindow: 128_000 }),
];

test('on the default rules provider the chain comes back untouched — by identity', async () => {
  const verdict = await chooseStartingRoute(createDecisionPort(), CHAIN, { task: 'reformat this JSON' });
  assert.equal(verdict.changed, false);
  assert.equal(verdict.promoted, 'openai/gpt-5');
  assert.equal(verdict.routes.length, CHAIN.length);
  for (const [i, entry] of CHAIN.entries()) {
    assert.equal(verdict.routes[i], entry, `route ${i} must be the SAME entry the resolver returned`);
  }
  assert.equal(verdict.answer?.provider, 'rules');
  assert.equal(verdict.answer?.value, 'openai/gpt-5', 'the floor is the chain head');
});

test('a promotion re-heads the chain and leaves everyone else in their configured order', async () => {
  const verdict = await chooseStartingRoute(
    createDecisionPort({ provider: picks('groq/llama-3.3-70b') }),
    CHAIN,
  );
  assert.equal(verdict.changed, true);
  assert.equal(verdict.promoted, 'groq/llama-3.3-70b');
  assert.deepEqual(
    verdict.routes.map((r) => r.slug),
    ['groq/llama-3.3-70b', 'openai/gpt-5', 'lmstudio/qwen3-8b'],
    'the head moved; the rest kept their relative order, so the fallback order still reads the same',
  );
  assert.equal(verdict.routes.length, CHAIN.length, 'a choice never drops a fallback');
});

test('a route that is not in the chain cannot be started on', async () => {
  // The port rejects the answer, so this never reaches the promotion logic —
  // but the outcome is what matters: a model nobody configured cannot be called.
  const verdict = await chooseStartingRoute(
    createDecisionPort({ provider: picks('anthropic/not-configured') }),
    CHAIN,
  );
  assert.equal(verdict.changed, false);
  assert.equal(verdict.routes[0]!.slug, 'openai/gpt-5');
  assert.match(verdict.answer?.fellBack ?? '', /not one of/);
});

test('a provider that fails leaves the configured chain exactly as it was', async () => {
  const verdict = await chooseStartingRoute(
    createDecisionPort({ provider: { name: 'boom', async answer() { throw new Error('offline'); } } }),
    CHAIN,
  );
  assert.equal(verdict.changed, false);
  assert.deepEqual(verdict.routes.map((r) => r.slug), CHAIN.map((r) => r.slug));
  assert.match(verdict.answer?.fellBack ?? '', /boom failed: offline/);
});

test('nothing to decide is not recorded as a decision', async () => {
  const empty = await chooseStartingRoute(createDecisionPort({ provider: picks('x/y') }), []);
  assert.equal(empty.answer, undefined, 'an empty chain is the caller\'s 404, not a decision');
  assert.equal(empty.promoted, '');
  assert.deepEqual(empty.routes, []);

  const single = await chooseStartingRoute(createDecisionPort({ provider: picks('x/y') }), [CHAIN[0]!]);
  assert.equal(single.answer, undefined, 'one route is not a choice');
  assert.equal(single.routes[0], CHAIN[0]);
});

test('the candidate window bounds what is offered and never drops the head or the tail', async () => {
  const long = Array.from({ length: 20 }, (_, i) => route(`p${i}/m${i}`));
  const offered: string[] = [];
  const spy: DecisionProvider = {
    name: 'spy',
    async answer(_state, questions) {
      const q = questions.start!;
      if (q.kind === 'choice') offered.push(...Object.keys(q.options));
      return { start: { kind: 'choice', value: 'p1/m1' } };
    },
  };
  const verdict = await chooseStartingRoute(createDecisionPort({ provider: spy }), long, {}, { maxCandidates: 3 });
  assert.deepEqual(offered, ['p0/m0', 'p1/m1', 'p2/m2'], 'only the window is described to a provider');
  assert.equal(verdict.routes.length, 20, 'every fallback survives the choice');
  assert.equal(verdict.routes[0]!.slug, 'p1/m1');
  assert.equal(verdict.routes[19]!.slug, 'p19/m19', 'routes past the window stay where they were');
  assert.ok(ROUTE_CHOICE_DEFAULT_MAX_CANDIDATES >= 3, 'the default window is the wider one');
});

test('a candidate is described from what the registry knows, and nothing else', () => {
  assert.equal(
    describeRoute(CHAIN[1]!),
    'qwen3-8b on lmstudio, free to run, runs on this machine, 32k context',
  );
  assert.equal(describeRoute(CHAIN[0]!), 'gpt-5 on openai, billed per token, 400k context');
  assert.match(describeRoute(route('a/b', { supportsTools: false })), /cannot call tools/);
  assert.match(describeRoute(route('a/b', { contextWindow: 2_000_000 })), /2M context/);
});

test('the state a provider would see is bounded and carries only what the caller passed', () => {
  const state = routeDecisionState(
    { task: 'x'.repeat(9_000), approxPromptChars: 12_345.6, requiresTools: true },
    1_000,
  ) as Record<string, unknown>;
  assert.ok(String(state.task).length <= 501, `task bounded, got ${String(state.task).length}`);
  assert.equal(state.approxPromptChars, 12_346);
  assert.equal(state.needsToolCalls, true);
  assert.deepEqual(routeDecisionState({}, 1_000), {}, 'no signals means an empty payload, not a stub one');
});
