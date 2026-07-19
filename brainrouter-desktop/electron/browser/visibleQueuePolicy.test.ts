import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldBypassAgentVisibleQueue,
  shouldBypassRendererVisibleQueue,
} from './visibleQueuePolicy.js';

test('only visible agent recovery commands bypass the outer FIFO', () => {
  for (const kind of ['dialog.respond', 'permission.respond', 'page.stop']) {
    assert.equal(shouldBypassAgentVisibleQueue(kind, true), true, kind);
    assert.equal(shouldBypassAgentVisibleQueue(kind, false), false, `${kind} hidden`);
  }
  assert.equal(shouldBypassAgentVisibleQueue('page.navigate', true), false);
  assert.equal(shouldBypassAgentVisibleQueue('page.click', true), false);
});

test('renderer recovery commands bypass only for their visible target', () => {
  for (const op of ['respond-dialog', 'respond-permission', 'stop']) {
    assert.equal(shouldBypassRendererVisibleQueue(op, true), true, op);
    assert.equal(shouldBypassRendererVisibleQueue(op, false), false, `${op} hidden`);
  }
  assert.equal(shouldBypassRendererVisibleQueue('navigate', true), false);
});

test('renderer tab selection always skips the outer FIFO', () => {
  assert.equal(shouldBypassRendererVisibleQueue('select-tab', true), true);
  assert.equal(shouldBypassRendererVisibleQueue('select-tab', false), true);
});
