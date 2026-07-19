import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isAllowedArtifactWebviewSrc, isAllowedWebviewSrc, hardenWebviewPreferences, isMetadataOrLinkLocalAddress, isPrivateOrLocalAddress } from './webviewPolicy.js';

test('isAllowedWebviewSrc: allows self-contained data:text/html', () => {
  assert.equal(isAllowedWebviewSrc('data:text/html,<h1>hi</h1>', '/repo'), true);
  assert.equal(isAllowedWebviewSrc('data:text/html;charset=utf-8,<h1>hi</h1>', '/repo'), true);
});

test('isAllowedWebviewSrc: allows ANY http(s) origin (general browsing)', () => {
  assert.equal(isAllowedWebviewSrc('https://example.com/', '/repo'), true);
  assert.equal(isAllowedWebviewSrc('https://news.ycombinator.com/item?id=1', '/repo'), true);
  assert.equal(isAllowedWebviewSrc('http://192.168.1.5:5173/', '/repo'), true, 'LAN ip allowed');
  assert.equal(isAllowedWebviewSrc('http://localhost:5173/', '/repo'), true, 'loopback still allowed');
  assert.equal(isAllowedWebviewSrc('http://127.0.0.1:5174/todos', '/repo'), true);
  assert.equal(isAllowedWebviewSrc('http://[::1]:5173/', '/repo'), true);
});

test('artifact webviews stay local and cannot become a renderer-owned remote browser', () => {
  assert.equal(isAllowedArtifactWebviewSrc('data:text/html,<h1>preview</h1>', '/repo'), true);
  assert.equal(isAllowedArtifactWebviewSrc('https://example.com/', '/repo'), false);
});

test('artifact webviews canonicalize prototype files and reject symlink escapes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-artifact-policy-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-artifact-outside-'));
  try {
    fs.mkdirSync(path.join(root, 'proto'));
    const safe = path.join(root, 'proto', '12345678.html');
    fs.writeFileSync(safe, '<h1>safe</h1>');
    assert.equal(isAllowedArtifactWebviewSrc(pathToFileURL(safe).href, root), true);
    const secret = path.join(outside, '87654321.html');
    fs.writeFileSync(secret, 'outside');
    const escape = path.join(root, 'proto', 'abcdef12.html');
    fs.symlinkSync(secret, escape);
    assert.equal(isAllowedArtifactWebviewSrc(pathToFileURL(escape).href, root), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('isAllowedWebviewSrc: refuses non-html data, empty, and dangerous schemes', () => {
  assert.equal(isAllowedWebviewSrc('data:image/svg+xml,<svg/>', '/repo'), false, 'non-html data refused');
  assert.equal(isAllowedWebviewSrc('', '/repo'), false);
  assert.equal(isAllowedWebviewSrc('javascript:alert(1)', '/repo'), false);
  assert.equal(isAllowedWebviewSrc('about:blank', '/repo'), false);
});

test('isAllowedWebviewSrc: refuses link-local / cloud-metadata (SSRF) even in general mode', () => {
  assert.equal(isAllowedWebviewSrc('http://169.254.169.254/latest/meta-data/', '/repo'), false, 'AWS/GCP/Azure metadata refused');
  assert.equal(isAllowedWebviewSrc('http://169.254.0.1/', '/repo'), false, 'IPv4 link-local refused');
  assert.equal(isAllowedWebviewSrc('http://[fd00:ec2::254]/', '/repo'), false, 'EC2 IPv6 metadata refused');
  assert.equal(isAllowedWebviewSrc('http://[fe80::1]/', '/repo'), false, 'IPv6 link-local refused');
  // ...but ordinary public + loopback + LAN stay reachable (it is a real browser)
  assert.equal(isAllowedWebviewSrc('https://example.com/', '/repo'), true);
  assert.equal(isAllowedWebviewSrc('http://192.168.1.5/', '/repo'), true);
});

test('resolved destination policy catches IPv4-mapped and the full IPv6 link-local prefix', () => {
  assert.equal(isMetadataOrLinkLocalAddress('::ffff:169.254.169.254'), true);
  assert.equal(isMetadataOrLinkLocalAddress('fe80::1'), true);
  assert.equal(isMetadataOrLinkLocalAddress('febf::1234'), true);
  assert.equal(isMetadataOrLinkLocalAddress('fd00:ec2::254'), true);
  assert.equal(isMetadataOrLinkLocalAddress('192.168.1.5'), false);
  assert.equal(isMetadataOrLinkLocalAddress('2606:4700:4700::1111'), false);
});

test('agent-only private-address policy covers loopback, RFC1918, CGNAT, and IPv6 ULA', () => {
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.5', '100.64.0.1', 'fc00::1', 'fd12::1', 'fe80::1']) {
    assert.equal(isPrivateOrLocalAddress(address), true, address);
  }
  for (const address of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111']) {
    assert.equal(isPrivateOrLocalAddress(address), false, address);
  }
});

test('isAllowedWebviewSrc: allows an authorized prototype file inside the workspace', () => {
  assert.equal(isAllowedWebviewSrc('file:///repo/proto/12345678.html', '/repo'), true);
});

test('isAllowedWebviewSrc: refuses files outside the workspace or with traversal or wrong type', () => {
  assert.equal(isAllowedWebviewSrc('file:///etc/passwd', '/repo'), false);
  assert.equal(isAllowedWebviewSrc('file:///other/proto/x.html', '/repo'), false);
  assert.equal(isAllowedWebviewSrc('file:///repo/src/secret.ts', '/repo'), false, 'non-proto file refused');
});

test('hardenWebviewPreferences: strips preload + node, forces sandbox/isolation', () => {
  const prefs: Record<string, unknown> = { preload: '/x/evil.js', nodeIntegration: true, sandbox: false, contextIsolation: false };
  hardenWebviewPreferences(prefs);
  assert.ok(!('preload' in prefs) || prefs.preload === undefined);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.webSecurity, true);
});
