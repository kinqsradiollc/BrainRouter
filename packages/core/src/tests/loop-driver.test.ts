// ADR-041 A41-11 — the default loop driver as a replaceable composition row.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyLoopDriver,
  registerLoopDriver,
  resetLoopDriver,
  activeLoopDriverId,
  DEFAULT_LOOP_DRIVER_ID,
} from '../runtime/loopDriver.js';
import type { RuntimeTurnExecutor } from '../runtime/runtimeTypes.js';
import { runtimeCompositionSnapshot } from '../runtime/compositionSnapshot.js';

const baseExec: RuntimeTurnExecutor = async () => 'BASE';

test('A41-11 — the default driver is identity (byte-neutral): applyLoopDriver returns the base unchanged', () => {
  resetLoopDriver();
  assert.equal(activeLoopDriverId(), DEFAULT_LOOP_DRIVER_ID);
  assert.equal(applyLoopDriver(baseExec), baseExec, 'default wrap is identity — same function reference');
});

test('A41-11 — a registered driver replaces the row and wraps the executor', async () => {
  try {
    let seen = false;
    registerLoopDriver('instrumented', (base) => async (turn, spec) => {
      seen = true;
      const out = await base(turn, spec);
      return `[wrapped]${out}`;
    });
    assert.equal(activeLoopDriverId(), 'instrumented');
    const wrapped = applyLoopDriver(baseExec);
    assert.notEqual(wrapped, baseExec, 'a non-default driver returns a new executor');
    const result = await wrapped({ prompt: 'hi' }, { workspaceRoot: '/w', sessionKey: 's' });
    assert.equal(result, '[wrapped]BASE');
    assert.equal(seen, true, 'the wrapping driver ran');
  } finally {
    resetLoopDriver(); // never leak a non-default driver into sibling tests
  }
});

test('A41-11 — the composition snapshot surfaces the active loop-driver id', () => {
  resetLoopDriver();
  assert.equal(runtimeCompositionSnapshot().loopDriver, DEFAULT_LOOP_DRIVER_ID);
  try {
    registerLoopDriver('dry-run', (base) => base);
    assert.equal(runtimeCompositionSnapshot().loopDriver, 'dry-run');
  } finally {
    resetLoopDriver();
  }
});
