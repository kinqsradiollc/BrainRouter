/**
 * ADR-060 D4 — the calendar tab offers a way to get a calendar into it.
 *
 * A render test rather than a grep, for the same reason `dueDate.test.tsx` is
 * one: the defect this guards is an op declared on the shared contract with no
 * component that calls it, and a grep for `ops.addCalendar` would pass against
 * exactly that.
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

const addButtons = (tree: ReactTestRenderer) => tree.root.findAll((node) =>
  node.type === 'button' && node.props.className === 'br-planner-add-calendar');

test('a host that can open its connector flow gets the control, and clicking it asks the host', () => {
  let asked = 0;
  const tree = render({ addCalendar: () => { asked += 1; } });
  const [control] = addButtons(tree);
  assert.ok(control, 'the calendar tab offers "Add calendar…"');
  assert.equal(control.children.join('').trim(), 'Add calendar…');
  act(() => { control.props.onClick(); });
  assert.equal(asked, 1, 'the surface opens nothing itself — it asks the host');
});

test('a host with nowhere to send the person gets no control at all', () => {
  // Better than a button that goes nowhere: the dashboard's connector surface
  // is org-admin, so most people there could not act on the page it opened.
  assert.deepEqual(addButtons(render({})), []);
});
