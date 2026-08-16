/**
 * ADR-038 D3 — the field that sorts the day can be set from the surface whose
 * job is the day.
 *
 * `groupFor` reads `dueDate` to decide overdue / due today / next / anytime, so
 * it orders the entire Today view. Until this landed, `PlannerOps.setDueDate`
 * was declared on the shared contract and implemented by the desktop host, and
 * NO shared component called it — while `/planner due` worked from the terminal.
 * The CLI could move work the GUI could not, which inverts D5.
 *
 * These are render tests rather than source greps on purpose: the defect they
 * guard was a wired op with no caller, and a grep for `ops.setDueDate` would
 * have passed against the very code that shipped broken.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { PlannerSurface } from './PlannerSurface.js';
import { createPlannerFixture } from './fixture.js';
import type { PlannerFixture } from './fixture.js';
import type { PlannerItemView, PlannerOps } from './types.js';

function render(fixture: PlannerFixture, ops: PlannerOps): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      <PlannerSurface
        items={fixture.items}
        blocks={fixture.blocks}
        today={fixture.today}
        sync={fixture.sync}
        ops={ops}
      />,
    );
  });
  return tree;
}

/** The date control for one item, by its accessible name. */
function dueInput(tree: ReactTestRenderer, title: string): ReturnType<ReactTestRenderer['root']['findAll']>[number] | undefined {
  return tree.root.findAll((node) => node.type === 'input'
    && node.props.type === 'date'
    && node.props['aria-label'] === `Due date for ${title}`)[0];
}

function ownedItem(fixture: PlannerFixture): PlannerItemView {
  const item = fixture.items.find((candidate: PlannerItemView) => candidate.origin === 'owned');
  assert.ok(item, 'the fixture must carry an owned item');
  return item;
}

test('an owned item can be given a due date from the row, and the op receives it', () => {
  const fixture = createPlannerFixture();
  const calls: Array<[string, string | null]> = [];
  const item = ownedItem(fixture);
  const tree = render(fixture, { setDueDate: (id, date) => { calls.push([id, date]); } });

  const input = dueInput(tree, item.title);
  assert.ok(input, 'an owned item renders a date control');
  act(() => { input.props.onChange({ target: { value: '2026-09-01' } }); });

  assert.deepEqual(calls, [[item.id, '2026-09-01']]);
});

test('clearing the control clears the date rather than sending an empty string', () => {
  const fixture = createPlannerFixture();
  const calls: Array<[string, string | null]> = [];
  const item = ownedItem(fixture);
  const tree = render(fixture, { setDueDate: (id, date) => { calls.push([id, date]); } });

  act(() => { dueInput(tree, item.title)!.props.onChange({ target: { value: '' } }); });

  // `''` would round-trip as a due date of the empty string and sort the item
  // into a group it does not belong to; null is the absence the model means.
  assert.deepEqual(calls, [[item.id, null]]);
});

test('a mirrored item shows its due date and refuses to edit it, saying why', () => {
  const fixture = createPlannerFixture();
  const mirrored = fixture.items.find((candidate: PlannerItemView) => candidate.origin !== 'owned' && candidate.dueDate);
  if (!mirrored) return; // the fixture has no dated mirror; nothing to assert here

  const tree = render(fixture, { setDueDate: () => { throw new Error('a mirrored due date must not be editable'); } });

  assert.equal(dueInput(tree, mirrored.title), undefined, 'no control for a field the next refresh would undo');
  const shown = tree.root.findAll((node) => node.type === 'time' && node.props.dateTime === mirrored.dueDate)[0];
  assert.ok(shown, 'the date is still READ as a fact, it just cannot be written');
  assert.match(String(shown.props.title ?? ''), /belongs to|would be undone/i);
});

test('a host that supplies no setDueDate gets no control at all', () => {
  const fixture = createPlannerFixture();
  const item = ownedItem(fixture);
  const tree = render(fixture, {});

  // Not a disabled input: a control that cannot do anything is the surface
  // claiming a capability the host did not give it.
  assert.equal(dueInput(tree, item.title), undefined);
});
