import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createActiveTurnOrchestrationRuntime,
  OrchestrationRuntimeUnavailableError,
} from '../orchestration/runtime/activeTurnRuntime.js';
import { localToolExecutor } from '../tool/registry/executors.js';
import { registryDelegationLaunchTool } from '../tool/registry/registry.js';

function runtime(overrides: {
  sessionKey?: () => string;
  signal?: AbortSignal;
} = {}) {
  let calls = 0;
  const controller = new AbortController();
  const active = createActiveTurnOrchestrationRuntime({
    ownerSessionKey: 'session-1',
    currentSessionKey: overrides.sessionKey ?? (() => 'session-1'),
    signal: overrides.signal ?? controller.signal,
    invoke: async () => {
      calls++;
      return 'accepted';
    },
  });
  return { active, controller, calls: () => calls };
}

test('P23-3a active turn runtime accepts an owned call and rejects deferred replay', async () => {
  const harness = runtime();
  assert.equal(
    await harness.active.port.invoke('delegate_agent', {}, { workflowLaunch: false }),
    'accepted',
  );
  harness.active.close();
  assert.throws(
    () => harness.active.assertActive('delegate_agent'),
    (error) =>
      error instanceof OrchestrationRuntimeUnavailableError &&
      error.reason === 'turn-ended',
  );
  await assert.rejects(
    harness.active.port.invoke('delegate_agent', {}, { workflowLaunch: false }),
    (error) =>
      error instanceof OrchestrationRuntimeUnavailableError &&
      error.reason === 'turn-ended' &&
      error.terminal &&
      !error.retryable,
  );
  assert.equal(harness.calls(), 1, 'the deferred call never reaches the dispatcher');
});

test('P23-3a active turn runtime fails closed after interruption or session switch', async () => {
  const interrupted = runtime();
  interrupted.controller.abort();
  await assert.rejects(
    interrupted.active.port.invoke('delegate_agent', {}, { workflowLaunch: false }),
    (error) =>
      error instanceof OrchestrationRuntimeUnavailableError &&
      error.reason === 'turn-interrupted',
  );
  assert.equal(interrupted.calls(), 0);

  const switched = runtime({ sessionKey: () => 'session-2' });
  await assert.rejects(
    switched.active.port.invoke('delegate_agent', {}, { workflowLaunch: false }),
    (error) =>
      error instanceof OrchestrationRuntimeUnavailableError &&
      error.reason === 'session-changed',
  );
  assert.equal(switched.calls(), 0);
});

test('P23-3a direct orchestration calls without an active port are terminal', async () => {
  const executor = localToolExecutor('delegate_agent');
  assert.ok(executor);
  await assert.rejects(
    executor.handle({ args: { role: 'explorer', task: 'inspect' } }),
    (error) =>
      error instanceof OrchestrationRuntimeUnavailableError &&
      error.reason === 'missing-port' &&
      error.terminal &&
      !error.retryable &&
      /must not be retried/.test(error.message),
  );
});

test('P23-3a accepted-state traces use authoritative launch metadata', () => {
  assert.equal(registryDelegationLaunchTool('delegate_agent'), true);
  assert.equal(registryDelegationLaunchTool('delegate_explorer'), true);
  assert.equal(registryDelegationLaunchTool('spawn_agents'), true);
  assert.equal(registryDelegationLaunchTool('run_workflow'), true);
  assert.equal(registryDelegationLaunchTool('route_task'), false);
  assert.equal(registryDelegationLaunchTool('wait_agent'), false);
});
