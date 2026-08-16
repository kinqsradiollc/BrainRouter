/**
 * ADR-028 C1 — the Execution engine control is RETIRED, and stays retired.
 *
 * What stood here was a reachability test: it walked the whole path a person
 * takes to the engine dropdown — category nav, subsection, mounted component,
 * rendered group, the knob it writes, Settings search — and passed. It kept
 * passing while the second option in that dropdown could not run a turn:
 * `graph` had no interrupts, no tool authorization, no receipts and no
 * delegation, so `selectEngine` always fell back to the loop and the group's
 * own copy explained the fallback underneath the control.
 *
 * A control offering a choice that cannot happen is exactly the surface this
 * ADR exists to remove, and a test proving the control is REACHABLE says
 * nothing about whether the thing it selects can RUN. So the engine went, the
 * knob went, and this file inverts: it fails if either comes back.
 *
 * What it keeps from the old file is the part that was about a real surface —
 * Settings → Runtime is still a page a person navigates to, and the retirement
 * must not have taken the page with it.
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

/** Every plain-string leaf, so rendered copy can be asserted without a DOM. */
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

test('Settings → Runtime is still a page a person can navigate to', () => {
  // The engine control is gone; the page that hosted it is not. settings.tsx
  // renders the subnav as NAV filtered by the active category and nothing else,
  // so presence in NAV under a real category IS the click path.
  const entry = NAV.find((item) => item.section === 'runtime');
  assert.ok(entry, 'Settings lost its Runtime page');
  assert.equal(entry.group, 'Automation');
  assert.equal(settingsGroupForSection('runtime'), 'Automation');
  assert.equal(settingsSectionForGroup('Automation', 'runtime'), 'runtime');

  const dialog = readFileSync(new URL('../../settings.tsx', import.meta.url), 'utf8');
  assert.match(dialog, /import \{ RuntimeSection \} from '\.\/settings\/runtime\/RuntimeSection\.js'/);
  assert.match(dialog, /case 'runtime':\s*return \(\s*<RuntimeSection/);
});

test('the Runtime section offers no execution-engine control', () => {
  const { tree } = renderRuntime({});
  assert.equal(
    tree.some((el) => el.props.title === 'Execution engine'),
    false,
    'The "Execution engine" group is back. There is one turn engine; a dropdown ' +
      'whose second option cannot run a turn is what C1 retired.',
  );
  const copy = text(tree.map((el) => el.props.children)).join(' ').toLowerCase();
  assert.doesNotMatch(copy, /\bgraph engine\b/, 'Runtime settings describe a graph engine again');
});

test('nothing in the Runtime section writes cli.executionEngine', () => {
  // The knob is no longer resolved by core, so a control writing it would be
  // the original defect exactly: a setting a person changes and watches do
  // nothing. Every control in the section is exercised rather than inspected.
  const { tree, writes } = renderRuntime({ executionEngine: 'graph' });
  for (const el of tree) {
    const onChange = el.props.onChange;
    if (typeof onChange === 'function' && Array.isArray(el.props.options)) {
      (onChange as (value: string) => void)(String((el.props.options as string[])[0]));
    }
  }
  assert.deepEqual(
    writes.filter(([path]) => path === 'executionEngine'),
    [],
    'A Runtime control still writes cli.executionEngine, which nothing reads.',
  );
});

test('a stale executionEngine in config.json changes nothing on screen', () => {
  // Config files in the wild still carry the key. It must be inert, not
  // half-honoured: the section renders identically with and without it.
  const withKnob = text(renderRuntime({ executionEngine: 'graph' }).tree.map((el) => el.props.children)).join(' ');
  const without = text(renderRuntime({}).tree.map((el) => el.props.children)).join(' ');
  assert.equal(withKnob, without);
});

test('Settings search no longer advertises an engine choice', () => {
  // The nav keywords carried "engine loop graph" so the control could be found
  // by its own name. Leaving them behind would send someone to a page that no
  // longer has what they searched for, which is its own small lie.
  // Asserted as "runtime is not among the hits" rather than "no hits": search
  // is substring-based, so "graph" still matches Appearance through the
  // "graphite mono" theme, and that hit is correct.
  assert.equal(searchSettings('execution engine').some((item) => item.section === 'runtime'), false);
  assert.equal(searchSettings('graph').some((item) => item.section === 'runtime'), false);
  // The page itself is still findable by what it does have.
  assert.ok(searchSettings('comprehension').some((item) => item.section === 'runtime'));
  assert.ok(searchSettings('worktree').some((item) => item.section === 'runtime'));
});
