import test from 'node:test';
import assert from 'node:assert/strict';
import { createContextService, ContextService } from '../context/service.js';
import { contextWindowFor, formatContextWindow } from '../context/contextWindow.js';

test('ContextService is a stateless facade — delegates to the context-window table', () => {
  const svc = createContextService();
  assert.ok(svc instanceof ContextService);
  svc.resetCache();

  for (const model of ['gpt-4o', 'claude-opus-4-8', undefined, null]) {
    assert.equal(svc.windowFor(model), contextWindowFor(model));
    assert.equal(svc.format(model), formatContextWindow(model));
  }
});
