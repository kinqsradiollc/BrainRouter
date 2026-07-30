import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBrowserHost } from './browserHost.js';
import type { DevServerRegistry } from './devServerRegistry.js';

function tmpDir(prefix = 'browser-host-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// These tests exercise extract/runReport (never ensureApp), so a no-op registry
// stub is enough to satisfy the createBrowserHost signature.
function fakeRegistry(): DevServerRegistry {
  return {
    list: () => [],
    start: async (name: string) => ({ name, exe: 'npm', args: [], port: 0, url: '', status: 'stopped' as const, pid: null, startedAt: null }),
    stop: () => ({ ok: false }),
    get: () => undefined,
    tail: () => [],
    addConfig: () => ({ ok: true }),
    disposeAll: () => {},
  };
}
const TSX = 'export const A = () => <div data-testid="x">a</div>;\n';

test('extract({only}) reads in-tree files but rejects a `..` traversal escape (CWE-22)', () => {
  const root = tmpDir();
  const outside = path.join(root, '..', `secret-${path.basename(root)}.tsx`);
  try {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'app.tsx'), TSX, 'utf8');
    fs.writeFileSync(outside, TSX, 'utf8');
    const host = createBrowserHost(root, fakeRegistry());
    assert.equal(host.extract({ only: ['src/app.tsx'], broad: true }).fileCount, 1, 'in-tree file is read');
    assert.equal(host.extract({ only: [`../${path.basename(outside)}`], broad: true }).fileCount, 0, 'traversal path rejected');
    host.dispose();
  } finally {
    fs.rmSync(outside, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('extract({only}) rejects a symlink that escapes the workspace (CWE-22 symlink)', (t) => {
  const root = tmpDir();
  const outsideDir = tmpDir('browser-outside-');
  try {
    fs.writeFileSync(path.join(outsideDir, 'evil.tsx'), TSX, 'utf8');
    try {
      fs.symlinkSync(outsideDir, path.join(root, 'linkdir'), 'junction');
    } catch {
      t.skip('no symlink privilege on this host');
      return;
    }
    const host = createBrowserHost(root, fakeRegistry());
    // lexically inside root, but the real path is outside → must be rejected.
    assert.equal(host.extract({ only: ['linkdir/evil.tsx'], broad: true }).fileCount, 0, 'symlink escape rejected');
    host.dispose();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('runReport writes a markdown report and HTML-escapes an injected title (CWE-80)', () => {
  const root = tmpDir();
  try {
    const host = createBrowserHost(root, fakeRegistry());
    const out = host.runReport({
      story: { title: '<script>alert(1)</script>', id: 'inj' },
      baseUrl: 'http://localhost:5174',
      results: [{ i: 1, action: 'tap', target: 'login-submit', ok: true }],
      screenshots: [],
    });
    assert.ok(out.reportPath, 'a report path is returned');
    const md = fs.readFileSync(path.join(root, out.reportPath!), 'utf8');
    assert.ok(md.includes('&lt;script&gt;'), 'title is HTML-encoded');
    assert.ok(!md.includes('<script>'), 'no raw <script> survives');
    host.dispose();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('screenshots and reports reject symlinked artifact directories', { skip: process.platform === 'win32' }, (t) => {
  for (const leaf of ['screenshots', 'reports']) {
    const root = tmpDir();
    const outside = tmpDir();
    try {
      const parent = path.join(root, '.brainrouter', 'ui-tests');
      fs.mkdirSync(parent, { recursive: true });
      try { fs.symlinkSync(outside, path.join(parent, leaf), 'dir'); }
      catch {
        t.skip('no symlink privilege on this host');
        return;
      }
      const host = createBrowserHost(root, fakeRegistry());
      const png = `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`;
      const out = leaf === 'screenshots'
        ? host.saveScreenshot({ dataUrl: png, name: 'escape' })
        : host.runReport({ story: { id: 'escape', title: 'Escape' }, results: [], screenshots: [] });
      assert.ok(out.error, `${leaf} write is refused`);
      assert.deepEqual(fs.readdirSync(outside), [], `${leaf} never receives an escaped artifact`);
      host.dispose();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }
});
