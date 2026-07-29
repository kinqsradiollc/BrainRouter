/**
 * Purpose: Characterize bounded provider recovery, failure classification, and
 * the host-neutral receipt without invoking a real model provider.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProviderRecoveryReceipt } from '@kinqs/brainrouter-types';

import type { LLMConfig } from '../config/config.js';
import { RouterPolicy } from '../router/policy.js';
import { executeWithProviderRecovery, ProviderRecoveryExhaustedError } from '../router/recovery.js';
import { buildModelRegistry } from '../router/registry.js';
import { resolveRoutes } from '../router/resolve.js';

const first: LLMConfig = {
  provider: 'first',
  model: 'model-a',
  apiKey: 'secret-a',
};
const second: LLMConfig = {
  provider: 'second',
  model: 'model-b',
  apiKey: 'secret-b',
};

function routes() {
  const registry = buildModelRegistry({ first, second }, { chain: ['first/model-a', 'second/model-b'] });
  return resolveRoutes(registry, '');
}

test('recovery attempts each route once and emits a secret-free success receipt', async () => {
  const timeline = [
    new Date('2026-07-29T00:00:00.000Z'),
    new Date('2026-07-29T00:00:01.000Z'),
    new Date('2026-07-29T00:00:02.000Z'),
    new Date('2026-07-29T00:00:03.000Z'),
    new Date('2026-07-29T00:00:04.000Z'),
    new Date('2026-07-29T00:00:05.000Z'),
  ];
  const receipts: ProviderRecoveryReceipt[] = [];
  const seen: string[] = [];
  const result = await executeWithProviderRecovery({
    routes: routes(),
    policy: new RouterPolicy({ now: () => 0 }),
    maxAttempts: 4,
    now: () => timeline.shift() ?? new Date('2026-07-29T00:00:06.000Z'),
    onReceipt: (receipt) => receipts.push(receipt),
    execute: async (route) => {
      seen.push(route.slug);
      if (route.provider === 'first') {
        throw Object.assign(new Error('rate limited: secret-a'), { status: 429 });
      }
      return 'ok';
    },
  });

  assert.equal(result.result, 'ok');
  assert.deepEqual(seen, ['first/model-a', 'second/model-b']);
  assert.equal(receipts.length, 1);
  assert.deepEqual(result.receipt, receipts[0]);
  assert.equal(result.receipt.outcome, 'succeeded');
  assert.deepEqual(
    result.receipt.attempts.map(({ attempt, outcome, failure }) => ({
      attempt,
      outcome,
      kind: failure?.kind,
      status: failure?.status,
    })),
    [
      {
        attempt: 1,
        outcome: 'failed',
        kind: 'provider_retryable',
        status: 429,
      },
      {
        attempt: 2,
        outcome: 'succeeded',
        kind: undefined,
        status: undefined,
      },
    ],
  );
  assert.doesNotMatch(JSON.stringify(result.receipt), /secret-a|secret-b/);
  assert.ok(Object.isFrozen(result.receipt));
  assert.ok(Object.isFrozen(result.receipt.attempts));
});

test('non-retryable failure stops immediately and preserves the original error', async () => {
  const original = Object.assign(new Error('bad request'), { status: 400 });
  const receipts: ProviderRecoveryReceipt[] = [];

  await assert.rejects(
    executeWithProviderRecovery({
      routes: routes(),
      policy: new RouterPolicy(),
      onReceipt: (value) => receipts.push(value),
      execute: async () => {
        throw original;
      },
    }),
    (error) => error === original,
  );

  const receipt = receipts[0];
  assert.ok(receipt);
  assert.equal(receipt?.outcome, 'failed');
  assert.equal(receipt?.attempts.length, 1);
  assert.equal(receipt?.attempts[0]?.failure?.retryable, false);
});

test('empty candidates produce an exhausted receipt and a stable error', async () => {
  const receipts: ProviderRecoveryReceipt[] = [];
  await assert.rejects(
    executeWithProviderRecovery({
      routes: [],
      policy: new RouterPolicy(),
      maxAttempts: 0,
      onReceipt: (value) => receipts.push(value),
      execute: async () => 'unreachable',
    }),
    ProviderRecoveryExhaustedError,
  );
  const receipt = receipts[0];
  assert.ok(receipt);
  assert.equal(receipt?.outcome, 'exhausted');
  assert.deepEqual(receipt?.attempts, []);
  assert.equal(receipt?.maxAttempts, 1);
});

test('an asynchronous receipt projection failure cannot change execution', async () => {
  const execution = await executeWithProviderRecovery({
    routes: routes(),
    policy: new RouterPolicy(),
    onReceipt: async () => {
      throw new Error('projection unavailable');
    },
    execute: async () => 'completed',
  });
  assert.equal(execution.result, 'completed');
  assert.equal(execution.receipt.outcome, 'succeeded');
});

test('an already-failed primary attempt remains part of the same recovery campaign', async () => {
  const [primary, fallback] = routes();
  assert.ok(primary);
  assert.ok(fallback);
  const receipts: ProviderRecoveryReceipt[] = [];
  const fallbackEvents: string[] = [];
  const executed: string[] = [];
  const primaryError = Object.assign(new Error('primary rate limited'), { status: 429 });

  const execution = await executeWithProviderRecovery({
    routes: [primary, fallback],
    policy: new RouterPolicy({ now: () => 0 }),
    maxAttempts: 2,
    initialFailure: {
      route: primary,
      error: primaryError,
      startedAt: '2026-07-29T00:00:00.000Z',
      completedAt: '2026-07-29T00:00:01.000Z',
    },
    onFallback: ({ from, to, failure }) => {
      fallbackEvents.push(`${from.slug}->${to.slug}:${failure.kind}`);
    },
    onReceipt: (receipt) => receipts.push(receipt),
    execute: async (route, attempt) => {
      executed.push(`${attempt}:${route.slug}`);
      return 'recovered';
    },
  });

  assert.equal(execution.result, 'recovered');
  assert.deepEqual(executed, ['2:second/model-b']);
  assert.deepEqual(fallbackEvents, ['first/model-a->second/model-b:provider_retryable']);
  assert.equal(receipts.length, 1);
  assert.equal(execution.receipt.startedAt, '2026-07-29T00:00:00.000Z');
  assert.deepEqual(
    execution.receipt.attempts.map((attempt) => [attempt.attempt, attempt.route.slug, attempt.outcome]),
    [
      [1, 'first/model-a', 'failed'],
      [2, 'second/model-b', 'succeeded'],
    ],
  );
});
