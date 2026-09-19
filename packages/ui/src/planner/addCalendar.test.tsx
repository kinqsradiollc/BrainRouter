/**
 * ADR-060 D4 — the calendar tab offers a way to get a calendar into it.
 *
 * Render tests rather than greps, for the same reason `dueDate.test.tsx` uses
 * them: the defect they guard is an op declared on the shared contract with no
 * component that calls it, and a grep for `ops.importCalendar` would pass
 * against exactly that.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { PlannerSurface } from './PlannerSurface.js';
import { createPlannerFixture } from './fixture.js';
import type { PlannerOps } from './types.js';

function render(ops: PlannerOps): ReactTestRenderer {
  const fixture = createPlannerFixture();
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      <PlannerSurface
        items={fixture.items}
        blocks={fixture.blocks}
        today={fixture.today}
        sync={fixture.sync}
        initialView="calendar"
        ops={ops}
      />,
    );
  });
  return tree;
}

const control = (tree: ReactTestRenderer) => tree.root.findAll((node) =>
  node.type === 'button' && node.props.className === 'br-planner-add-calendar')[0];

const routeTitles = (tree: ReactTestRenderer) => tree.root
  .findAll((node) => node.type === 'strong')
  .map((node) => String(node.children.join('')))
  .filter((text) => text.endsWith('…'));

test('with both routes the control opens them as a choice, and picking one asks the host', () => {
  let subscribed = 0;
  let imported = 0;
  const tree = render({ subscribeCalendar: () => { subscribed += 1; }, importCalendar: () => { imported += 1; } });
  const button = control(tree);
  assert.ok(button, 'the calendar tab offers "Add calendar…"');
  assert.equal(button.props['aria-expanded'], false, 'closed until asked');
  assert.deepEqual(routeTitles(tree), [], 'and nothing is listed while it is closed');

  act(() => { button.props.onClick(); });
  assert.deepEqual(routeTitles(tree), ['Subscribe to a feed…', 'Import an .ics file…']);

  const pick = (title: string) => tree.root.findAll((node) => node.type === 'button'
    && node.findAll((child) => child.type === 'strong' && child.children.join('') === title).length > 0)[0]!;
  act(() => { pick('Import an .ics file…').props.onClick(); });
  assert.equal(imported, 1, 'the surface opens nothing itself — it asks the host');
  assert.equal(subscribed, 0);
  assert.deepEqual(routeTitles(tree), [], 'and the menu closes behind the choice');
});

test('with one route it is a plain button, because a menu of one wastes a click', () => {
  let subscribed = 0;
  const tree = render({ subscribeCalendar: () => { subscribed += 1; } });
  const button = control(tree);
  assert.ok(button);
  assert.equal(button.props['aria-haspopup'], undefined);
  act(() => { button.props.onClick(); });
  assert.equal(subscribed, 1, 'one click, not two');
});

test('a host that offers neither route gets no control at all', () => {
  // Better than a button that goes nowhere: the dashboard's connector surface
  // is org-admin, so most people there could not act on the page it opened.
  assert.equal(control(render({})), undefined);
});
