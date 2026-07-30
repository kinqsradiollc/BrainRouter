/**
 * Purpose: Characterize the agent runtime adapter's per-turn route de-duplication
 * and single-campaign receipt behavior without invoking a model provider.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProviderRecoveryReceipt } from '@kinqs/brainrouter-types';

import { recoverAgentProviderRoute } from '../agent/runtime/providerRecovery.js';
import type { LLMConfig } from '../config/config.js';
import { RouterPolicy } from '../provider/routing/policy.js';
import { buildModelRegistry } from '../provider/routing/registry.js';
import { resolveRoutes } from '../provider/routing/resolve.js';

const primary: LLMConfig = {
  provider: 'primary',
  model: 'model-a',
  apiKey: 'primary-secret',
};
const skipped: LLMConfig = {
  provider: 'skipped',
  model: 'model-b',
  apiKey: 'skipped-secret',
};
const fallback: LLMConfig = {
  provider: 'fallback',
  model: 'model-c',
  apiKey: 'fallback-secret',
};

function recoveryRoutes() {
  return resolveRoutes(
    buildModelRegistry(
      { primary, skipped, fallback },
      { chain: ['primary/model-a', 'skipped/model-b', 'fallback/model-c'] },
    ),
    '',
  );
}

test('agent recovery skips routes already tried this turn and emits one complete receipt', async () => {
  const routes = recoveryRoutes();
  const initialRoute = routes[0];
  assert.ok(initialRoute);
  const triedRoutes = new Set(['skipped/model-b']);
  const fallbackEvents: string[] = [];
  const executed: string[] = [];
  const receipts: ProviderRecoveryReceipt[] = [];

  const result = await recoverAgentProviderRoute({
    initialRoute,
    initialError: Object.assign(new Error('primary unavailable'), { status: 503 }),
    initialStartedAt: '2026-07-29T00:00:00.000Z',
    routes,
    triedRoutes,
    policy: new RouterPolicy({ now: () => 0 }),
    sessionKey: 'agent-session',
    onFallback: ({ from, to }) => fallbackEvents.push(`${from.slug}->${to.slug}`),
    onReceipt: (receipt) => receipts.push(receipt),
    execute: async (route, attempt) => {
      executed.push(`${attempt}:${route.slug}`);
      return 'answer';
    },
  });

  assert.equal(result.result, 'answer');
  assert.deepEqual(executed, ['2:fallback/model-c']);
  assert.deepEqual(fallbackEvents, ['primary/model-a->fallback/model-c']);
  assert.deepEqual(
    [...triedRoutes].sort(),
    ['fallback/model-c', 'primary/model-a', 'skipped/model-b'],
  );
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.outcome, 'succeeded');
  assert.deepEqual(
    receipts[0]?.attempts.map((attempt) => attempt.route.slug),
    ['primary/model-a', 'fallback/model-c'],
  );
  assert.doesNotMatch(JSON.stringify(receipts[0]), /primary-secret|skipped-secret|fallback-secret/);
});
