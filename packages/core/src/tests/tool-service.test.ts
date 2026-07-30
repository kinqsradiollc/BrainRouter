import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolService, ToolService } from '../tool/registry/service.js';
import {
  effectiveToolRegistry, registryAllowedTools, registryParallelSafeLocal, registryEntry,
} from '../tool/registry/registry.js';

test('ToolService is a stateless facade — delegates to the tool registry', () => {
  const svc = createToolService();
  assert.ok(svc instanceof ToolService);

  assert.deepEqual(svc.effectiveRegistry(), effectiveToolRegistry());
  assert.ok(svc.effectiveRegistry().length > 0);
  assert.deepEqual(svc.allowedTools('read'), registryAllowedTools('read'));
  assert.deepEqual(svc.parallelSafeLocal(), registryParallelSafeLocal());

  const name = svc.effectiveRegistry()[0].name;
  assert.deepEqual(svc.entry(name), registryEntry(name));
  assert.equal(typeof svc.hideWorkerTools(0), 'boolean');
});
