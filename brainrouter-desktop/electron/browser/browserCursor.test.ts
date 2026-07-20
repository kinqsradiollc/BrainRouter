import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { AGENT_CURSOR_ID, AGENT_CURSOR_STYLE_ID, agentCursorScript, removeAgentCursorScript } from './browserCursor.js';

/** A minimal DOM stub good enough to run the injected overlay script. */
function makeSandbox() {
  const registry = new Map<string, any>();
  const appended: any[] = [];
  const makeEl = () => ({ id: '', style: { cssText: '', left: '', top: '' }, textContent: '', setAttribute() {}, remove() { registry.delete(this.id); } });
  const sink = { appendChild(child: any) { appended.push(child); if (child.id) registry.set(child.id, child); return child; } };
  const document = {
    createElement: () => makeEl(),
    getElementById: (id: string) => registry.get(id) ?? null,
    head: sink,
    body: sink,
    documentElement: sink,
  };
  return { sandbox: { document, setTimeout: () => 0 }, registry, appended };
}

test('agentCursorScript is syntactically valid JS', () => {
  assert.doesNotThrow(() => new vm.Script(agentCursorScript(10, 20, false)));
  assert.doesNotThrow(() => new vm.Script(agentCursorScript(10, 20, true)));
});

test('creates the overlay and positions it at (x, y)', () => {
  const { sandbox, registry } = makeSandbox();
  const result = new vm.Script(agentCursorScript(123, 456, false)).runInContext(vm.createContext(sandbox));
  assert.equal(result.ok, true);
  const cursor = registry.get(AGENT_CURSOR_ID);
  assert.ok(cursor, 'cursor element was created');
  assert.equal(cursor.style.left, '123px');
  assert.equal(cursor.style.top, '456px');
  assert.ok(registry.get(AGENT_CURSOR_STYLE_ID), 'ripple keyframes stylesheet was injected');
});

test('a click pulses a ripple element; a plain move does not', () => {
  const click = makeSandbox();
  new vm.Script(agentCursorScript(5, 5, true)).runInContext(vm.createContext(click.sandbox));
  assert.ok(click.appended.some((el) => String(el.style.cssText).includes('__br_cursor_ripple')), 'click appends a ripple');

  const move = makeSandbox();
  new vm.Script(agentCursorScript(5, 5, false)).runInContext(vm.createContext(move.sandbox));
  assert.ok(!move.appended.some((el) => String(el.style.cssText).includes('__br_cursor_ripple')), 'a move draws no ripple');
});

test('is idempotent — reuses the existing overlay instead of duplicating it', () => {
  const { sandbox, registry, appended } = makeSandbox();
  const ctx = vm.createContext(sandbox);
  new vm.Script(agentCursorScript(1, 1, false)).runInContext(ctx);
  new vm.Script(agentCursorScript(2, 2, false)).runInContext(ctx);
  const cursors = appended.filter((el) => el.id === AGENT_CURSOR_ID);
  assert.equal(cursors.length, 1, 'overlay is created once, then reused');
  assert.equal(registry.get(AGENT_CURSOR_ID).style.left, '2px', 'second call repositions the same element');
});

test('removeAgentCursorScript tears down the overlay and its stylesheet', () => {
  const { sandbox, registry } = makeSandbox();
  const ctx = vm.createContext(sandbox);
  new vm.Script(agentCursorScript(1, 1, false)).runInContext(ctx);
  assert.ok(registry.get(AGENT_CURSOR_ID));
  new vm.Script(removeAgentCursorScript()).runInContext(ctx);
  assert.equal(registry.get(AGENT_CURSOR_ID) ?? null, null, 'cursor removed');
  assert.equal(registry.get(AGENT_CURSOR_STYLE_ID) ?? null, null, 'stylesheet removed');
});
