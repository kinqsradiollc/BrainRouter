import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BROWSER_BLANK_URL,
  BROWSER_PROTOCOL_VERSION,
  MAX_BROWSER_TABS,
  boundBrowserArray,
  boundBrowserText,
  clampBrowserSurface,
  isBrowserCommandRequest,
  isOpaqueBrowserRef,
  normalizeBrowserAddress,
  redactBrowserValue,
  type BrowserCommand,
  type BrowserDialogPrompt,
} from './protocol.js';

test('browser protocol is versioned and caps normal-browser resource growth', () => {
  assert.equal(BROWSER_PROTOCOL_VERSION, 1);
  assert.equal(MAX_BROWSER_TABS, 50);
  assert.match(BROWSER_BLANK_URL, /^data:text\/html/);
  assert.equal(boundBrowserArray(Array.from({ length: 900 }, (_, i) => i), 20).length, 20);
  assert.equal(boundBrowserText('x'.repeat(50_000), 80).length, 80);
});

test('normalizeBrowserAddress handles URLs, loopback hosts, hostnames and searches safely', () => {
  assert.equal(normalizeBrowserAddress('about:blank'), BROWSER_BLANK_URL);
  assert.equal(normalizeBrowserAddress('https://example.com/a'), 'https://example.com/a');
  assert.equal(normalizeBrowserAddress('localhost:5173/x'), 'http://localhost:5173/x');
  assert.equal(normalizeBrowserAddress('example.com'), 'https://example.com/');
  assert.equal(normalizeBrowserAddress('file:///tmp/prototype.html'), 'file:///tmp/prototype.html');
  assert.equal(normalizeBrowserAddress('hello browser'), 'https://www.google.com/search?q=hello%20browser');
  assert.equal(normalizeBrowserAddress('javascript:alert(1)'), 'https://www.google.com/search?q=javascript%3Aalert(1)');
  assert.equal(normalizeBrowserAddress(''), null);
});

test('surface bounds are integer, positive and clamped to the owning window', () => {
  assert.deepEqual(
    clampBrowserSurface({ x: -9, y: 10.9, width: 9_999, height: 400.2, visible: true }, { width: 1280, height: 800 }),
    { x: 0, y: 10, width: 1280, height: 400, visible: true },
  );
  assert.deepEqual(
    clampBrowserSurface({ x: 1200, y: 760, width: 300, height: 300, visible: false }, { width: 1280, height: 800 }),
    { x: 1200, y: 760, width: 80, height: 40, visible: false },
  );
});

test('opaque refs are page-revision bound and request envelopes are shape checked', () => {
  assert.equal(isOpaqueBrowserRef('br:tab_42:7:node_9'), true);
  assert.equal(isOpaqueBrowserRef('br:tab_42:8:node_9'), true);
  assert.equal(isOpaqueBrowserRef('document.querySelector("#secret")'), false);
  assert.equal(isBrowserCommandRequest({
    version: 1,
    id: 'request-1',
    tabId: 'tab_42',
    expectedRevision: 7,
    command: { op: 'click', ref: 'br:tab_42:7:node_9' },
  }), true);
  assert.equal(isBrowserCommandRequest({ version: 1, id: '', command: { op: 'eval', code: '1+1' } }), false);
  assert.equal(isBrowserCommandRequest({ version: 1, id: 'oversized', command: { op: 'type', text: 'x'.repeat(300_000) } }), false);
});

test('redaction removes password/token/cookie values recursively without mutating input', () => {
  const source = {
    title: 'Account',
    password: 'hunter2',
    nested: { authorization: 'Bearer abc', normal: 'safe' },
    rows: [{ cookie: 'sid=secret' }, { name: 'visible' }],
  };
  const clean = redactBrowserValue(source) as typeof source;
  assert.equal(clean.password, '[REDACTED]');
  assert.equal(clean.nested.authorization, '[REDACTED]');
  assert.equal(clean.nested.normal, 'safe');
  assert.equal(clean.rows[0].cookie, '[REDACTED]');
  assert.equal(source.password, 'hunter2');
});

test('page and certificate prompts use the bounded dialog response contract', () => {
  const prompt: BrowserCommand = {
    op: 'respond-dialog',
    promptId: 'prompt-1',
    accept: true,
    value: 'bounded response',
  };
  const certificate: BrowserDialogPrompt = {
    id: 'certificate-1',
    tabId: 'tab_1',
    kind: 'certificate',
    origin: 'https://expired.example',
    message: 'The certificate has expired.',
  };
  assert.equal(isBrowserCommandRequest({ version: 1, id: 'prompt-request', command: prompt }), true);
  assert.equal(certificate.kind, 'certificate');
  assert.equal((redactBrowserValue(prompt) as Record<string, unknown>).value, 'bounded response');
});
