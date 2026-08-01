/**
 * ADR-027 D6 (P4-4) — the typed renderer↔main command map.
 *
 * The runtime checks here duplicate what the types already enforce, on purpose.
 * Types do not survive a `JSON.parse`, an `any` at a module boundary, or a
 * handler object assembled dynamically — and this boundary takes command names
 * from a renderer process, which is precisely where a compile-time-only
 * guarantee stops being a guarantee.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defineCommands,
  createDispatcher,
  UnknownCommandError,
  CommandWiringError,
  type CommandContract,
  type HandlerMap,
} from '../control/commandMap.js';

const COMMANDS = defineCommands({
  'panel.open': {
    description: 'Open a workbench side panel by id.',
    effect: 'view',
  } as CommandContract<{ id: string }, { opened: boolean }>,
  'session.rename': {
    description: 'Rename the active session.',
    effect: 'mutate',
  } as CommandContract<{ title: string }, void>,
});

const handlers: HandlerMap<typeof COMMANDS> = {
  'panel.open': async ({ id }) => ({ opened: id.length > 0 }),
  'session.rename': async () => {},
};

test('a bound dispatcher invokes the right handler with the right payload', async () => {
  const dispatcher = createDispatcher(COMMANDS, handlers);
  assert.deepEqual(await dispatcher.invoke('panel.open', { id: 'files' }), { opened: true });
});

test('a command with no handler fails at wiring time, not at call time', () => {
  // A dead call site surfaces far from its cause: the renderer invokes,
  // nothing answers, and the error appears somewhere unrelated.
  const partial = { 'panel.open': async () => ({ opened: true }) } as unknown as HandlerMap<typeof COMMANDS>;
  assert.throws(() => createDispatcher(COMMANDS, partial), (error: Error) => {
    assert.ok(error instanceof CommandWiringError);
    assert.match(error.message, /session\.rename/);
    return true;
  });
});

test('a handler with no command also fails — dead code that reads as live', () => {
  // The direction usually missed. An orphaned handler makes the boundary look
  // larger than it is, and the next person wires against a dead channel.
  const extra = { ...handlers, 'ghost.channel': async () => null } as unknown as HandlerMap<typeof COMMANDS>;
  assert.throws(() => createDispatcher(COMMANDS, extra), (error: Error) => {
    assert.ok(error instanceof CommandWiringError);
    assert.match(error.message, /ghost\.channel/);
    return true;
  });
});

test('a non-function in the handler slot counts as missing', () => {
  const bad = { ...handlers, 'session.rename': 'nope' } as unknown as HandlerMap<typeof COMMANDS>;
  assert.throws(() => createDispatcher(COMMANDS, bad), CommandWiringError);
});

test('an unknown name from outside the type system is rejected, not silently undefined', async () => {
  const dispatcher = createDispatcher(COMMANDS, handlers);
  await assert.rejects(
    () => dispatcher.invokeUnsafe('panel.opne', { id: 'x' }),
    (error: Error) => {
      assert.ok(error instanceof UnknownCommandError);
      // Echo the name: a typo is the common case, and guessing a near-match
      // would dispatch something the caller did not ask for.
      assert.match(error.message, /panel\.opne/);
      return true;
    },
  );
});

test('prototype keys do not resolve to Object.prototype members', async () => {
  // `handlers['constructor']` is a function on any plain object. A truthy
  // lookup would happily "dispatch" it.
  const dispatcher = createDispatcher(COMMANDS, handlers);
  for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    await assert.rejects(() => dispatcher.invokeUnsafe(key, {}), UnknownCommandError, `for ${key}`);
  }
  assert.equal(dispatcher.describe('constructor'), undefined);
});

test('a synchronous handler is still awaited correctly', async () => {
  const sync = defineCommands({
    'x.now': { description: 'Return a value synchronously.', effect: 'read' } as CommandContract<void, number>,
  });
  const dispatcher = createDispatcher(sync, { 'x.now': () => 42 });
  assert.equal(await dispatcher.invoke('x.now', undefined), 42);
});

test('a throwing handler propagates rather than being swallowed', async () => {
  const boom = defineCommands({
    'x.fail': { description: 'Always fails, for testing.', effect: 'read' } as CommandContract<void, never>,
  });
  const dispatcher = createDispatcher(boom, {
    'x.fail': () => { throw new Error('handler exploded'); },
  });
  await assert.rejects(() => dispatcher.invoke('x.fail', undefined), /handler exploded/);
});

test('introspection is stable and carries the effect class', () => {
  const dispatcher = createDispatcher(COMMANDS, handlers);
  assert.deepEqual(dispatcher.names(), ['panel.open', 'session.rename'], 'sorted for stable introspection');
  assert.equal(dispatcher.describe('session.rename')?.effect, 'mutate');
  assert.match(dispatcher.describe('panel.open')!.description, /side panel/);
});

test('an empty map is legal and dispatches nothing', async () => {
  const dispatcher = createDispatcher({}, {});
  assert.deepEqual(dispatcher.names(), []);
  await assert.rejects(() => dispatcher.invokeUnsafe('anything', null), UnknownCommandError);
});
