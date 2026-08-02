/**
 * ADR-027 D6 (P4-3/P4-4/P4-5) — the agent-callable control layer.
 *
 * The failures worth testing are all silent ones: an action that does nothing
 * quietly, a destructive action reachable by a guessed name, an argument that
 * is ignored rather than rejected. Each would leave the agent confidently
 * continuing from a false premise.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRegistry,
  register,
  invoke,
  describeForModel,
  readOnlyView,
  confirmationTokenFor,
  ControlError,
  type ControlAction,
} from '../workbench/controlLayer.js';

function action(over: Partial<ControlAction> = {}): ControlAction {
  return {
    id: 'session.rename',
    title: 'Rename the current session',
    effect: 'mutate',
    params: { name: { type: 'string', required: true, description: 'The new name' } },
    run: async (args) => ({ renamed: args.name }),
    ...over,
  } as ControlAction;
}

test('an unknown action is an error naming what IS available', () => {
  // A silent no-op would leave the agent believing it succeeded.
  const registry = createRegistry([action()]);
  await_(async () => {
    await assert.rejects(
      () => invoke(registry, 'session.renmae'),
      (e: ControlError) => e.code === 'unknown_action' && /session\.rename/.test(e.message),
    );
  });
});

test('a destructive action cannot be invoked without confirmation', async () => {
  const registry = createRegistry([action({
    id: 'workspace.delete', title: 'Delete the workspace', effect: 'destructive', params: {},
  })]);
  await assert.rejects(
    () => invoke(registry, 'workspace.delete'),
    (e: ControlError) => e.code === 'confirmation_required',
  );
  await assert.rejects(
    () => invoke(registry, 'workspace.delete', {}, { confirmation: 'yes' }),
    (e: ControlError) => e.code === 'confirmation_required',
  );
});

test('the confirmation token names the specific action', async () => {
  // A generic "confirm" would let a token intended for one destructive action
  // authorize a different one.
  const registry = createRegistry([
    action({ id: 'a.destroy', title: 'A', effect: 'destructive', params: {}, run: () => 'a' }),
    action({ id: 'b.destroy', title: 'B', effect: 'destructive', params: {}, run: () => 'b' }),
  ]);
  await assert.rejects(
    () => invoke(registry, 'b.destroy', {}, { confirmation: confirmationTokenFor('a.destroy') }),
    (e: ControlError) => e.code === 'confirmation_required',
  );
  assert.equal(await invoke(registry, 'b.destroy', {}, { confirmation: confirmationTokenFor('b.destroy') }), 'b');
});

test('a missing required parameter is rejected before the action runs', async () => {
  let ran = false;
  const registry = createRegistry([action({ run: () => { ran = true; return 1; } })]);
  await assert.rejects(() => invoke(registry, 'session.rename', {}),
    (e: ControlError) => e.code === 'bad_arguments');
  assert.equal(ran, false, 'the action must not run on bad arguments');
});

test('a wrongly typed parameter is rejected rather than coerced', async () => {
  const registry = createRegistry([action()]);
  await assert.rejects(() => invoke(registry, 'session.rename', { name: 42 }),
    (e: ControlError) => e.code === 'bad_arguments');
});

test('an unknown parameter is rejected, not ignored', async () => {
  // Silently ignoring it is how a caller believes it constrained an action it
  // did not — e.g. passing `dryRun: true` to something that has no such option.
  const registry = createRegistry([action()]);
  await assert.rejects(
    () => invoke(registry, 'session.rename', { name: 'x', dryRun: true }),
    (e: ControlError) => e.code === 'bad_arguments' && /dryRun/.test(e.message),
  );
});

test('a duplicate action id is refused', () => {
  // Two implementations behind one name makes meaning depend on registration
  // order — a bug that surfaces only after a refactor moves a file.
  assert.throws(
    () => createRegistry([action(), action()]),
    (e: ControlError) => e.code === 'duplicate_action',
  );
});

test('ids and titles are validated, because they are an agent-facing contract', () => {
  for (const bad of ['Session.Rename', 'rename', 'session..rename', 'session.', '']) {
    assert.throws(() => createRegistry([action({ id: bad })]),
      (e: ControlError) => e.code === 'invalid_definition', `for "${bad}"`);
  }
  assert.throws(() => createRegistry([action({ title: '  ' })]),
    (e: ControlError) => e.code === 'invalid_definition');
});

test('an undescribed parameter is refused', () => {
  // The model fills an undescribed parameter by guessing.
  assert.throws(
    () => createRegistry([action({
      params: { name: { type: 'string', required: true, description: '' } },
    })]),
    (e: ControlError) => e.code === 'invalid_definition',
  );
});

test('the model description marks destructive actions and their token', () => {
  // Hiding them would not remove the capability, only the warning.
  const registry = createRegistry([
    action(),
    action({ id: 'workspace.delete', title: 'Delete the workspace', effect: 'destructive', params: {} }),
  ]);
  const described = describeForModel(registry);
  assert.deepEqual(described.map((d) => d.name), ['session.rename', 'workspace.delete']);
  const destructive = described.find((d) => d.name === 'workspace.delete')!;
  assert.equal(destructive.requiresConfirmation, true);
  assert.match(destructive.description, /DESTRUCTIVE/);
  assert.match(destructive.description, /confirm:workspace\.delete/);
  assert.equal(described.find((d) => d.name === 'session.rename')!.requiresConfirmation, false);
});

test('a read-only view drops everything that can change state', async () => {
  const registry = createRegistry([
    action({ id: 'session.list', title: 'List sessions', effect: 'read', params: {}, run: () => [] }),
    action(),
    action({ id: 'workspace.delete', title: 'Delete', effect: 'destructive', params: {} }),
  ]);
  const view = readOnlyView(registry);
  assert.deepEqual([...view.actions.keys()], ['session.list']);
  await assert.rejects(() => invoke(view, 'session.rename', { name: 'x' }),
    (e: ControlError) => e.code === 'unknown_action');
});

test('registering returns a new registry rather than mutating the old one', () => {
  const base = createRegistry([action()]);
  const extended = register(base, action({ id: 'session.close', title: 'Close', params: {} }));
  assert.equal(base.actions.size, 1);
  assert.equal(extended.actions.size, 2);
});

test('a valid invocation reaches the action with its arguments', async () => {
  const registry = createRegistry([action()]);
  assert.deepEqual(await invoke(registry, 'session.rename', { name: 'new' }), { renamed: 'new' });
});

/** Small helper so the unknown-action case can stay `await`-free at top level. */
function await_(fn: () => Promise<void>): Promise<void> { return fn(); }
