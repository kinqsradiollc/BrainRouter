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

/** The date control for one item, by its accessible name: a "When" chip that
 *  opens a popover holding quick picks and a date field. Opening it is part of
 *  the control, so this returns the date FIELD after the chip has been opened. */
function dueInput(tree: ReactTestRenderer, title: string): ReturnType<ReactTestRenderer['root']['findAll']>[number] | undefined {
  const chip = tree.root.findAll((node) => node.type === 'button'
    && node.props['aria-label'] === `Due date for ${title}`)[0];
  if (!chip) return undefined;
  if (chip.props['aria-expanded'] !== true) act(() => { chip.props.onClick(); });
  return tree.root.findAll((node) => node.type === 'input'
    && node.props.type === 'date'
    && node.props['aria-label'] === `Pick a date for ${title}`)[0];
}

/** A quick pick inside the opened "When" popover, by its visible text — searched
 *  INSIDE the popover, since other rows' chips carry the same words ("Today"). */
function quickPick(tree: ReactTestRenderer, title: string, text: string): ReturnType<ReactTestRenderer['root']['findAll']>[number] | undefined {
  dueInput(tree, title);
  const popover = tree.root.findAll((node) => node.type === 'div' && /br-planner-when-popover/.test(String(node.props.className ?? '')))[0];
  return popover?.findAll((node) => node.type === 'button' && node.children.join('') === text)[0];
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

  const input = dueInput(tree, item.title);
  assert.ok(input, 'the opened chip exposes the date field');
  act(() => { input.props.onChange({ target: { value: '' } }); });

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

test('the quick picks set the day without typing a date: Today and Tomorrow', () => {
  const fixture = createPlannerFixture('2026-09-14');
  const calls: Array<[string, string | null]> = [];
  const item = ownedItem(fixture);
  const tree = render(fixture, { setDueDate: (id, date) => { calls.push([id, date]); } });
  // The pick is looked up OUTSIDE act: opening the chip is itself an act, and a
  // nested act never flushes the popover into the tree.
  const tomorrow = quickPick(tree, item.title, 'Tomorrow');
  assert.ok(tomorrow, 'the opened popover offers Tomorrow');
  act(() => { tomorrow.props.onClick(); });
  const todayPick = quickPick(tree, item.title, 'Today');
  assert.ok(todayPick, 'the reopened popover offers Today');
  act(() => { todayPick.props.onClick(); });
  assert.deepEqual(calls, [[item.id, '2026-09-15'], [item.id, '2026-09-14']]);
});

test('the chip reads as a day, not a raw date: "Today", "Tomorrow", else the weekday', () => {
  const fixture = createPlannerFixture('2026-09-14');
  const tree = render(fixture, { setDueDate: () => {} });
  const labels = tree.root.findAll((node) => node.type === 'button' && /^Due date for /.test(String(node.props['aria-label'] ?? '')))
    .map((node) => node.children.join(''));
  assert.ok(labels.includes('Today'), labels.join(' | '));
  assert.ok(labels.includes('Tomorrow'), labels.join(' | '));
  assert.ok(labels.some((label) => /^(Sat|Sun|Wed|Thu|Fri|Mon|Tue) \d+$/.test(label)), labels.join(' | '));
  assert.ok(labels.includes('Set day'), 'an item with no day offers to set one');
});

