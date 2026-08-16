import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { BlockEditor, type BlockEditorProps } from './BlockEditor.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function props(onFocus: () => Promise<boolean>): BlockEditorProps {
  return {
    blockId: 'block-1',
    text: 'server copy',
    kind: 'paragraph',
    level: null,
    readOnly: false,
    placeholder: 'Write',
    refLabels: {},
    onOpenRef: () => {},
    onText: () => {},
    onIntent: () => {},
    onFocus,
    onBlur: () => {},
    onInputRule: async () => null,
    onRuleTransform: () => {},
    searchSlash: async () => [],
    onSlashPlan: () => {},
    searchMentions: async () => [],
    focusRequest: null,
    onPageHistory: () => {},
  };
}

function textbox(renderer: ReactTestRenderer) {
  return renderer.root.findByProps({ role: 'textbox' });
}

test('the editor stays read-only while a lease is pending and only a grant enables it', async (t) => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalAct = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { clearTimeout: () => {}, setTimeout: () => 1, getSelection: () => null },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { addEventListener: () => {}, removeEventListener: () => {} },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  t.after(() => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = originalAct;
  });

  const grant = deferred<boolean>();
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<BlockEditor {...props(() => grant.promise)} />); });
  assert.equal(textbox(renderer).props.contentEditable, false, 'idle editor was writable');

  await act(async () => { textbox(renderer).props.onFocus(); });
  assert.equal(textbox(renderer).props.contentEditable, false, 'pending editor was writable');
  assert.equal(textbox(renderer).props['aria-busy'], true);

  await act(async () => { grant.resolve(true); await grant.promise; });
  assert.equal(textbox(renderer).props.contentEditable, true, 'granted editor stayed read-only');

  await act(async () => { renderer.unmount(); });
});

test('a refused lease never makes the editor writable', async (t) => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalAct = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { clearTimeout: () => {}, setTimeout: () => 1, getSelection: () => null },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { addEventListener: () => {}, removeEventListener: () => {} },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  t.after(() => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = originalAct;
  });

  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<BlockEditor {...props(async () => false)} />); });
  await act(async () => { textbox(renderer).props.onFocus(); });
  assert.equal(textbox(renderer).props.contentEditable, false);
  assert.equal(textbox(renderer).props['aria-busy'], false);
  await act(async () => { renderer.unmount(); });
});
