import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPostEditCommand, formatPostEditDiagnostics, runPostEditCheck } from '../runtime/postEditCheck.js';

test('CLI-18 buildPostEditCommand: empty → null; {file} substituted (quoted); literal passthrough', () => {
  assert.equal(buildPostEditCommand('', 'a.ts'), null);
  assert.equal(buildPostEditCommand('   ', 'a.ts'), null);
  assert.equal(buildPostEditCommand('ruff check {file}', '/w/a.py'), 'ruff check "/w/a.py"');
  assert.equal(buildPostEditCommand('tsc --noEmit', '/w/a.ts'), 'tsc --noEmit'); // project-wide, no {file}
});

test('CLI-18 formatPostEditDiagnostics: empty stays empty; non-empty is a labeled, capped block', () => {
  assert.equal(formatPostEditDiagnostics(''), '');
  const out = formatPostEditDiagnostics('a.ts(3,1): error TS2322: Type X is not assignable to Y');
  assert.match(out, /Post-edit check failed/);
  assert.match(out, /TS2322/);
  assert.ok(formatPostEditDiagnostics('x'.repeat(9000)).length < 5000, 'capped');
});

test('CLI-18 runPostEditCheck: off when no template; passing checker → no suffix; failing → diagnostics', () => {
  // off
  assert.equal(runPostEditCheck({ template: '', file: 'a.ts', cwd: '/w' }), '');
  // passing checker (exit 0) → empty suffix
  const pass = runPostEditCheck({ template: 'tsc --noEmit', file: 'a.ts', cwd: '/w', exec: () => ({ code: 0, output: 'all good' }) });
  assert.equal(pass, '');
  // failing checker → diagnostics block fed back
  const fail = runPostEditCheck({
    template: 'tsc --noEmit', file: 'a.ts', cwd: '/w',
    exec: () => ({ code: 2, output: 'a.ts(3,1): error TS2322: nope' }),
  });
  assert.match(fail, /Post-edit check failed/);
  assert.match(fail, /TS2322/);
});

test('CLI-18 runPostEditCheck: a throwing exec is non-fatal (returns empty)', () => {
  const r = runPostEditCheck({
    template: 'tsc', file: 'a.ts', cwd: '/w',
    exec: () => { throw new Error('boom'); },
  });
  assert.equal(r, '');
});
