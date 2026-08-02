/**
 * ADR-027 D6 (P4-3) — the agent-callable control layer.
 *
 * Most of these test REJECTION and FILTERING, because the registry's value is
 * not that it stores things — it is that a badly-declared action cannot enter
 * the catalog the agent reads, and a forbidden one is never shown at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ControlRegistry,
  ControlRegistrationError,
  controlActionError,
  CONTROL_EFFECTS,
  type ControlAction,
} from '../control/controlRegistry.js';

const action = (over: Partial<ControlAction> = {}): ControlAction => ({
  name: 'panel.open',
  description: 'Open a workbench side panel by id.',
  effect: 'view',
  ...over,
});

test('a well-formed action registers and is retrievable', () => {
  const registry = new ControlRegistry();
  registry.register(action());
  assert.equal(registry.get('panel.open')?.effect, 'view');
});

test('a duplicate name throws rather than overwriting', () => {
  // Last-write-wins makes behaviour depend on module load order, and the loser
  // fails in a way nobody can reproduce.
  const registry = new ControlRegistry();
  registry.register(action());
  assert.throws(() => registry.register(action({ description: 'A different one entirely.' })),
    ControlRegistrationError);
});

test('a malformed name is rejected', () => {
  for (const name of ['open', 'Panel.Open', 'panel_open', 'panel.', '.open', 'panel..open', '']) {
    assert.ok(controlActionError(action({ name })), `should reject name: ${JSON.stringify(name)}`);
  }
  assert.equal(controlActionError(action({ name: 'panel.open' })), null);
  assert.equal(controlActionError(action({ name: 'workbench.panel.open' })), null);
});

test('a useless description is rejected — unusable by the agent is the same as absent', () => {
  for (const description of ['', '   ', 'opens', 'does thing']) {
    assert.ok(controlActionError(action({ description })), `should reject: ${JSON.stringify(description)}`);
  }
});

test('an unknown effect class is rejected rather than defaulted', () => {
  assert.ok(controlActionError(action({ effect: 'writes' as never })));
  for (const effect of CONTROL_EFFECTS) {
    assert.equal(controlActionError(action({ effect })), null, `should accept: ${effect}`);
  }
});

test('parameters must be a schema object when present', () => {
  assert.ok(controlActionError(action({ parameters: [] as never })));
  assert.ok(controlActionError(action({ parameters: 'schema' as never })));
  assert.equal(controlActionError(action({ parameters: { type: 'object' } })), null);
  assert.equal(controlActionError(action({ parameters: undefined })), null, 'omitted is fine');
});

test('the catalog is sorted so the agent sees a stable list between runs', () => {
  const registry = new ControlRegistry();
  registry.register(action({ name: 'zed.act', description: 'Do the last thing alphabetically.' }));
  registry.register(action({ name: 'alpha.act', description: 'Do the first thing alphabetically.' }));
  assert.deepEqual(registry.list().map((a) => a.name), ['alpha.act', 'zed.act']);
});

test('a ceiling filters the CATALOG, not just the call', () => {
  // Showing an action the agent cannot use costs it a turn to discover the
  // refusal, and lets it narrate a capability it does not have.
  const registry = new ControlRegistry();
  registry.register(action({ name: 'a.read', effect: 'read', description: 'Read some workbench state.' }));
  registry.register(action({ name: 'b.view', effect: 'view', description: 'Change what is displayed.' }));
  registry.register(action({ name: 'c.write', effect: 'mutate', description: 'Write durable local state.' }));
  registry.register(action({ name: 'd.send', effect: 'external', description: 'Send something off the machine.' }));

  assert.deepEqual(registry.listUpTo('read').map((a) => a.name), ['a.read']);
  assert.deepEqual(registry.listUpTo('view').map((a) => a.name), ['a.read', 'b.view']);
  assert.deepEqual(registry.listUpTo('mutate').map((a) => a.name), ['a.read', 'b.view', 'c.write']);
  assert.equal(registry.listUpTo('external').length, 4);
});

test('permits agrees with the catalog filter', () => {
  const external = action({ name: 'x.send', effect: 'external', description: 'Send something off the machine.' });
  assert.equal(ControlRegistry.permits('mutate', external), false);
  assert.equal(ControlRegistry.permits('external', external), true);
  assert.equal(ControlRegistry.permits('read', action({ effect: 'read' })), true);
});

test('confirmation covers irreversible actions AND anything leaving the machine', () => {
  // Effect class and reversibility are independent: a reversible mutate and an
  // irreversible one deserve different treatment at the same class.
  const registry = new ControlRegistry();
  registry.register(action({ name: 'a.open', effect: 'view', description: 'Open a panel; closing undoes it.' }));
  registry.register(action({ name: 'b.save', effect: 'mutate', description: 'Save the current draft locally.' }));
  registry.register(action({
    name: 'c.delete', effect: 'mutate', irreversible: true,
    description: 'Permanently delete the selected session.',
  }));
  registry.register(action({ name: 'd.post', effect: 'external', description: 'Publish the note to the team feed.' }));

  assert.deepEqual(registry.requiresConfirmation().map((a) => a.name), ['c.delete', 'd.post']);
});

test('an unregistered name resolves to undefined rather than throwing', () => {
  assert.equal(new ControlRegistry().get('nope.missing'), undefined);
});

test('effect classes are ordered by escalating consequence', () => {
  // The ordering is load-bearing for `listUpTo`; pin it so a reorder is a
  // deliberate act rather than an accident.
  assert.deepEqual([...CONTROL_EFFECTS], ['read', 'view', 'mutate', 'external']);
});
