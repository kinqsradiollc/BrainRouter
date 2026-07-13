import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { safeName, isPathWithinRoot, mdSafe, isAllowedLauncher, hasShellMeta } from './uitestSafety.js';

test('safeName strips directory traversal + absolute paths to a single segment', () => {
  assert.equal(safeName('../../etc/passwd'), 'passwd');
  assert.equal(safeName('../secret'), 'secret');
  assert.equal(safeName('/abs/path/evil'), 'evil');
  assert.equal(safeName('a/b/c'), 'c');
  // no `.` or `/` survive — can't reconstruct a traversal token
  assert.ok(!/[./\\]/.test(safeName('..')), '".." yields no path chars');
});

test('safeName keeps a friendly slug, trims, caps length, and always non-empty', () => {
  assert.equal(safeName('My Login Flow!'), 'My-Login-Flow');
  assert.equal(safeName('---edge---'), 'edge');
  assert.equal(safeName(''), 'flow');
  assert.equal(safeName('', 'shot'), 'shot');
  assert.equal(safeName('日本語'), 'flow', 'non-latin collapses to the fallback');
  assert.ok(safeName('x'.repeat(200)).length <= 48);
});

test('mdSafe HTML-encodes injection chars and collapses newlines for run reports', () => {
  assert.equal(mdSafe('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(mdSafe('a & b "c" \'d\''), 'a &amp; b &quot;c&quot; &#39;d&#39;');
  assert.equal(mdSafe('line1\nline2\r\nline3'), 'line1 line2 line3', 'newlines collapsed');
  assert.equal(mdSafe(undefined), '');
  assert.ok(!/[<>]/.test(mdSafe('<img src=x onerror=alert(1)>')), 'no raw angle brackets survive');
  assert.ok(mdSafe('x'.repeat(9999)).length <= 500);
});

test('isAllowedLauncher permits known dev-server runners and rejects arbitrary exes', () => {
  for (const ok of ['node', 'npm', 'NPM', 'npm.cmd', 'npx', 'pnpm', 'yarn', 'bun', 'vite', 'deno', 'C:/x/npm.cmd']) {
    assert.equal(isAllowedLauncher(ok), true, ok);
  }
  for (const bad of ['calc', 'calc.exe', 'bash', 'cmd', 'powershell', '/bin/sh', 'curl', 'python', '']) {
    assert.equal(isAllowedLauncher(bad), false, bad);
  }
});

test('hasShellMeta flags shell metacharacters in launch args', () => {
  for (const bad of ['&& calc', '| tee', '; rm', '$(x)', '`x`', '> f', '<f', 'a\nb']) {
    assert.equal(hasShellMeta(bad), true, bad);
  }
  for (const ok of ['run', 'dev', '--', '--port', '5180', '--prefix', 'D:/repo/app', '--strictPort']) {
    assert.equal(hasShellMeta(ok), false, ok);
  }
});

test('isPathWithinRoot accepts in-tree paths and rejects escapes', () => {
  const root = path.resolve('/repo');
  assert.equal(isPathWithinRoot(root, 'src/app.ts'), true);
  assert.equal(isPathWithinRoot(root, './a/b.tsx'), true);
  assert.equal(isPathWithinRoot(root, ''), true, 'root itself');
  assert.equal(isPathWithinRoot(root, '../../etc/passwd.ts'), false);
  assert.equal(isPathWithinRoot(root, '../repo-sibling/x.ts'), false);
  assert.equal(isPathWithinRoot(root, path.resolve('/etc/passwd')), false, 'absolute escape');
});
