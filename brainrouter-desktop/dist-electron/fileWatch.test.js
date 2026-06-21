import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldIgnoreWatchPath, startWorkspaceWatcher } from './fileWatch.js';
test('shouldIgnoreWatchPath: ignores VCS / dependency / build dirs', () => {
    for (const p of [
        '.git/index', '.git/refs/heads/main',
        'node_modules/react/index.js',
        'dist/main.js', 'dist-electron/host.js', 'build/x', 'coverage/lcov.info',
        '.next/cache/x', '.turbo/y', '.brainrouter/workflows/run.json',
        'src/node_modules/nested/dep.js', // nested too
    ]) {
        assert.equal(shouldIgnoreWatchPath(p), true, `should ignore ${p}`);
    }
});
test('shouldIgnoreWatchPath: ignores editor/VCS temp + lock files', () => {
    for (const p of ['.#foo.ts', 'src/.#bar', 'a.swp', 'b.tmp', 'pkg/.DS_Store', '4913', 'package-lock.lock']) {
        assert.equal(shouldIgnoreWatchPath(p), true, `should ignore ${p}`);
    }
});
test('shouldIgnoreWatchPath: passes real source edits through', () => {
    for (const p of ['src/App.tsx', 'package.json', 'README.md', 'app/components/Bar.tsx', 'lib/util.ts']) {
        assert.equal(shouldIgnoreWatchPath(p), false, `should NOT ignore ${p}`);
    }
});
test('shouldIgnoreWatchPath: empty/nullish is not ignored (treated as a real change)', () => {
    assert.equal(shouldIgnoreWatchPath(''), false);
    assert.equal(shouldIgnoreWatchPath(null), false);
    assert.equal(shouldIgnoreWatchPath(undefined), false);
});
test('startWorkspaceWatcher: returns a callable closer even for a bad path (no throw)', () => {
    const close = startWorkspaceWatcher('/no/such/path/hopefully', () => { }, 50);
    assert.equal(typeof close, 'function');
    close(); // must not throw
});
