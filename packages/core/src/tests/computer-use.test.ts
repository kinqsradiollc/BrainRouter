import test from 'node:test';
import assert from 'node:assert/strict';
import { decideExecutionPolicy, actionKindForTool } from '../exec/execPolicy.js';
import { evaluateDestructiveAction, expandChordKeys, validateComputerAction } from '../agent/computer/computerUse.js';

test('computer_use validation accepts safe actions and normalizes bounded fields', () => {
  const click = validateComputerAction({ action: 'left_click', x: 10, y: 20 });
  assert.equal(click.ok, true);
  if (click.ok) assert.deepEqual(click.action, { action: 'left_click', x: 10, y: 20 });

  const scroll = validateComputerAction({ action: 'scroll', direction: 'down', clicks: 999 });
  assert.equal(scroll.ok, true);
  if (scroll.ok) assert.equal(scroll.action.clicks, 20);

  const invalid = validateComputerAction({ action: 'drag', x: 1, y: 2 });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.match(invalid.error, /x2 and y2/);
});

test('computer_use key chords normalize platform conventions', () => {
  assert.deepEqual(expandChordKeys('ctrl+shift+p', { platform: 'darwin' }), ['cmd', 'shift', 'p']);
  assert.deepEqual(expandChordKeys(['control', 'alt', 'delete'], { platform: 'linux' }), ['ctrl', 'alt', 'delete']);
});

test('computer_use destructive heuristic forces confirm-worthy actions', () => {
  assert.equal(evaluateDestructiveAction({ action: 'move', x: 1, y: 2 }).dangerous, false);
  const send = evaluateDestructiveAction({ action: 'left_click', x: 1, y: 2 }, { nearbyText: 'Send payment' });
  assert.equal(send.dangerous, true);
  assert.match(send.reason ?? '', /destructive|committing/);
  const app = evaluateDestructiveAction({ action: 'type', text: 'hello' }, { frontmostApp: 'Mail' });
  assert.equal(app.dangerous, true);
});

test('computer_use policy is shell-tier only', () => {
  assert.equal(actionKindForTool('computer_use'), 'computer');
  assert.equal(decideExecutionPolicy('computer', 'read').decision, 'deny');
  assert.equal(decideExecutionPolicy('computer', 'write').decision, 'deny');
  assert.equal(decideExecutionPolicy('computer', 'shell').decision, 'allow');
});
