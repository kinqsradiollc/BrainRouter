import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFlow, type FlowStep } from './flow.js';
import { CommandLayer } from './commands.js';
import { StubBackend } from './backend.js';
import type { Command, UiMap } from '../types.js';

const MANIFEST: UiMap = {
  version: 1,
  generatedAt: 'x',
  screens: [
    {
      id: 'login',
      title: 'Login',
      platform: 'web',
      route: '/login',
      elements: [
        { id: 'email-field', testID: 'email-field', type: 'input', action: 'type' },
        { id: 'login-submit', testID: 'login-submit', type: 'button', action: 'tap' },
      ],
    },
  ],
};

const STEPS: FlowStep[] = [
  { action: 'navigate', target: 'login' },
  { action: 'type', target: 'email-field', text: 'me@x.com' },
  { action: 'tap', target: 'login-submit' },
];

test('runFlow executes steps in order', async () => {
  const be = new StubBackend();
  const results = await runFlow(new CommandLayer(be, () => MANIFEST), STEPS);
  assert.equal(results.length, 3);
  assert.deepEqual(be.calls.map((c: Command) => c.kind), ['navigate', 'type', 'tap']);
  assert.ok(results.every((r) => r.ok));
});

test('runFlow short-circuits on the first failure', async () => {
  // Fail only when the submit button is tapped.
  const be = new StubBackend((cmd) =>
    cmd.kind === 'tap'
      ? { ok: false, status: 'fail', command: 'tap', durationMs: 2 }
      : { ok: true, status: 'ok', command: cmd.kind, durationMs: 1 },
  );
  const seen: number[] = [];
  const results = await runFlow(new CommandLayer(be, () => MANIFEST), STEPS, {
    onStep: (_r, i) => seen.push(i),
  });
  assert.equal(results.length, 3);
  assert.equal(results[2].ok, false);
  assert.deepEqual(seen, [0, 1, 2]);
});

test('runFlow tolerates an unknown step action (no crash)', async () => {
  const be = new StubBackend();
  const results = await runFlow(new CommandLayer(be, () => MANIFEST), [
    { action: 'bogus' as unknown as FlowStep['action'], target: 'x' } as FlowStep,
  ]);
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false);
  assert.match(results[0].error ?? '', /unknown step action/);
});

test('runFlow with stopOnFail stops early on a missing target', async () => {
  const be = new StubBackend();
  const results = await runFlow(new CommandLayer(be, () => MANIFEST), [
    { action: 'tap', target: 'does-not-exist' },
    { action: 'tap', target: 'login-submit' },
  ]);
  assert.equal(results.length, 1); // stopped after the failing first step
  assert.equal(results[0].ok, false);
  assert.equal(be.calls.length, 0);
});
