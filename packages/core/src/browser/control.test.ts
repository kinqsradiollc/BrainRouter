import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BrowserControlBackend,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  browserUseAvailableFor,
  createBrowserControlBridge,
  normalizeBrowserControlResult,
  parseBrowserControlCommand,
  type BrowserControlRequestMessage,
  type BrowserControlTransport,
} from './control.js';

class FakeTransport implements BrowserControlTransport {
  readonly sent: unknown[] = [];
  postMessage(message: unknown): void { this.sent.push(message); }
}

test('browser bridge emits the versioned utility-host request and correlates the response', async () => {
  const transport = new FakeTransport();
  const bridge = createBrowserControlBridge(transport, { timeoutMs: 1000, idPrefix: 'test' });
  const pending = bridge.request({ kind: 'tabs.list' });
  const request = transport.sent[0] as BrowserControlRequestMessage;
  assert.deepEqual(request, {
    kind: 'browser-command-request',
    version: BROWSER_CONTROL_PROTOCOL_VERSION,
    id: 'test_1',
    command: { kind: 'tabs.list' },
  });

  assert.equal(bridge.handleMessage({
    kind: 'browser-command-response',
    version: BROWSER_CONTROL_PROTOCOL_VERSION,
    id: request.id,
    ok: true,
    result: { ok: true, kind: 'tabs.list', durationMs: 3, data: { tabs: [] } },
  }), true);
  assert.deepEqual(await pending, { ok: true, kind: 'tabs.list', durationMs: 3, data: { tabs: [] } });
  bridge.dispose();
});

test('browser bridge aborts locally and emits a correlated cancel message', async () => {
  const transport = new FakeTransport();
  const bridge = createBrowserControlBridge(transport, { timeoutMs: 1000, idPrefix: 'abort' });
  const controller = new AbortController();
  const pending = bridge.request({ kind: 'page.reload' }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /aborted/i);
  assert.deepEqual(transport.sent[1], {
    kind: 'browser-command-cancel',
    version: BROWSER_CONTROL_PROTOCOL_VERSION,
    id: 'abort_1',
  });
  bridge.dispose();
});

test('browser bridge rejects malformed or failed responses without leaking transport details', async () => {
  const transport = new FakeTransport();
  const bridge = createBrowserControlBridge(transport, { timeoutMs: 1000, idPrefix: 'fail' });
  const pending = bridge.request({ kind: 'page.stop' });
  const request = transport.sent[0] as BrowserControlRequestMessage;
  bridge.handleMessage({
    kind: 'browser-command-response',
    version: BROWSER_CONTROL_PROTOCOL_VERSION,
    id: request.id,
    ok: false,
    error: { code: 'closed', message: 'Browser window closed.' },
  });
  await assert.rejects(pending, /Browser window closed/);
  bridge.dispose();
});

test('browser commands validate safe URLs and bound interaction payloads', () => {
  assert.deepEqual(parseBrowserControlCommand({ kind: 'tabs.open', url: 'https://example.com/path', activate: true }), {
    kind: 'tabs.open', url: 'https://example.com/path', activate: true,
  });
  assert.throws(() => parseBrowserControlCommand({ kind: 'page.navigate', url: 'javascript:alert(1)' }), /unsafe|http/i);
  assert.throws(() => parseBrowserControlCommand({ kind: 'page.navigate', url: 'https://user:pass@example.com' }), /credentials/i);
  assert.throws(() => parseBrowserControlCommand({ kind: 'page.type', ref: 'r1', text: 'x'.repeat(20_001) }), /text/i);
  assert.throws(() => parseBrowserControlCommand({ kind: 'page.scroll', deltaY: 1_000_000 }), /deltaY/i);
  assert.throws(() => parseBrowserControlCommand({ kind: 'page.select', ref: 'r1', values: Array.from({ length: 21 }, (_, i) => String(i)) }), /values/i);
});

test('browser file uploads accept only a bounded list of canonical workspace-relative paths', () => {
  assert.deepEqual(parseBrowserControlCommand({
    kind: 'page.setFiles',
    ref: 'upload-ref',
    pageRevision: 4,
    files: ['./fixtures/report.pdf', 'images\\photo.png'],
  }), {
    kind: 'page.setFiles',
    ref: 'upload-ref',
    pageRevision: 4,
    files: ['fixtures/report.pdf', 'images/photo.png'],
  });

  for (const file of ['/etc/passwd', '../secret.txt', 'fixtures/../../secret.txt', 'C:\\Windows\\win.ini', '\\\\server\\share\\file.txt', 'file:///tmp/file.txt']) {
    assert.throws(() => parseBrowserControlCommand({ kind: 'page.setFiles', ref: 'r1', files: [file] }), /workspace|traverse|relative/i, file);
  }
  assert.throws(() => parseBrowserControlCommand({ kind: 'page.setFiles', ref: 'r1', files: [] }), /between 1 and 20/i);
  assert.throws(() => parseBrowserControlCommand({ kind: 'page.setFiles', ref: 'r1', files: Array.from({ length: 21 }, (_, i) => `file-${i}.txt`) }), /between 1 and 20/i);
  assert.throws(() => parseBrowserControlCommand({ kind: 'page.setFiles', ref: 'r1', files: ['x'.repeat(4_097)] }), /4096/i);
  assert.throws(() => parseBrowserControlCommand({ kind: 'page.setFiles', files: ['fixture.txt'] }), /ref or testId/i);
});

test('browser file-upload results never echo local paths or secret-bearing fields', () => {
  const result = normalizeBrowserControlResult({
    ok: true,
    kind: 'page.setFiles',
    durationMs: 2,
    data: {
      accepted: true,
      fileCount: 2,
      files: ['private/customer-list.csv'],
      absolutePaths: ['/Users/person/work/private/customer-list.csv'],
      password: 'do-not-leak',
      pageValue: 'C:\\sensitive\\local.txt',
    },
  }, 'page.setFiles');
  assert.deepEqual(result, {
    ok: true,
    kind: 'page.setFiles',
    durationMs: 2,
    data: { accepted: true, fileCount: 2 },
  });
  const encoded = JSON.stringify(result);
  assert.equal(encoded.includes('customer-list'), false);
  assert.equal(encoded.includes('do-not-leak'), false);
  assert.equal(encoded.includes('sensitive'), false);
});

test('browser results are bounded and redact secret-bearing fields', () => {
  const result = normalizeBrowserControlResult({
    ok: true,
    kind: 'page.network',
    durationMs: 2,
    data: {
      authorization: 'Bearer should-not-leak',
      headers: { cookie: 'sid=secret', accept: 'text/html' },
      headerList: [{ name: 'Authorization', value: 'Bearer list-secret' }],
      accessToken: 'camel-secret',
      password: 'hunter2',
      passwordNode: { type: 'password', value: 'field-secret', label: 'Password' },
      hiddenNode: { type: 'hidden', value: 'csrf-secret', name: 'csrf' },
      cssHiddenNode: { type: 'text', visible: false, value: 'css-hidden-secret', text: 'hidden-copy' },
      screenshotBase64: 'binary-secret',
      url: 'https://example.com/callback?code=oauth-secret&view=normal',
      consoleText: 'Authorization: Bearer inline-secret',
      rows: Array.from({ length: 500 }, (_, i) => ({ url: `https://example.com/${i}` })),
      huge: 'x'.repeat(100_000),
    },
  }, 'page.network');
  assert.equal(result.ok, true);
  const encoded = JSON.stringify(result);
  assert.ok(encoded.length <= 70_000, `bounded output, got ${encoded.length}`);
  assert.equal(encoded.includes('should-not-leak'), false);
  assert.equal(encoded.includes('sid=secret'), false);
  assert.equal(encoded.includes('hunter2'), false);
  assert.equal(encoded.includes('list-secret'), false);
  assert.equal(encoded.includes('camel-secret'), false);
  assert.equal(encoded.includes('field-secret'), false);
  assert.equal(encoded.includes('csrf-secret'), false);
  assert.equal(encoded.includes('css-hidden-secret'), false);
  assert.equal(encoded.includes('hidden-copy'), false);
  assert.equal(encoded.includes('binary-secret'), false);
  assert.equal(encoded.includes('oauth-secret'), false);
  assert.equal(encoded.includes('inline-secret'), false);
  assert.match(encoded, /\[REDACTED\]/);
});

test('browser backend is deterministically unavailable without an injected desktop port', async () => {
  const backend = new BrowserControlBackend(undefined);
  const result = await backend.perform({ kind: 'tabs.list' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'unavailable');
});

test('browser-use availability is restricted to an interactive depth-zero local desktop agent', () => {
  const base = { hasPort: true, silent: false, depth: 0, tier: 'chat', remoteBrain: false };
  assert.equal(browserUseAvailableFor(base), true);
  assert.equal(browserUseAvailableFor({ ...base, hasPort: false }), false);
  assert.equal(browserUseAvailableFor({ ...base, silent: true }), false);
  assert.equal(browserUseAvailableFor({ ...base, depth: 1 }), false);
  assert.equal(browserUseAvailableFor({ ...base, tier: 'worker' }), false);
  assert.equal(browserUseAvailableFor({ ...base, remoteBrain: true }), false);
});
