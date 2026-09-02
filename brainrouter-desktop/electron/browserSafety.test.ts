import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { safeName, isPathWithinRoot, mdSafe, isAllowedLauncher, hasShellMeta, hasDangerousFlag, hasExecSubcommand, agentDownloadDir, workspaceRelativeDownloadPath, isCredentialField, browserPrintDir } from './browserSafety.js';

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

test('isAllowedLauncher permits package/task runners and rejects code-eval runtimes + arbitrary exes', () => {
  for (const ok of ['npm', 'NPM', 'npm.cmd', 'pnpm', 'yarn', 'vite', 'nx', 'turbo', 'C:/x/npm.cmd']) {
    assert.equal(isAllowedLauncher(ok), true, ok);
  }
  // node/deno/bun (node -e …) AND npx (npx <arbitrary-pkg>) are code-execution vectors — rejected.
  for (const bad of ['node', 'deno', 'bun', 'npx', 'calc', 'calc.exe', 'bash', 'cmd', 'powershell', '/bin/sh', 'curl', 'python', '']) {
    assert.equal(isAllowedLauncher(bad), false, bad);
  }
});

test('hasExecSubcommand flags npm/pnpm/yarn subcommands that run an arbitrary package', () => {
  const bad: Array<[string, string[]]> = [['npm', ['exec', 'x']], ['npm', ['x', 'y']], ['pnpm', ['dlx', 'p']], ['yarn', ['dlx', 'p']], ['npm', ['create', 'app']], ['npm', ['install', 'p']], ['npm', ['--silent', 'exec', 'p']]];
  for (const [exe, args] of bad) {
    assert.equal(hasExecSubcommand(exe, args), true, `${exe} ${args.join(' ')}`);
  }
  // Legit project-script runs are fine.
  const ok: Array<[string, string[]]> = [['npm', ['run', 'dev']], ['npm', ['run', 'dev', '-w', 'dashboard']], ['yarn', ['start']], ['vite', ['app']], ['pnpm', ['run', 'build']]];
  for (const [exe, args] of ok) {
    assert.equal(hasExecSubcommand(exe, args), false, `${exe} ${args.join(' ')}`);
  }
});

test('hasDangerousFlag flags inline code-execution flags', () => {
  for (const bad of ['-e', '--eval', '-p', '--print', '-r', '--require', '-c', '--call', '--eval=1+1', '--print=x', '-E'.toLowerCase()]) {
    assert.equal(hasDangerousFlag(bad), true, bad);
  }
  for (const ok of ['run', 'dev', 'vite', '--', '--port', '5199', 'brainrouter-desktop', '--strictPort', '-w', '--experimental']) {
    assert.equal(hasDangerousFlag(ok), false, ok);
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

// ADR-055 P8 — the agent-download inbox helpers.
test('agentDownloadDir + workspaceRelativeDownloadPath', () => {
  assert.equal(agentDownloadDir('/ws'), '/ws/.brainrouter/browser/downloads');
  assert.equal(workspaceRelativeDownloadPath('/ws/.brainrouter/browser/downloads/a.pdf', '/ws'), '.brainrouter/browser/downloads/a.pdf');
  // Outside the workspace (a human download) → null.
  assert.equal(workspaceRelativeDownloadPath('/Users/alice/Downloads/a.pdf', '/ws'), null);
  assert.equal(workspaceRelativeDownloadPath('', '/ws'), null);
});

// ADR-055 P2 (fix) — the coordinate-click credential-field predicate: form
// controls only, so ordinary buttons/links are never refused.
test('isCredentialField flags only sensitive FORM controls, never plain elements', () => {
  // The over-refusal the review found: a plain control whose id/label contains a
  // "sensitive" word must NOT be treated as a credential field.
  assert.equal(isCredentialField({ tag: 'BUTTON', identity: 'session-end' }), false, 'a Log out button is not a credential field');
  assert.equal(isCredentialField({ tag: 'A', identity: 'session settings' }), false, 'a nav link is not a credential field');
  assert.equal(isCredentialField({ tag: 'DIV', identity: 'token display' }), false);
  assert.equal(isCredentialField({ tag: 'BUTTON', identity: 'refresh-token-btn' }), false);

  // Real credential fields (form controls) are still flagged.
  assert.equal(isCredentialField({ tag: 'INPUT', type: 'password' }), true);
  assert.equal(isCredentialField({ tag: 'INPUT', type: 'hidden' }), true);
  assert.equal(isCredentialField({ tag: 'INPUT', type: 'text', autocomplete: 'current-password' }), true);
  assert.equal(isCredentialField({ tag: 'INPUT', type: 'text', autocomplete: 'one-time-code' }), true);
  assert.equal(isCredentialField({ tag: 'INPUT', type: 'text', identity: 'session_token' }), true);
  assert.equal(isCredentialField({ tag: 'TEXTAREA', identity: 'api-key' }), true);
  assert.equal(isCredentialField({ tag: 'INPUT', identity: 'cvv' }), true);

  // Ordinary form controls (no sensitive marker) are NOT flagged.
  assert.equal(isCredentialField({ tag: 'INPUT', type: 'text', identity: 'email' }), false);
  assert.equal(isCredentialField({ tag: 'INPUT', type: 'search', identity: 'query' }), false);
  assert.equal(isCredentialField({ tag: 'SELECT', identity: 'country' }), false);
  // "session" as a substring of another word must not trip the word-bounded regex.
  assert.equal(isCredentialField({ tag: 'INPUT', type: 'text', identity: 'obsession' }), false);
});

// ADR-055 P10 — Save as PDF writes inside the workspace.
test('browserPrintDir is a workspace path under .brainrouter', () => {
  assert.equal(browserPrintDir('/ws'), '/ws/.brainrouter/browser/prints');
  assert.equal(workspaceRelativeDownloadPath('/ws/.brainrouter/browser/prints/page.pdf', '/ws'), '.brainrouter/browser/prints/page.pdf');
});
