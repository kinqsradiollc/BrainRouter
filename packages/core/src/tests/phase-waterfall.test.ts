// ADR-041 D4b.2 — hot-path phase waterfall + logged-invariant assertion.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runPhaseWaterfall,
  type PhaseWaterfallContribution,
} from '../agent/runtime/phaseWaterfall.js';
import type { PhaseHookContext, PhaseHookHandler } from '../extension/registry.js';

const ctx: PhaseHookContext = { phase: 'provider-call', workspaceRoot: '/w', sessionKey: 's' };
const contrib = (from: string, handler: PhaseHookHandler): PhaseWaterfallContribution => ({ handler, from });

test('no handlers — the operation runs and its result is returned', async () => {
  let opRan = false;
  const out = await runPhaseWaterfall([], ctx, async () => {
    opRan = true;
    return 'model-response';
  });
  assert.equal(opRan, true);
  assert.equal(out.ran, true);
  assert.equal(out.result, 'model-response');
  assert.equal(out.refusedBy, undefined);
});

test('pass-through — a handler that calls next() lets the operation run', async () => {
  let sawBefore = false;
  let sawAfter = false;
  const handlers = [
    contrib('ext-observe', {
      before: async (_c, next) => {
        sawBefore = true;
        await next();
        sawAfter = true; // onion: code after next() runs post-operation
      },
    }),
  ];
  const out = await runPhaseWaterfall(handlers, ctx, async () => 42);
  assert.equal(out.ran, true);
  assert.equal(out.result, 42);
  assert.equal(sawBefore, true);
  assert.equal(sawAfter, true);
});

test('rewrite-then-next — a handler rewrites the payload before delegating', async () => {
  // The payload is shared state the operation reads; the handler mutates it, then delegates.
  const payload = { model: 'small', tokens: 0 };
  const handlers = [
    contrib('ext-rewrite', {
      before: async (_c, next) => {
        payload.model = 'large'; // rewrite before delegating
        await next();
      },
    }),
  ];
  const out = await runPhaseWaterfall(handlers, ctx, async () => `called:${payload.model}`);
  assert.equal(out.ran, true);
  assert.equal(out.result, 'called:large', 'the operation observed the rewritten payload');
});

test('refuse-next — a handler that returns without next() rejects the operation', async () => {
  let opRan = false;
  const handlers = [
    contrib('ext-guard', {
      before: async () => {
        /* deliberately does not call next() */
      },
    }),
  ];
  const out = await runPhaseWaterfall(handlers, ctx, async () => {
    opRan = true;
    return 'should-not-run';
  });
  assert.equal(opRan, false, 'the operation never ran');
  assert.equal(out.ran, false);
  assert.equal(out.result, undefined);
  assert.equal(out.refusedBy, 'ext-guard');
});

test('ordering — handlers nest as an onion; the first registered is outermost', async () => {
  const order: string[] = [];
  const handlers = [
    contrib('outer', {
      before: async (_c, next) => {
        order.push('outer:pre');
        await next();
        order.push('outer:post');
      },
    }),
    contrib('inner', {
      before: async (_c, next) => {
        order.push('inner:pre');
        await next();
        order.push('inner:post');
      },
    }),
  ];
  const out = await runPhaseWaterfall(handlers, ctx, async () => {
    order.push('operation');
    return 1;
  });
  assert.equal(out.ran, true);
  assert.deepEqual(order, ['outer:pre', 'inner:pre', 'operation', 'inner:post', 'outer:post']);
});

test('an outer refusal short-circuits before any inner handler or the operation runs', async () => {
  const reached: string[] = [];
  const handlers = [
    contrib('outer-guard', { before: async () => { reached.push('outer'); } }),
    contrib('inner', { before: async (_c, next) => { reached.push('inner'); await next(); } }),
  ];
  const out = await runPhaseWaterfall(handlers, ctx, async () => { reached.push('op'); return 0; });
  assert.equal(out.ran, false);
  assert.equal(out.refusedBy, 'outer-guard');
  assert.deepEqual(reached, ['outer'], 'inner handler and operation never reached');
});

test('calling next() more than once throws (programming error)', async () => {
  const handlers = [
    contrib('ext-buggy', {
      before: async (_c, next) => {
        await next();
        await next(); // second call is illegal
      },
    }),
  ];
  await assert.rejects(
    () => runPhaseWaterfall(handlers, ctx, async () => 'x'),
    /next\(\) more than once/,
  );
});

test('a throwing hot-path handler propagates (provider-call is not advisory)', async () => {
  const handlers = [
    contrib('ext-throw', {
      before: async () => {
        throw new Error('hook boom');
      },
    }),
  ];
  await assert.rejects(() => runPhaseWaterfall(handlers, ctx, async () => 'x'), /hook boom/);
});

test('a handler that delegates then swallows the operation error leaves ran=false, not a false success', async () => {
  // A contract violation (the module documents that a throw must propagate), but
  // the dispatcher must degrade to a refusal, not report {ran:true, result:undefined}.
  let opRan = false;
  const handlers = [
    contrib('ext-swallow', {
      before: async (_c, next) => {
        try {
          await next();
        } catch {
          /* swallow — the operation's failure must not read as success */
        }
      },
    }),
  ];
  const out = await runPhaseWaterfall(handlers, ctx, async () => {
    opRan = true;
    throw new Error('operation failed');
  });
  assert.equal(opRan, true, 'the operation ran');
  assert.equal(out.ran, false, 'a swallowed failure is not a successful run');
  assert.equal(out.result, undefined);
});
