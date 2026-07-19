/**
 * Guards for the extension-tool audit security fixes:
 *  - fetch_url SSRF: isBlockedAddress rejects loopback/private/link-local/metadata.
 *  - write_file/apply_patch: resolveWorkspacePath rejects writing through a
 *    symlink whose target escapes the workspace root.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isBlockedAddress } from '../websearch/crawler.js';
import { resolveWorkspacePath } from '../agent/fs/workspaceFs.js';

test('isBlockedAddress blocks non-public addresses (SSRF guard)', () => {
  for (const ip of [
    '127.0.0.1', '127.5.5.5', '0.0.0.0',
    '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1',      // CGNAT
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1',
    'not-an-ip',       // fail closed
  ]) {
    assert.equal(isBlockedAddress(ip), true, `${ip} should be blocked`);
  }
});

test('isBlockedAddress allows public addresses', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1', '2606:4700:4700::1111']) {
    assert.equal(isBlockedAddress(ip), false, `${ip} should be allowed`);
  }
});

function tmpWorkspace(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brs-ws-fix-')));
}

test('resolveWorkspacePath(forWrite) rejects a symlink final component that escapes root', { skip: process.platform === 'win32' }, () => {
  const ws = tmpWorkspace();
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brs-outside-')));
  try {
    // a live symlink workspace/evil -> <outside>/secret
    fs.writeFileSync(path.join(outside, 'secret'), 'x');
    fs.symlinkSync(path.join(outside, 'secret'), path.join(ws, 'evil'));
    assert.throws(() => resolveWorkspacePath(ws, 'evil', { forWrite: true }), /escapes workspace root/);
    // a DANGLING symlink workspace/evil2 -> <outside>/nope must also be rejected
    fs.symlinkSync(path.join(outside, 'nope'), path.join(ws, 'evil2'));
    assert.throws(() => resolveWorkspacePath(ws, 'evil2', { forWrite: true }), /escapes workspace root/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('resolveWorkspacePath(forWrite) allows in-workspace symlinks and normal new files', { skip: process.platform === 'win32' }, () => {
  const ws = tmpWorkspace();
  try {
    fs.writeFileSync(path.join(ws, 'real.txt'), 'x');
    fs.symlinkSync(path.join(ws, 'real.txt'), path.join(ws, 'inside-link'));
    assert.equal(resolveWorkspacePath(ws, 'inside-link', { forWrite: true }), path.join(ws, 'inside-link'));
    // a brand-new (non-existent) target is fine
    assert.equal(resolveWorkspacePath(ws, 'new-file.txt', { forWrite: true }), path.join(ws, 'new-file.txt'));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
