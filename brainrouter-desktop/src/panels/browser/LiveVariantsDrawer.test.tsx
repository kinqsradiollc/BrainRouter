/**
 * ADR-056 D-B5 — the Live Variants drawer renders its three states and each
 * control calls back. Presentational, so a stubbed set of callbacks proves the
 * pick → generate → cycle → keep/discard wiring without a real browser.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { LiveVariantsDrawer, type LiveVariantsDrawerProps } from './LiveVariantsDrawer.js';
import type { LiveVariantTarget } from '../../lib/browser/liveVariants.js';
import { mount, press, screenText, hasButton, isDisabled, button, type Mounted } from '../../testing/reactHarness.js';

const TARGET: LiveVariantTarget = {
  selector: 'header > h1.hero', tag: 'h1', text: 'Ship faster', classes: ['hero'], elementId: 'headline',
  outerHtml: '<h1 class="hero" id="headline">Ship faster</h1>', hint: { file: 'src/pages/Landing.tsx', line: 42, framework: 'react' },
};

function props(over: Partial<LiveVariantsDrawerProps>): LiveVariantsDrawerProps {
  return {
    mode: 'pick', ready: true, busy: false, status: '',
    elements: [], loadingElements: false, onRescanElements: () => {}, onPick: () => {},
    target: null, action: '', count: 3, onSetAction: () => {}, onSetCount: () => {}, onGenerate: () => {}, onRepick: () => {},
    cycler: null, onPrev: () => {}, onNext: () => {}, onAccept: () => {}, onDiscard: () => {}, onRescan: () => {},
    ...over,
  };
}

test('B5 pick mode lists the page elements and picking one calls back', async () => {
  const picked: string[] = [];
  let m: Mounted | null = null;
  try {
    m = await mount(<LiveVariantsDrawer {...props({ elements: [{ ref: 'br:t:1:node_1', label: 'Ship faster', tag: 'h1', role: 'heading' }], onPick: (row) => picked.push(row.ref) })} />);
    await m.flush();
    assert.match(screenText(m.root), /Pick the element/);
    await press(m, 'Make variants of Ship faster');
    assert.deepEqual(picked, ['br:t:1:node_1']);
  } finally { m?.unmount(); }
});

test('B5 form mode shows the target and hint, and Generate calls back', async () => {
  let generated = 0;
  let m: Mounted | null = null;
  try {
    m = await mount(<LiveVariantsDrawer {...props({ mode: 'form', target: TARGET, action: 'bolder', count: 3, onGenerate: () => { generated += 1; } })} />);
    await m.flush();
    const text = screenText(m.root);
    assert.match(text, /h1\.hero#headline/);
    assert.match(text, /Ship faster/);
    assert.match(text, /src\/pages\/Landing\.tsx:42/);
    assert.ok(hasButton(m.root, 'Generate 3 variants'));
    await press(m, 'Generate 3 variants');
    assert.equal(generated, 1);
  } finally { m?.unmount(); }
});

test('B5 form mode says so when there is no source hint', async () => {
  let m: Mounted | null = null;
  try {
    m = await mount(<LiveVariantsDrawer {...props({ mode: 'form', target: { ...TARGET, hint: undefined } })} />);
    await m.flush();
    assert.match(screenText(m.root), /no source hint/i);
  } finally { m?.unmount(); }
});

test('B5 cycle mode drives prev/next/keep/discard and disables stepping a single node', async () => {
  const calls: string[] = [];
  let m: Mounted | null = null;
  try {
    m = await mount(<LiveVariantsDrawer {...props({
      mode: 'cycle', cycler: { id: 'hero-1', action: 'bolder', count: 4, active: 2 },
      onPrev: () => calls.push('prev'), onNext: () => calls.push('next'), onAccept: () => calls.push('accept'), onDiscard: () => calls.push('discard'),
    })} />);
    await m.flush();
    assert.match(screenText(m.root), /variant 2 of 3 · bolder/);
    await press(m, 'Next variant');
    await press(m, 'Previous variant');
    await press(m, 'Keep this one');
    await press(m, 'Discard all');
    assert.deepEqual(calls, ['next', 'prev', 'accept', 'discard']);
  } finally { m?.unmount(); }
});

test('B5 cycle mode disables the steppers when the wrapper has a single child, and offers a rescan when empty', async () => {
  let m: Mounted | null = null;
  try {
    m = await mount(<LiveVariantsDrawer {...props({ mode: 'cycle', cycler: { id: 'x', action: 'variant', count: 1, active: 0 } })} />);
    await m.flush();
    assert.ok(isDisabled(button(m.root, 'Next variant')));
    assert.match(screenText(m.root), /Keep the original/);
    m.unmount();
    m = await mount(<LiveVariantsDrawer {...props({ mode: 'cycle', cycler: null, busy: false })} />);
    await m.flush();
    assert.match(screenText(m.root), /No live variants on this page yet/);
    assert.ok(hasButton(m.root, 'rescan'));
  } finally { m?.unmount(); }
});
