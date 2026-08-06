/**
 * ADR-028 C1 — the Execution engine control has to stay REACHABLE, not merely
 * compiled. The decision it implements exists because `cli.executionEngine` was
 * resolved, typed and unit-tested for two releases while nothing read it; a
 * passing unit test is exactly what let that survive. So this file walks the
 * whole path a person takes to the control — category nav, subsection, mounted
 * component, rendered group, the knob it writes, and Settings search — and
 * fails on any single break in it.
 *
 * The section is rendered by CALLING the component (it takes no hooks of its
 * own) and walking the returned element tree, so the assertions are about what
 * a user is handed rather than about the source text that produces it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type React from 'react';
import { NAV, searchSettings, settingsGroupForSection, settingsSectionForGroup } from '../shared/types.js';
import { RuntimeSection } from './RuntimeSection.js';

type Element = { type: unknown; props: Record<string, unknown> };

function isElement(value: unknown): value is Element {
  return typeof value === 'object' && value !== null && 'type' in value && 'props' in value;
}

/** Every element in the tree, depth-first, including nested children arrays. */
function walk(node: unknown, out: Element[] = []): Element[] {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out);
    return out;
  }
  if (!isElement(node)) return out;
  out.push(node);
  walk(node.props.children, out);
  return out;
}

/**
 * Every plain-string leaf, so rendered copy can be asserted without a DOM.
 * `desc` is walked alongside `children` because the Row primitive takes its
 * explanatory copy as a prop, and that copy is most of what a user reads.
 */
function text(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') { out.push(node); return out; }
  if (Array.isArray(node)) { for (const child of node) text(child, out); return out; }
  if (isElement(node)) { text(node.props.desc, out); text(node.props.children, out); }
  return out;
}

function renderRuntime(knobs: Record<string, unknown>): { tree: Element[]; writes: Array<[string, unknown]> } {
  const writes: Array<[string, unknown]> = [];
  const element = RuntimeSection({
    knobs,
    setPath: (path: string, value: unknown) => { writes.push([path, value]); },
  }) as unknown as React.ReactElement;
  return { tree: walk(element), writes };
}

/** The group a user is looking for, found the way a user finds it: by its title. */
function engineGroup(tree: Element[]): Element {
  const group = tree.find((el) => el.props.title === 'Execution engine');
  assert.ok(group, 'Settings → Runtime no longer renders an "Execution engine" group');
  return group;
}

/** The one control inside that group carrying a value + options + onChange. */
function engineSelect(tree: Element[]): Element {
  const inside = walk(engineGroup(tree).props.children);
  const select = inside.find((el) => Array.isArray(el.props.options) && typeof el.props.onChange === 'function');
  assert.ok(select, 'The Execution engine group no longer contains a selectable control');
  return select;
}

test('the Runtime page stays reachable from the Settings category nav', () => {
  // settings.tsx renders the subnav as NAV filtered by the active category and
  // nothing else, so presence in NAV under a real category IS the click path.
  const entry = NAV.find((item) => item.section === 'runtime');
  assert.ok(entry, 'Settings lost its Runtime page; the Execution engine control has no host');
  assert.equal(entry.group, 'Automation');
  assert.equal(settingsGroupForSection('runtime'), 'Automation');
  // Picking the category then the remembered subsection must land on Runtime.
  assert.equal(settingsSectionForGroup('Automation', 'runtime'), 'runtime');
});

test('choosing the Runtime page mounts the section that owns the engine control', () => {
  // The section switch is a literal `case` in the composed dialog; a component
  // that renders correctly but is never mounted is the exact ADR-028 failure.
  const dialog = readFileSync(new URL('../../settings.tsx', import.meta.url), 'utf8');
  assert.match(dialog, /import \{ RuntimeSection \} from '\.\/settings\/runtime\/RuntimeSection\.js'/);
  assert.match(dialog, /case 'runtime':\s*return \(\s*<RuntimeSection/);
});

test('the Runtime section renders the Execution engine control with both engines', () => {
  const { tree } = renderRuntime({});
  const select = engineSelect(tree);
  assert.deepEqual(select.props.options, ['loop', 'graph']);
  // No stored preference must still present a definite engine, not a blank.
  assert.equal(select.props.value, 'loop');
});

test('changing the engine writes the knob the runtime actually reads', () => {
  // cli.executionEngine is what runTurn resolves; a control writing anything
  // else is the switch-that-does-nothing this decision removed.
  const { tree, writes } = renderRuntime({});
  (engineSelect(tree).props.onChange as (value: string) => void)('graph');
  assert.deepEqual(writes, [['executionEngine', 'graph']]);
});

test('a stored graph preference is reflected back and says the turn still runs on the loop', () => {
  const { tree } = renderRuntime({ executionEngine: 'graph' });
  assert.equal(engineSelect(tree).props.value, 'graph');
  // The graph engine lacks interrupts and tool authorization, so selecting it
  // falls back. The fallback has to be visible where the choice is made, or the
  // setting reads as broken rather than as pending.
  const copy = text(engineGroup(tree).props.children).join(' ');
  assert.match(copy, /falls back to the loop/);
  assert.match(copy, /turns run on the loop until it reaches parity/);
  // The fallback warning is conditional on the choice, so it must be absent on
  // the default engine — otherwise it is decoration rather than a signal.
  const onLoop = text(engineGroup(renderRuntime({}).tree).props.children).join(' ');
  assert.doesNotMatch(onLoop, /turns run on the loop until it reaches parity/);
});

test('Settings search finds the engine control by the words a person types', () => {
  // searchSettings requires EVERY term to match, so a page is unfindable unless
  // its aliases carry the control's own vocabulary. "execution" alone matched
  // via the page summary while "execution engine", "graph" and "loop" returned
  // nothing — a control reachable only by someone who knows the nav path.
  assert.deepEqual(searchSettings('execution engine').map((item) => item.section), ['runtime']);
  assert.ok(searchSettings('graph').some((item) => item.section === 'runtime'));
  assert.ok(searchSettings('loop').some((item) => item.section === 'runtime'));
  assert.ok(searchSettings('comprehension').some((item) => item.section === 'runtime'));
});
