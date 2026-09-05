/**
 * ADR-056 D-A5 — the Diagrams panel renders the list with checks and
 * evidence, opens a diagram on click, shows the receipt, offers exports only
 * when an artifact exists, seals the frame with a no-network CSP, extracts a
 * standalone SVG, and routes source clicks to open-file / Atlas.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { DiagramsPanel, extractDiagramSvg, sealDiagramHtml, evidenceLabel } from './DiagramsPanel.js';
import { devDiagramList, devDiagramRead, devDiagramDelta } from '../../devBridge/diagrams.js';
import { mount, press, screenText, hasButton, isDisabled, button } from '../../testing/reactHarness.js';

test('D-A5 the list shows every diagram with kind, checks, and evidence; a click opens it', async () => {
  const opened: string[] = [];
  const m = await mount(React.createElement(DiagramsPanel, { diagrams: devDiagramList(), view: null, delta: null, onLoad: () => {}, onOpen: (s) => opened.push(s), onDelta: () => {} }));
  const text = screenText(m.root);
  assert.match(text, /Checkout platform/); assert.match(text, /architecture/); assert.match(text, /9\/9/); assert.match(text, /mixed/);
  assert.match(text, /Job lifecycle/); assert.match(text, /spec only/);
  assert.match(text, /Select a diagram/);
  await press(m, 'Create order');
  assert.deepEqual(opened, ['create-order']);
});

test('D-A5 the detail shows the receipt, exports, delta, and sources with open/Atlas actions', async () => {
  const files: string[] = [], atlas: string[] = [], deltas: string[] = [];
  const view = devDiagramRead('checkout-platform')!;
  const m = await mount(React.createElement(DiagramsPanel, {
    diagrams: devDiagramList(), view, delta: devDiagramDelta('checkout-platform'),
    onLoad: () => {}, onOpen: () => {}, onDelta: (s) => deltas.push(s), onOpenFile: (p) => files.push(p), onShowInAtlas: (p) => atlas.push(p),
  }));
  const text = screenText(m.root);
  assert.match(text, /checks 9\/9/); assert.match(text, /partly verified/); assert.match(text, /brainrouter-diagram@1\.0\.0/);
  assert.match(text, /packages\/core\/src\/review\/service\.ts:1-40/);
  assert.ok(hasButton(m.root, 'Export SVG') && !isDisabled(button(m.root, 'Export SVG')));
  await press(m, 'Delta vs HEAD');
  assert.deepEqual(deltas, ['checkout-platform']);
  const after = screenText(m.root);
  assert.match(after, /1 added · 0 removed/); assert.match(after, /components\/cache/); assert.match(after, /label: "HTTPS JSON" → "HTTPS JSON \(v2\)"/);
  await press(m, 'Open packages/core/src/review/service.ts');
  assert.deepEqual(files, ['packages/core/src/review/service.ts']);
  await press(m, 'Focus packages/core/src/review/service.ts in Atlas');
  assert.deepEqual(atlas, ['packages/core/src/review/service.ts']);
});

test('D-A5 a spec-only diagram disables exports and says how to render it', async () => {
  const view = devDiagramRead('job-lifecycle')!;
  const m = await mount(React.createElement(DiagramsPanel, { diagrams: devDiagramList(), view, delta: null, onLoad: () => {}, onOpen: () => {}, onDelta: () => {} }));
  assert.match(screenText(m.root), /No receipt — the specification exists but nothing was delivered/);
  assert.ok(isDisabled(button(m.root, 'Export SVG')));
});

test('D-A5 the frame is sealed and the SVG stands alone with its tokens', () => {
  const html = devDiagramRead('checkout-platform')!.html!;
  const sealed = sealDiagramHtml(html);
  assert.ok(sealed.indexOf("default-src 'none'") < sealed.indexOf('<title>'), 'CSP injected at the top of head');
  const svg = extractDiagramSvg(html)!;
  assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'));
  assert.match(svg, /style="--dg-bg:#0b1020/);
  assert.match(svg, /<style>[^<]*\.dg-shape/);
  assert.equal(extractDiagramSvg('<html></html>'), null);
  assert.equal(evidenceLabel('verified'), 'verified against the repository');
});
